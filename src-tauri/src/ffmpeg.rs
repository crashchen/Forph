use std::{
    io::{self, Read},
    path::PathBuf,
    process::{Child, Command as StdCommand, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use crate::{
    command_with_augmented_path,
    progress::{JobRegistration, JobRegistry, ProgressReporter},
};

#[derive(Debug, PartialEq)]
pub(crate) enum FfmpegProgressUpdate {
    OutTimeSeconds(f64),
    End,
}

pub(crate) struct StreamCommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stderr: String,
    pub(crate) cancelled: bool,
}

pub(crate) fn clamp_gif_window(
    start_time: Option<f64>,
    duration: Option<f64>,
    total_duration: Option<f64>,
) -> (f64, f64) {
    let mut start = start_time.unwrap_or(0.0).max(0.0);
    let mut clip_duration = duration.unwrap_or(5.0).clamp(1.0, 10.0);

    if let Some(total) = total_duration.filter(|value| *value > 0.0) {
        let max_start = (total - 0.5).max(0.0);
        start = start.min(max_start);
        let remaining = (total - start).max(0.2);
        clip_duration = clip_duration.min(remaining);
    }

    (start, clip_duration)
}

pub(crate) fn max_long_edge_for_resolution(value: &str) -> Option<u32> {
    match value {
        "1080p" => Some(1080),
        "720p" => Some(720),
        "480p" => Some(480),
        _ => None,
    }
}

pub(crate) fn compression_scale_filter(max_long_edge: u32) -> String {
    format!(
        "scale='if(gt(iw,ih),min({0},iw),-2)':'if(gt(iw,ih),-2,min({0},ih))'",
        max_long_edge
    )
}

pub(crate) fn parse_ffmpeg_progress_line(line: &str) -> Option<FfmpegProgressUpdate> {
    let (key, value) = line.split_once('=')?;
    match key.trim() {
        "out_time_us" | "out_time_ms" => {
            value.trim().parse::<f64>().ok().map(|microseconds| {
                FfmpegProgressUpdate::OutTimeSeconds(microseconds / 1_000_000.0)
            })
        }
        "progress" if value.trim() == "end" => Some(FfmpegProgressUpdate::End),
        _ => None,
    }
}

fn consume_stream_lines<R: Read>(mut reader: R, mut on_line: impl FnMut(&str)) -> io::Result<()> {
    let mut buffer = [0_u8; 4096];
    let mut pending = Vec::new();

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        for byte in &buffer[..bytes_read] {
            if *byte == b'\n' || *byte == b'\r' {
                if !pending.is_empty() {
                    let line = String::from_utf8_lossy(&pending).trim().to_string();
                    if !line.is_empty() {
                        on_line(&line);
                    }
                    pending.clear();
                }
            } else {
                pending.push(*byte);
            }
        }
    }

    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).trim().to_string();
        if !line.is_empty() {
            on_line(&line);
        }
    }

    Ok(())
}

fn wait_for_child(child: &Arc<Mutex<Child>>) -> Result<ExitStatus, String> {
    loop {
        let status = {
            let mut child = child
                .lock()
                .map_err(|_| "等待命令结束失败: 任务句柄不可用".to_string())?;
            child
                .try_wait()
                .map_err(|error| format!("等待命令结束失败: {}", error))?
        };

        if let Some(status) = status {
            return Ok(status);
        }

        thread::sleep(Duration::from_millis(25));
    }
}

pub(crate) fn run_command_streaming(
    mut command: StdCommand,
    mut on_stdout_line: impl FnMut(&str),
    mut on_stderr_line: impl FnMut(&str) + Send + 'static,
    registry: Option<JobRegistry>,
    job_id: Option<String>,
) -> Result<StreamCommandOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("命令启动失败: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取命令标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取命令错误输出".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let registration = JobRegistration::new(registry, job_id, Arc::clone(&child));

    let stderr_handle = thread::spawn(move || -> Result<String, String> {
        let mut lines = Vec::new();
        consume_stream_lines(stderr, |line| {
            lines.push(line.to_string());
            on_stderr_line(line);
        })
        .map_err(|error| format!("读取命令错误输出失败: {}", error))?;
        Ok(lines.join("\n"))
    });

    let stdout_result = consume_stream_lines(stdout, |line| {
        on_stdout_line(line);
    });
    let status = wait_for_child(&child)?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "读取命令错误输出失败: 线程中断".to_string())??;
    let cancelled = registration.was_cancelled();

    if cancelled {
        return Ok(StreamCommandOutput {
            status,
            stderr,
            cancelled,
        });
    }

    if let Err(error) = stdout_result {
        return Err(format!("读取命令输出失败: {}", error));
    }

    Ok(StreamCommandOutput {
        status,
        stderr,
        cancelled,
    })
}

pub(crate) fn run_ffmpeg_with_progress(
    reporter: &ProgressReporter,
    ffmpeg: PathBuf,
    mut args: Vec<String>,
    stage: &str,
    message: &str,
    total_duration: Option<f64>,
    progress_range: (f64, f64),
) -> Result<String, String> {
    let mut command = command_with_augmented_path(ffmpeg);
    let mut full_args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-nostats".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ];
    full_args.append(&mut args);
    command.args(&full_args);

    let total_duration = total_duration.filter(|value| *value > 0.0);
    reporter.emit(
        stage,
        total_duration.map(|_| progress_range.0),
        total_duration.is_none(),
        Some(message),
        Some(0.0),
        total_duration,
    );

    let mut last_percent: Option<f64> = None;
    let output = run_command_streaming(
        command,
        |line| match parse_ffmpeg_progress_line(line) {
            Some(FfmpegProgressUpdate::OutTimeSeconds(current_seconds)) => {
                let Some(total_seconds) = total_duration else {
                    return;
                };

                let fraction = (current_seconds / total_seconds).clamp(0.0, 1.0);
                let percent = progress_range.0 + ((progress_range.1 - progress_range.0) * fraction);

                let should_emit = last_percent
                    .map(|previous| (previous - percent).abs() >= 0.5)
                    .unwrap_or(true);
                if should_emit {
                    reporter.emit(
                        stage,
                        Some(percent),
                        false,
                        Some(message),
                        Some(current_seconds.min(total_seconds)),
                        Some(total_seconds),
                    );
                    last_percent = Some(percent);
                }
            }
            Some(FfmpegProgressUpdate::End) if total_duration.is_some() => {
                reporter.emit(
                    stage,
                    Some(progress_range.1),
                    false,
                    Some(message),
                    total_duration,
                    total_duration,
                );
                last_percent = Some(progress_range.1);
            }
            Some(FfmpegProgressUpdate::End) | None => {}
        },
        |_| {},
        Some(reporter.job_registry()),
        reporter.job_id(),
    )?;

    if output.cancelled {
        return Err("任务已取消".into());
    }

    if !output.status.success() {
        let details = output.stderr.trim();
        return Err(if details.is_empty() {
            "命令执行失败".into()
        } else {
            details.to_string()
        });
    }

    Ok(output.stderr)
}
