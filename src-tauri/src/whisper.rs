use std::{
    path::{Path, PathBuf},
    process::{Command as StdCommand, ExitStatus},
    sync::{Arc, Mutex},
};

use crate::{
    command_with_augmented_path, ffmpeg::run_command_streaming, progress::ProgressReporter,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpeechSegment {
    pub(crate) absolute_start_ms: u64,
    pub(crate) absolute_end_ms: u64,
    pub(crate) duration_ms: u64,
    detected_language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SilenceEvent {
    Start(u64),
    End(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubtitleCue {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

struct RegisteredCommandOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
    cancelled: bool,
}

const MIXED_LANGUAGE_PADDING_MS: u64 = 200;
const MIXED_LANGUAGE_MAX_SEGMENT_MS: u64 = 8_000;
const MIXED_LANGUAGE_MIN_SEGMENT_MS: u64 = 1_500;
const MIXED_LANGUAGE_SILENCE_DURATION_SECONDS: f64 = 0.35;
const MIXED_LANGUAGE_SILENCE_THRESHOLD: &str = "-35dB";

pub(crate) fn normalized_transcription_language(
    language: Option<String>,
) -> Result<String, String> {
    let normalized = language
        .unwrap_or_else(|| "auto".into())
        .trim()
        .to_lowercase();

    let normalized = if normalized.is_empty() {
        "auto".to_string()
    } else {
        normalized
    };

    match normalized.as_str() {
        "auto" | "zh" | "en" | "de" | "fr" | "es" | "ja" | "ko" => Ok(normalized),
        _ => Err("不支持的转写语言。".into()),
    }
}

pub(crate) fn normalized_transcription_model(model: String) -> Result<String, String> {
    let normalized = model.trim().to_lowercase();
    match normalized.as_str() {
        "base" | "small" | "medium" => Ok(normalized),
        _ => Err("不支持的转写模型。".into()),
    }
}

pub(crate) fn normalized_transcription_output_format(
    output_format: Option<String>,
) -> Result<String, String> {
    let normalized = output_format
        .unwrap_or_else(|| "txt".into())
        .trim()
        .to_lowercase();
    let normalized = if normalized.is_empty() {
        "txt".to_string()
    } else {
        normalized
    };

    match normalized.as_str() {
        "txt" | "srt" | "vtt" => Ok(normalized),
        _ => Err("转写输出格式仅支持 TXT / SRT / VTT。".into()),
    }
}

pub(crate) fn parse_whisper_progress_percent(line: &str) -> Option<f64> {
    line.split_whitespace().find_map(|token| {
        let cleaned = token.trim_matches(|char: char| {
            matches!(char, '[' | ']' | '(' | ')' | ',' | ':' | ';' | '"' | '\'')
        });

        cleaned
            .strip_suffix('%')
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value.clamp(0.0, 100.0))
    })
}

fn emit_whisper_progress_from_line(
    reporter: &ProgressReporter,
    line: &str,
    message: &str,
    progress_range: (f64, f64),
    last_percent: &Arc<Mutex<Option<f64>>>,
) {
    let Some(value) = parse_whisper_progress_percent(line) else {
        return;
    };

    let percent = progress_range.0 + ((progress_range.1 - progress_range.0) * (value / 100.0));
    let mut guard = match last_percent.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    let should_emit = guard
        .map(|previous| (previous - percent).abs() >= 1.0)
        .unwrap_or(true);
    if should_emit {
        reporter.emit(
            "transcribe",
            Some(percent),
            false,
            Some(message),
            None,
            None,
        );
        *guard = Some(percent);
    }
}

pub(crate) fn run_whisper_with_progress(
    reporter: &ProgressReporter,
    whisper_cmd: PathBuf,
    args: Vec<String>,
    message: &str,
    progress_range: (f64, f64),
) -> Result<String, String> {
    let mut command = command_with_augmented_path(whisper_cmd);
    command.args(&args);

    reporter.emit(
        "transcribe",
        Some(progress_range.0),
        true,
        Some(message),
        None,
        None,
    );

    let last_percent = Arc::new(Mutex::new(None::<f64>));
    let reporter_stdout = reporter.clone();
    let reporter_stderr = reporter.clone();
    let message_owned = message.to_string();
    let message_for_stderr = message_owned.clone();
    let last_percent_for_stdout = Arc::clone(&last_percent);
    let last_percent_for_stderr = Arc::clone(&last_percent);

    let output = run_command_streaming(
        command,
        |line| {
            emit_whisper_progress_from_line(
                &reporter_stdout,
                line,
                &message_owned,
                progress_range,
                &last_percent_for_stdout,
            );
        },
        move |line| {
            emit_whisper_progress_from_line(
                &reporter_stderr,
                line,
                &message_for_stderr,
                progress_range,
                &last_percent_for_stderr,
            );
        },
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

pub(crate) fn speech_segment(start_ms: u64, end_ms: u64) -> Option<SpeechSegment> {
    (end_ms > start_ms).then(|| SpeechSegment {
        absolute_start_ms: start_ms,
        absolute_end_ms: end_ms,
        duration_ms: end_ms - start_ms,
        detected_language: None,
    })
}

fn seconds_to_millis(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }

    (seconds * 1000.0).round() as u64
}

fn millis_to_seconds(milliseconds: u64) -> f64 {
    milliseconds as f64 / 1000.0
}

pub(crate) fn build_whisper_args(
    model_path: &Path,
    input_wav: &Path,
    output_flag: &str,
    output_base: &Path,
    language: &str,
    disable_context: bool,
) -> Vec<String> {
    let mut args = vec![
        "-pp".to_string(),
        "-m".to_string(),
        model_path.to_string_lossy().to_string(),
        "-f".into(),
        input_wav.to_string_lossy().to_string(),
    ];

    if disable_context {
        args.extend(["-mc".into(), "0".into()]);
    }

    args.extend([
        output_flag.into(),
        "-of".into(),
        output_base.to_string_lossy().to_string(),
        "-l".into(),
        language.to_string(),
    ]);

    args
}

fn build_whisper_language_detection_args(model_path: &Path, input_wav: &Path) -> Vec<String> {
    vec![
        "-dl".to_string(),
        "-m".to_string(),
        model_path.to_string_lossy().to_string(),
        "-f".into(),
        input_wav.to_string_lossy().to_string(),
        "-l".into(),
        "auto".into(),
    ]
}

fn unique_temp_directory(prefix: &str) -> Result<PathBuf, String> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("无法生成临时目录名: {}", error))?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&path).map_err(|error| format!("无法创建临时目录: {}", error))?;
    Ok(path)
}

fn normalize_text_lines(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn parse_timestamp_ms(value: &str) -> Option<u64> {
    let normalized = value.trim().replace(',', ".");
    let parts = normalized.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds_part) = match parts.as_slice() {
        [hours, minutes, seconds_part] => (*hours, *minutes, *seconds_part),
        [minutes, seconds_part] => ("0", *minutes, *seconds_part),
        _ => return None,
    };

    let (seconds, milliseconds) = seconds_part.split_once('.')?;
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<u64>().ok()?;
    let milliseconds = match milliseconds.len() {
        0 => 0,
        1 => milliseconds.parse::<u64>().ok()? * 100,
        2 => milliseconds.parse::<u64>().ok()? * 10,
        _ => milliseconds[..3].parse::<u64>().ok()?,
    };

    Some((hours * 3_600_000) + (minutes * 60_000) + (seconds * 1_000) + milliseconds)
}

fn format_srt_timestamp(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let seconds = (milliseconds % 60_000) / 1_000;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn format_vtt_timestamp(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let seconds = (milliseconds % 60_000) / 1_000;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{millis:03}")
}

fn parse_timestamp_range(line: &str) -> Option<(u64, u64)> {
    let (start, end) = line.split_once("-->")?;
    let end_token = end.split_whitespace().next()?;
    Some((
        parse_timestamp_ms(start.trim())?,
        parse_timestamp_ms(end_token)?,
    ))
}

fn parse_srt_cues(content: &str) -> Vec<SubtitleCue> {
    let normalized = normalize_text_lines(content);
    let mut cues = Vec::new();

    for block in normalized.split("\n\n") {
        let trimmed = block.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut lines = trimmed.lines();
        let first_line = lines.next().unwrap_or_default().trim();
        let timestamp_line = if first_line.contains("-->") {
            first_line
        } else {
            lines.next().unwrap_or_default().trim()
        };

        let Some((start_ms, end_ms)) = parse_timestamp_range(timestamp_line) else {
            continue;
        };

        let text = lines.collect::<Vec<_>>().join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }

        cues.push(SubtitleCue {
            start_ms,
            end_ms,
            text,
        });
    }

    cues
}

fn parse_vtt_cues(content: &str) -> Vec<SubtitleCue> {
    let normalized = normalize_text_lines(content);
    let normalized = normalized.trim_start_matches('\u{feff}');
    let body = if normalized.trim_start().starts_with("WEBVTT") {
        normalized.lines().skip(1).collect::<Vec<_>>().join("\n")
    } else {
        normalized.to_string()
    };

    let mut cues = Vec::new();
    for block in body.split("\n\n") {
        let trimmed = block.trim();
        if trimmed.is_empty() {
            continue;
        }

        let lines = trimmed.lines().collect::<Vec<_>>();
        let timestamp_index = lines.iter().position(|line| line.contains("-->"));
        let Some(timestamp_index) = timestamp_index else {
            continue;
        };

        let Some((start_ms, end_ms)) = parse_timestamp_range(lines[timestamp_index].trim()) else {
            continue;
        };

        let text = lines[(timestamp_index + 1)..].join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }

        cues.push(SubtitleCue {
            start_ms,
            end_ms,
            text,
        });
    }

    cues
}

fn serialize_srt_cues(cues: &[SubtitleCue]) -> String {
    if cues.is_empty() {
        return String::new();
    }

    let blocks = cues
        .iter()
        .enumerate()
        .map(|(index, cue)| {
            format!(
                "{}\n{} --> {}\n{}",
                index + 1,
                format_srt_timestamp(cue.start_ms),
                format_srt_timestamp(cue.end_ms.max(cue.start_ms)),
                cue.text
            )
        })
        .collect::<Vec<_>>();

    format!("{}\n", blocks.join("\n\n"))
}

fn serialize_vtt_cues(cues: &[SubtitleCue]) -> String {
    if cues.is_empty() {
        return "WEBVTT\n".to_string();
    }

    let blocks = cues
        .iter()
        .map(|cue| {
            format!(
                "{} --> {}\n{}",
                format_vtt_timestamp(cue.start_ms),
                format_vtt_timestamp(cue.end_ms.max(cue.start_ms)),
                cue.text
            )
        })
        .collect::<Vec<_>>();

    format!("WEBVTT\n\n{}\n", blocks.join("\n\n"))
}

fn merge_txt_outputs(outputs: &[(SpeechSegment, PathBuf)]) -> Result<String, String> {
    let mut blocks = Vec::new();

    for (_, path) in outputs {
        let content = std::fs::read_to_string(path)
            .map_err(|error| format!("读取分段转写结果失败: {}", error))?;
        let trimmed = normalize_text_lines(&content).trim().to_string();
        if !trimmed.is_empty() {
            blocks.push(trimmed);
        }
    }

    Ok(if blocks.is_empty() {
        String::new()
    } else {
        format!("{}\n", blocks.join("\n\n"))
    })
}

pub(crate) fn merge_srt_outputs(
    outputs: &[(SpeechSegment, PathBuf)],
    total_duration_ms: u64,
) -> Result<String, String> {
    let mut cues = Vec::new();

    for (segment, path) in outputs {
        let content = std::fs::read_to_string(path)
            .map_err(|error| format!("读取分段字幕结果失败: {}", error))?;
        for cue in parse_srt_cues(&content) {
            let local_start = cue.start_ms.min(segment.duration_ms);
            let local_end = cue.end_ms.min(segment.duration_ms).max(local_start);
            let global_start = (segment.absolute_start_ms + local_start).min(total_duration_ms);
            let global_end = (segment.absolute_start_ms + local_end)
                .min(total_duration_ms)
                .max(global_start);
            cues.push(SubtitleCue {
                start_ms: global_start,
                end_ms: global_end,
                text: cue.text,
            });
        }
    }

    cues.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then(a.end_ms.cmp(&b.end_ms))
            .then(a.text.cmp(&b.text))
    });

    Ok(serialize_srt_cues(&cues))
}

pub(crate) fn merge_vtt_outputs(
    outputs: &[(SpeechSegment, PathBuf)],
    total_duration_ms: u64,
) -> Result<String, String> {
    let mut cues = Vec::new();

    for (segment, path) in outputs {
        let content = std::fs::read_to_string(path)
            .map_err(|error| format!("读取分段字幕结果失败: {}", error))?;
        for cue in parse_vtt_cues(&content) {
            let local_start = cue.start_ms.min(segment.duration_ms);
            let local_end = cue.end_ms.min(segment.duration_ms).max(local_start);
            let global_start = (segment.absolute_start_ms + local_start).min(total_duration_ms);
            let global_end = (segment.absolute_start_ms + local_end)
                .min(total_duration_ms)
                .max(global_start);
            cues.push(SubtitleCue {
                start_ms: global_start,
                end_ms: global_end,
                text: cue.text,
            });
        }
    }

    cues.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then(a.end_ms.cmp(&b.end_ms))
            .then(a.text.cmp(&b.text))
    });

    Ok(serialize_vtt_cues(&cues))
}

fn merge_transcription_chunk_outputs(
    outputs: &[(SpeechSegment, PathBuf)],
    format: &str,
    total_duration_ms: u64,
) -> Result<String, String> {
    match format {
        "srt" => merge_srt_outputs(outputs, total_duration_ms),
        "vtt" => merge_vtt_outputs(outputs, total_duration_ms),
        _ => merge_txt_outputs(outputs),
    }
}

pub(crate) fn normalize_detected_language_label(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '-' && ch != '_')
        .to_ascii_lowercase();

    match normalized.as_str() {
        "zh" | "chinese" | "mandarin" => Some("zh".into()),
        "en" | "english" => Some("en".into()),
        "de" | "german" | "deutsch" => Some("de".into()),
        "fr" | "french" | "francais" | "français" => Some("fr".into()),
        "es" | "spanish" | "espanol" | "español" => Some("es".into()),
        "ja" | "japanese" => Some("ja".into()),
        "ko" | "korean" => Some("ko".into()),
        _ => None,
    }
}

pub(crate) fn parse_detected_language(output: &str) -> Option<String> {
    for line in output.lines() {
        let lowercase = line.to_ascii_lowercase();
        if !lowercase.contains("language") {
            continue;
        }

        for token in lowercase.split(|ch: char| !ch.is_alphanumeric() && ch != '-') {
            if token.is_empty() {
                continue;
            }

            if let Some(language) = normalize_detected_language_label(token) {
                return Some(language);
            }
        }
    }

    None
}

fn display_language_label(language: &str) -> &str {
    match language {
        "zh" => "中文",
        "en" => "English",
        "de" => "Deutsch",
        "fr" => "Français",
        "es" => "Español",
        "ja" => "日本語",
        "ko" => "한국어",
        _ => "自动检测",
    }
}

fn run_registered_command(
    reporter: &ProgressReporter,
    command: StdCommand,
) -> Result<RegisteredCommandOutput, String> {
    let mut stdout_lines = Vec::new();
    let output = run_command_streaming(
        command,
        |line| stdout_lines.push(line.to_string()),
        |_| {},
        Some(reporter.job_registry()),
        reporter.job_id(),
    )?;

    Ok(RegisteredCommandOutput {
        status: output.status,
        stdout: stdout_lines.join("\n"),
        stderr: output.stderr,
        cancelled: output.cancelled,
    })
}

fn run_whisper_language_detection(
    reporter: &ProgressReporter,
    whisper_cmd: &Path,
    model_path: &Path,
    input_wav: &Path,
) -> Result<Option<String>, String> {
    let mut command = command_with_augmented_path(whisper_cmd);
    command.args(build_whisper_language_detection_args(model_path, input_wav));
    let output = run_registered_command(reporter, command)
        .map_err(|error| format!("语言检测命令执行失败: {}", error))?;

    if output.cancelled {
        return Err("任务已取消".into());
    }

    let combined = format!("{}\n{}", output.stdout, output.stderr);
    if !output.status.success() {
        let details = combined.trim();
        return Err(if details.is_empty() {
            "语言检测失败".into()
        } else {
            format!("语言检测失败: {}", details)
        });
    }

    Ok(parse_detected_language(&combined))
}

pub(crate) fn parse_silencedetect_event_line(line: &str) -> Option<SilenceEvent> {
    if let Some((_, value)) = line.split_once("silence_start:") {
        let seconds = value.split_whitespace().next()?.parse::<f64>().ok()?;
        return Some(SilenceEvent::Start(seconds_to_millis(seconds)));
    }

    if let Some((_, value)) = line.split_once("silence_end:") {
        let seconds = value.split_whitespace().next()?.parse::<f64>().ok()?;
        return Some(SilenceEvent::End(seconds_to_millis(seconds)));
    }

    None
}

fn build_speech_segments_from_silence_events(
    events: &[SilenceEvent],
    total_duration_ms: u64,
) -> Vec<SpeechSegment> {
    let mut segments = Vec::new();
    let mut next_speech_start_ms = 0_u64;
    let mut in_silence = false;

    for event in events {
        match *event {
            SilenceEvent::Start(silence_start_ms) => {
                if let Some(segment) = speech_segment(
                    next_speech_start_ms,
                    silence_start_ms.min(total_duration_ms),
                ) {
                    segments.push(segment);
                }
                next_speech_start_ms = silence_start_ms.min(total_duration_ms);
                in_silence = true;
            }
            SilenceEvent::End(silence_end_ms) => {
                next_speech_start_ms = silence_end_ms.min(total_duration_ms);
                in_silence = false;
            }
        }
    }

    if !in_silence {
        if let Some(segment) = speech_segment(next_speech_start_ms, total_duration_ms) {
            segments.push(segment);
        }
    }

    segments
}

fn apply_padding_to_segments(
    segments: Vec<SpeechSegment>,
    total_duration_ms: u64,
    padding_ms: u64,
) -> Vec<SpeechSegment> {
    segments
        .into_iter()
        .filter_map(|segment| {
            speech_segment(
                segment.absolute_start_ms.saturating_sub(padding_ms),
                (segment.absolute_end_ms + padding_ms).min(total_duration_ms),
            )
        })
        .collect()
}

fn merge_overlapping_segments(segments: Vec<SpeechSegment>) -> Vec<SpeechSegment> {
    let mut iter = segments.into_iter();
    let Some(mut current) = iter.next() else {
        return Vec::new();
    };

    let mut merged = Vec::new();
    for segment in iter {
        if segment.absolute_start_ms <= current.absolute_end_ms {
            current.absolute_end_ms = current.absolute_end_ms.max(segment.absolute_end_ms);
            current.duration_ms = current.absolute_end_ms - current.absolute_start_ms;
            continue;
        }

        merged.push(current);
        current = segment;
    }
    merged.push(current);
    merged
}

fn split_long_segments(segments: Vec<SpeechSegment>, max_segment_ms: u64) -> Vec<SpeechSegment> {
    let mut split_segments = Vec::new();

    for segment in segments {
        let mut start_ms = segment.absolute_start_ms;
        while start_ms < segment.absolute_end_ms {
            let end_ms = (start_ms + max_segment_ms).min(segment.absolute_end_ms);
            if let Some(chunk) = speech_segment(start_ms, end_ms) {
                split_segments.push(chunk);
            }
            start_ms = end_ms;
        }
    }

    split_segments
}

fn merge_short_segments(
    segments: Vec<SpeechSegment>,
    min_segment_ms: u64,
    max_segment_ms: u64,
) -> Vec<SpeechSegment> {
    if segments.is_empty() {
        return segments;
    }

    let mut forward_merged = Vec::new();
    let mut index = 0;
    while index < segments.len() {
        let mut current = segments[index].clone();

        while current.duration_ms < min_segment_ms && index + 1 < segments.len() {
            let next = &segments[index + 1];
            if next
                .absolute_end_ms
                .saturating_sub(current.absolute_start_ms)
                > max_segment_ms
            {
                break;
            }

            current.absolute_end_ms = next.absolute_end_ms;
            current.duration_ms = current.absolute_end_ms - current.absolute_start_ms;
            index += 1;
        }

        forward_merged.push(current);
        index += 1;
    }

    let mut collapsed: Vec<SpeechSegment> = Vec::new();
    for segment in forward_merged {
        if let Some(last) = collapsed.last_mut() {
            if segment.duration_ms < min_segment_ms
                && segment
                    .absolute_end_ms
                    .saturating_sub(last.absolute_start_ms)
                    <= max_segment_ms
            {
                last.absolute_end_ms = segment.absolute_end_ms;
                last.duration_ms = last.absolute_end_ms - last.absolute_start_ms;
                continue;
            }
        }

        collapsed.push(segment);
    }

    collapsed
}

pub(crate) fn normalize_speech_segments(
    raw_segments: Vec<SpeechSegment>,
    total_duration_ms: u64,
) -> Vec<SpeechSegment> {
    let padded =
        apply_padding_to_segments(raw_segments, total_duration_ms, MIXED_LANGUAGE_PADDING_MS);
    let merged = merge_overlapping_segments(padded);
    let split = split_long_segments(merged, MIXED_LANGUAGE_MAX_SEGMENT_MS);
    merge_short_segments(
        split,
        MIXED_LANGUAGE_MIN_SEGMENT_MS,
        MIXED_LANGUAGE_MAX_SEGMENT_MS,
    )
}

fn detect_speech_segments(
    reporter: &ProgressReporter,
    ffmpeg: &Path,
    input_wav: &Path,
    total_duration_ms: u64,
) -> Result<Vec<SpeechSegment>, String> {
    if total_duration_ms == 0 {
        return Ok(Vec::new());
    }

    let silence_filter = format!(
        "silencedetect=noise={}:d={}",
        MIXED_LANGUAGE_SILENCE_THRESHOLD, MIXED_LANGUAGE_SILENCE_DURATION_SECONDS
    );
    let mut command = command_with_augmented_path(ffmpeg);
    command.args(vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "info".into(),
        "-nostats".into(),
        "-i".into(),
        input_wav.to_string_lossy().to_string(),
        "-af".into(),
        silence_filter,
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);

    let raw_segments = match run_registered_command(reporter, command) {
        Ok(result) if result.cancelled => return Err("任务已取消".into()),
        Ok(result) if result.status.success() => {
            let events = result
                .stderr
                .lines()
                .filter_map(parse_silencedetect_event_line)
                .collect::<Vec<_>>();
            let derived = build_speech_segments_from_silence_events(&events, total_duration_ms);
            if derived.is_empty() {
                speech_segment(0, total_duration_ms).into_iter().collect()
            } else {
                derived
            }
        }
        _ => speech_segment(0, total_duration_ms).into_iter().collect(),
    };

    Ok(normalize_speech_segments(raw_segments, total_duration_ms))
}

fn extract_segment_audio(
    reporter: &ProgressReporter,
    ffmpeg: &Path,
    input_wav: &Path,
    output_wav: &Path,
    segment: &SpeechSegment,
) -> Result<(), String> {
    let duration_seconds = millis_to_seconds(segment.duration_ms);
    let start_seconds = millis_to_seconds(segment.absolute_start_ms);
    let mut command = command_with_augmented_path(ffmpeg);
    command.args(vec![
        "-y".into(),
        "-ss".into(),
        format!("{start_seconds:.3}"),
        "-t".into(),
        format!("{duration_seconds:.3}"),
        "-i".into(),
        input_wav.to_string_lossy().to_string(),
        "-ar".into(),
        "16000".into(),
        "-ac".into(),
        "1".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        output_wav.to_string_lossy().to_string(),
    ]);
    let output = run_registered_command(reporter, command)
        .map_err(|error| format!("切出音频片段失败: {}", error))?;

    if output.cancelled {
        return Err("任务已取消".into());
    }

    if !output.status.success() {
        let details = output.stderr.trim().to_string();
        return Err(if details.is_empty() {
            "切出音频片段失败".into()
        } else {
            format!("切出音频片段失败: {}", details)
        });
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_mixed_language_transcription(
    reporter: &ProgressReporter,
    ffmpeg: &Path,
    whisper_cmd: &Path,
    model_path: &Path,
    input_wav: &Path,
    output_flag: &str,
    format: &str,
    output_path: &Path,
    total_duration_seconds: f64,
) -> Result<(), String> {
    let total_duration_ms = seconds_to_millis(total_duration_seconds);
    if total_duration_ms == 0 {
        return Err("无法在未知时长的音频上启用混合语种模式。".into());
    }

    reporter.emit(
        "analyze",
        Some(15.0),
        true,
        Some("正在分析语音片段..."),
        Some(0.0),
        Some(total_duration_seconds),
    );

    let segments = detect_speech_segments(reporter, ffmpeg, input_wav, total_duration_ms)?;
    if segments.is_empty() {
        return Err("没有识别出可转写的语音片段。".into());
    }

    reporter.emit(
        "analyze",
        Some(25.0),
        false,
        Some(&format!("已整理出 {} 段候选语音片段。", segments.len())),
        Some(0.0),
        Some(total_duration_seconds),
    );

    let working_directory = unique_temp_directory("forph-whisper-mixed")?;
    let total_segments = segments.len();

    let result = (|| -> Result<(), String> {
        let mut outputs = Vec::with_capacity(total_segments);

        for (index, mut segment) in segments.into_iter().enumerate() {
            let segment_wav = working_directory.join(format!("segment-{index:03}.wav"));
            let output_base = working_directory.join(format!("segment-{index:03}"));
            let output_segment_path = output_base.with_extension(format);
            let segment_progress_start = 25.0 + (67.0 * index as f64 / total_segments as f64);
            let segment_progress_end = 25.0 + (67.0 * (index + 1) as f64 / total_segments as f64);
            let detect_progress_end =
                segment_progress_start + ((segment_progress_end - segment_progress_start) * 0.2);

            extract_segment_audio(reporter, ffmpeg, input_wav, &segment_wav, &segment)?;

            reporter.emit(
                "detect",
                Some(segment_progress_start),
                true,
                Some(&format!(
                    "正在检测第 {}/{} 段语言...",
                    index + 1,
                    total_segments
                )),
                Some(millis_to_seconds(segment.absolute_start_ms)),
                Some(total_duration_seconds),
            );

            let detected_language = match run_whisper_language_detection(
                reporter,
                whisper_cmd,
                model_path,
                &segment_wav,
            ) {
                Ok(language) => language,
                Err(error) if error.contains("任务已取消") => return Err(error),
                Err(_) => None,
            };
            let language_to_use = detected_language
                .as_deref()
                .and_then(normalize_detected_language_label)
                .unwrap_or_else(|| "auto".to_string());
            segment.detected_language = Some(language_to_use.clone());

            reporter.emit(
                "detect",
                Some(detect_progress_end),
                false,
                Some(&format!(
                    "第 {}/{} 段检测到 {}。",
                    index + 1,
                    total_segments,
                    display_language_label(&language_to_use)
                )),
                Some(millis_to_seconds(segment.absolute_start_ms)),
                Some(total_duration_seconds),
            );

            let whisper_args = build_whisper_args(
                model_path,
                &segment_wav,
                output_flag,
                &output_base,
                &language_to_use,
                true,
            );

            run_whisper_with_progress(
                reporter,
                whisper_cmd.to_path_buf(),
                whisper_args,
                &format!(
                    "正在转写第 {}/{} 段（{}）...",
                    index + 1,
                    total_segments,
                    display_language_label(&language_to_use)
                ),
                (detect_progress_end, segment_progress_end),
            )
            .map_err(|details| format!("混合语种转写失败: {}", details))?;

            reporter.emit(
                "transcribe",
                Some(segment_progress_end),
                false,
                Some(&format!(
                    "已完成第 {}/{} 段转写。",
                    index + 1,
                    total_segments
                )),
                Some(millis_to_seconds(
                    segment.absolute_end_ms.min(total_duration_ms),
                )),
                Some(total_duration_seconds),
            );

            outputs.push((segment, output_segment_path));
        }

        reporter.emit(
            "merge",
            Some(92.0),
            true,
            Some("正在合并分段结果..."),
            Some(total_duration_seconds),
            Some(total_duration_seconds),
        );

        let merged_output = merge_transcription_chunk_outputs(&outputs, format, total_duration_ms)?;
        std::fs::write(output_path, merged_output)
            .map_err(|error| format!("写入合并后的转写结果失败: {}", error))?;
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&working_directory);
    result
}
