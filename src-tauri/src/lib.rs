use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command as StdCommand, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager};

// ─── Types ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct FileInfo {
    name: String,
    path: String,
    extension: String,
    size: u64,
    file_type: String,
    actions: Vec<FileAction>,
    media: Option<MediaInfo>,
    runtime: Option<RuntimeInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileAction {
    id: String,
    label: String,
    group: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MediaInfo {
    duration_seconds: Option<f64>,
    video_width: Option<u32>,
    video_height: Option<u32>,
    has_audio: bool,
    audio_sample_rate_hz: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RuntimeInfo {
    brew_available: bool,
    ffmpeg_available: bool,
    ffprobe_available: bool,
    whisper_available: bool,
    available_models: Vec<String>,
    model_directory: Option<String>,
    legacy_model_directories: Vec<String>,
    base_model_available: bool,
    base_model_path: Option<String>,
    using_legacy_model_directory: bool,
}

#[derive(Serialize, Deserialize)]
pub struct DependencyInstallResult {
    package_name: String,
    message: String,
}

#[derive(Serialize, Deserialize)]
pub struct ConversionResult {
    output_path: String,
    output_size: u64,
    message: String,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<String>,
    sample_rate: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

struct ModelLookup {
    current_directory: PathBuf,
    legacy_directories: Vec<PathBuf>,
    available_models: Vec<String>,
    requested_model_path: Option<PathBuf>,
    requested_model_uses_legacy_directory: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgressEvent {
    job_id: String,
    file_path: String,
    stage: String,
    percent: Option<f64>,
    indeterminate: bool,
    message: Option<String>,
    current_seconds: Option<f64>,
    total_seconds: Option<f64>,
}

#[derive(Debug, PartialEq)]
enum FfmpegProgressUpdate {
    OutTimeSeconds(f64),
    End,
}

struct StreamCommandOutput {
    status: ExitStatus,
    stderr: String,
}

#[derive(Clone)]
struct ProgressReporter {
    app: AppHandle,
    job_id: Option<String>,
    file_path: String,
}

impl ProgressReporter {
    fn new(app: AppHandle, job_id: Option<String>, file_path: String) -> Self {
        Self {
            app,
            job_id,
            file_path,
        }
    }

    fn emit(
        &self,
        stage: &str,
        percent: Option<f64>,
        indeterminate: bool,
        message: Option<&str>,
        current_seconds: Option<f64>,
        total_seconds: Option<f64>,
    ) {
        let Some(job_id) = self.job_id.clone() else {
            return;
        };

        let event = ConversionProgressEvent {
            job_id,
            file_path: self.file_path.clone(),
            stage: stage.to_string(),
            percent: percent.map(|value| (value.clamp(0.0, 100.0) * 10.0).round() / 10.0),
            indeterminate,
            message: message.map(ToOwned::to_owned),
            current_seconds,
            total_seconds,
        };

        let _ = self.app.emit("forph://conversion-progress", event);
    }
}

// ─── Helpers ─────────────────────────────────────────────

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|existing| existing == &candidate) {
        paths.push(candidate);
    }
}

fn command_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    push_unique_path(&mut paths, PathBuf::from("/opt/homebrew/bin"));
    push_unique_path(&mut paths, PathBuf::from("/usr/local/bin"));

    if let Some(existing_path) = env::var_os("PATH") {
        for entry in env::split_paths(&existing_path) {
            push_unique_path(&mut paths, entry);
        }
    }

    paths
}

fn augmented_path() -> Option<OsString> {
    env::join_paths(command_search_paths()).ok()
}

fn command_with_augmented_path(program: impl AsRef<std::ffi::OsStr>) -> StdCommand {
    let mut command = StdCommand::new(program);
    if let Some(path) = augmented_path() {
        command.env("PATH", path);
    }
    command
}

fn resolve_command_path(cmd: &str) -> Option<PathBuf> {
    let cmd_path = PathBuf::from(cmd);
    if cmd_path.is_absolute() && cmd_path.exists() {
        return Some(cmd_path);
    }

    if cmd.contains('/') {
        return cmd_path.exists().then_some(cmd_path);
    }

    command_search_paths()
        .into_iter()
        .map(|directory| directory.join(cmd))
        .find(|path| path.exists())
}

fn has_command(cmd: &str) -> bool {
    resolve_command_path(cmd).is_some()
}

fn brew_command_path() -> Option<PathBuf> {
    resolve_command_path("brew")
}

fn ffmpeg_command_path() -> Option<PathBuf> {
    resolve_command_path("ffmpeg")
}

fn ffprobe_command_path() -> Option<PathBuf> {
    resolve_command_path("ffprobe")
}

fn whisper_cpp_command_path() -> Option<PathBuf> {
    ["whisper-cli", "whisper-cpp"]
        .into_iter()
        .find_map(resolve_command_path)
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/Users/Shared"))
}

fn application_support_dir() -> PathBuf {
    home_dir().join("Library/Application Support")
}

fn preferred_model_directory(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| application_support_dir().join(app.config().identifier.clone()))
        .join("models")
}

fn legacy_model_directory_candidates() -> Vec<PathBuf> {
    vec![
        application_support_dir().join("Forph/models"),
        application_support_dir().join("com.forph.app/models"),
    ]
}

fn homebrew_model_directory_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/share/whisper-cpp/models"),
        PathBuf::from("/usr/local/share/whisper-cpp/models"),
    ]
}

fn parse_model_name(file_name: &str) -> Option<String> {
    file_name
        .strip_prefix("ggml-")
        .and_then(|name| name.strip_suffix(".bin"))
        .map(ToOwned::to_owned)
}

fn available_models_in_directory(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| parse_model_name(&name))
        .collect()
}

fn inspect_models(app: &AppHandle, requested_model: &str) -> ModelLookup {
    let current_directory = preferred_model_directory(app);
    let legacy_directories = legacy_model_directory_candidates()
        .into_iter()
        .filter(|dir| dir.exists())
        .collect::<Vec<_>>();
    let homebrew_directories = homebrew_model_directory_candidates()
        .into_iter()
        .filter(|dir| dir.exists())
        .collect::<Vec<_>>();

    let mut available_models = BTreeSet::new();
    for dir in std::iter::once(current_directory.clone())
        .chain(legacy_directories.iter().cloned())
        .chain(homebrew_directories.iter().cloned())
        .filter(|dir| dir.exists())
    {
        for model in available_models_in_directory(&dir) {
            available_models.insert(model);
        }
    }

    let requested_model_file = format!("ggml-{}.bin", requested_model);
    let search_directories = std::iter::once(current_directory.clone())
        .chain(legacy_model_directory_candidates())
        .chain(homebrew_model_directory_candidates());

    let requested_model_path = search_directories
        .map(|dir| dir.join(&requested_model_file))
        .find(|path| path.exists());

    let requested_model_uses_legacy_directory = requested_model_path
        .as_ref()
        .map(|path| legacy_directories.iter().any(|dir| path.starts_with(dir)))
        .unwrap_or(false);

    ModelLookup {
        current_directory,
        legacy_directories,
        available_models: available_models.into_iter().collect(),
        requested_model_path,
        requested_model_uses_legacy_directory,
    }
}

fn runtime_info(app: &AppHandle) -> RuntimeInfo {
    let lookup = inspect_models(app, "base");

    RuntimeInfo {
        brew_available: brew_command_path().is_some(),
        ffmpeg_available: ffmpeg_command_path().is_some(),
        ffprobe_available: ffprobe_command_path().is_some(),
        whisper_available: whisper_cpp_command_path().is_some(),
        available_models: lookup.available_models,
        model_directory: Some(lookup.current_directory.to_string_lossy().to_string()),
        legacy_model_directories: lookup
            .legacy_directories
            .iter()
            .map(|dir| dir.to_string_lossy().to_string())
            .collect(),
        base_model_available: lookup.requested_model_path.is_some(),
        base_model_path: lookup
            .requested_model_path
            .map(|path| path.to_string_lossy().to_string()),
        using_legacy_model_directory: lookup.requested_model_uses_legacy_directory,
    }
}

fn parse_optional_f64(value: Option<&str>) -> Option<f64> {
    value.and_then(|v| v.parse::<f64>().ok())
}

fn parse_optional_u32(value: Option<&str>) -> Option<u32> {
    value.and_then(|v| v.parse::<u32>().ok())
}

fn round_duration(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn probe_media_info(path: &str) -> Option<MediaInfo> {
    let ffprobe = ffprobe_command_path()?;

    let output = command_with_augmented_path(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let probe: FfprobeOutput = serde_json::from_slice(&output.stdout).ok()?;
    let video_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));

    let duration_seconds = probe
        .format
        .as_ref()
        .and_then(|format| parse_optional_f64(format.duration.as_deref()))
        .or_else(|| video_stream.and_then(|stream| parse_optional_f64(stream.duration.as_deref())))
        .or_else(|| audio_stream.and_then(|stream| parse_optional_f64(stream.duration.as_deref())))
        .map(round_duration);

    if duration_seconds.is_none() && video_stream.is_none() && audio_stream.is_none() {
        return None;
    }

    Some(MediaInfo {
        duration_seconds,
        video_width: video_stream.and_then(|stream| stream.width),
        video_height: video_stream.and_then(|stream| stream.height),
        has_audio: audio_stream.is_some(),
        audio_sample_rate_hz: audio_stream
            .and_then(|stream| parse_optional_u32(stream.sample_rate.as_deref())),
    })
}

fn make_output_path(input: &str, new_ext: &str) -> PathBuf {
    let p = Path::new(input);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let parent = p.parent().unwrap_or(Path::new("."));

    let candidate = parent.join(format!("{}.{}", stem, new_ext));
    if !candidate.exists() {
        return candidate;
    }

    for i in 1..1000 {
        let path = parent.join(format!("{}_{}.{}", stem, i, new_ext));
        if !path.exists() {
            return path;
        }
    }
    candidate
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn build_actions(ext: &str, file_type: &str) -> Vec<FileAction> {
    match file_type {
        "image" => {
            let mut actions = vec![];
            let all = [("jpg", "JPG"), ("png", "PNG"), ("webp", "WebP")];
            actions.extend(
                all.iter()
                    .filter(|(f, _)| *f != ext && !(ext == "jpeg" && *f == "jpg"))
                    .map(|(f, l)| FileAction {
                        id: format!("img_{}", f),
                        label: format!("转为 {}", l),
                        group: "图片转换".into(),
                    }),
            );
            actions
        }
        "markdown" => vec![FileAction {
            id: "md_html".into(),
            label: "导出 HTML".into(),
            group: "文档导出".into(),
        }],
        "video" => vec![
            FileAction {
                id: "vid_gif".into(),
                label: "转为 GIF".into(),
                group: "视频处理".into(),
            },
            FileAction {
                id: "vid_compress".into(),
                label: "压缩视频".into(),
                group: "视频处理".into(),
            },
            FileAction {
                id: "vid_mp3".into(),
                label: "提取音频 (MP3)".into(),
                group: "音频处理".into(),
            },
            FileAction {
                id: "vid_wav".into(),
                label: "提取音频 (WAV)".into(),
                group: "音频处理".into(),
            },
            FileAction {
                id: "vid_transcribe".into(),
                label: "转写文字".into(),
                group: "AI 转写".into(),
            },
            FileAction {
                id: "vid_transcribe_srt".into(),
                label: "转写字幕 (SRT)".into(),
                group: "AI 转写".into(),
            },
            FileAction {
                id: "vid_transcribe_vtt".into(),
                label: "转写字幕 (VTT)".into(),
                group: "AI 转写".into(),
            },
        ],
        "audio" => vec![
            FileAction {
                id: "aud_mp3".into(),
                label: "转为 MP3".into(),
                group: "音频转换".into(),
            },
            FileAction {
                id: "aud_wav".into(),
                label: "转为 WAV".into(),
                group: "音频转换".into(),
            },
            FileAction {
                id: "aud_transcribe".into(),
                label: "转写文字".into(),
                group: "AI 转写".into(),
            },
            FileAction {
                id: "aud_transcribe_srt".into(),
                label: "转写字幕 (SRT)".into(),
                group: "AI 转写".into(),
            },
            FileAction {
                id: "aud_transcribe_vtt".into(),
                label: "转写字幕 (VTT)".into(),
                group: "AI 转写".into(),
            },
        ],
        _ => vec![],
    }
}

fn markdown_css() -> &'static str {
    r#"
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
        line-height: 1.7; max-width: 820px; margin: 0 auto; padding: 48px 32px;
        color: #1f2937; background: #fff;
    }
    h1 { font-size: 2em; margin: 1em 0 0.5em; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; margin: 1.2em 0 0.4em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25em; }
    h3 { font-size: 1.25em; margin: 1em 0 0.3em; }
    p { margin: 0.6em 0; }
    ul, ol { margin: 0.6em 0; padding-left: 2em; }
    li { margin: 0.2em 0; }
    code {
        background: #f3f4f6; padding: 0.15em 0.4em; border-radius: 4px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.88em;
    }
    pre {
        background: #1e293b; color: #e2e8f0; padding: 18px 20px; border-radius: 8px;
        overflow-x: auto; margin: 1em 0; line-height: 1.5;
    }
    pre code { background: transparent; padding: 0; color: inherit; font-size: 0.9em; }
    blockquote {
        border-left: 4px solid #3b82f6; margin: 1em 0; padding: 0.5em 1em;
        color: #6b7280; background: #f0f7ff; border-radius: 0 6px 6px 0;
    }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 14px; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    img { max-width: 100%; border-radius: 6px; margin: 0.5em 0; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr { border: none; border-top: 2px solid #e5e7eb; margin: 2em 0; }
    @media print {
        body { padding: 20px; font-size: 11pt; }
        pre { white-space: pre-wrap; word-break: break-all; }
        a { color: #3b82f6; }
    }
    "#
}

fn render_markdown(content: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(content, opts);
    let mut html_out = String::new();
    html::push_html(&mut html_out, parser);
    html_out
}

fn opening_frontmatter_end(content: &str) -> Option<usize> {
    if !content.starts_with("---") {
        return None;
    }

    let bytes = content.as_bytes();
    match bytes.get(3) {
        Some(b'\n') => Some(4),
        Some(b'\r') if bytes.get(4) == Some(&b'\n') => Some(5),
        _ => None,
    }
}

fn is_frontmatter_delimiter(line: &str) -> bool {
    line.strip_suffix('\r').unwrap_or(line) == "---"
}

fn strip_frontmatter(content: &str) -> &str {
    let Some(mut cursor) = opening_frontmatter_end(content) else {
        return content;
    };

    while cursor <= content.len() {
        let line_end = content[cursor..]
            .find('\n')
            .map(|offset| cursor + offset)
            .unwrap_or(content.len());
        let line = &content[cursor..line_end];

        if is_frontmatter_delimiter(line) {
            if line_end == content.len() {
                return "";
            }
            return &content[line_end + 1..];
        }

        if line_end == content.len() {
            break;
        }
        cursor = line_end + 1;
    }

    content
}

fn build_markdown_document(title: &str, html_body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{}</title>
<style>{}</style>
</head>
<body>
<article class="markdown-body">
{}
</article>
</body>
</html>"#,
        title,
        markdown_css(),
        html_body
    )
}

fn clamp_gif_window(
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

fn save_image_with_quality(
    img: &image::DynamicImage,
    path: &Path,
    format: &str,
    quality: Option<u8>,
) -> Result<(), String> {
    match format {
        "jpg" | "jpeg" => {
            let file =
                std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut writer = std::io::BufWriter::new(file);
            let q = quality.unwrap_or(85);
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, q);
            img.write_with_encoder(encoder)
                .map_err(|e| format!("保存 JPEG 失败: {}", e))?;
        }
        "png" => {
            img.save_with_format(path, image::ImageFormat::Png)
                .map_err(|e| format!("保存 PNG 失败: {}", e))?;
        }
        "webp" => {
            img.save_with_format(path, image::ImageFormat::WebP)
                .map_err(|e| format!("保存 WebP 失败: {}", e))?;
        }
        _ => return Err(format!("不支持的输出格式: {}", format)),
    }
    Ok(())
}

fn is_probably_url(target: &str) -> bool {
    target.starts_with("http://") || target.starts_with("https://")
}

fn dependency_is_installed(package_name: &str) -> bool {
    match package_name {
        "ffmpeg" => has_command("ffmpeg"),
        "whisper-cpp" => whisper_cpp_command_path().is_some(),
        _ => false,
    }
}

fn dependency_display_name(package_name: &str) -> Option<&'static str> {
    match package_name {
        "ffmpeg" => Some("FFmpeg"),
        "whisper-cpp" => Some("whisper-cpp"),
        _ => None,
    }
}

fn ensure_drag_icon(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let icon_path = dir.join("drag_icon.png");
    if icon_path.exists() {
        return icon_path;
    }
    let _ = std::fs::create_dir_all(&dir);
    let img = image::RgbaImage::from_pixel(64, 64, image::Rgba([99, 102, 241, 180]));
    let _ = img.save(&icon_path);
    icon_path
}

fn max_long_edge_for_resolution(value: &str) -> Option<u32> {
    match value {
        "1080p" => Some(1080),
        "720p" => Some(720),
        "480p" => Some(480),
        _ => None,
    }
}

fn compression_scale_filter(max_long_edge: u32) -> String {
    format!(
        "scale='if(gt(iw,ih),min({0},iw),-2)':'if(gt(iw,ih),-2,min({0},ih))'",
        max_long_edge
    )
}

fn parse_ffmpeg_progress_line(line: &str) -> Option<FfmpegProgressUpdate> {
    let (key, value) = line.split_once('=')?;
    match key.trim() {
        "out_time_us" | "out_time_ms" => value
            .trim()
            .parse::<f64>()
            .ok()
            .map(|microseconds| FfmpegProgressUpdate::OutTimeSeconds(microseconds / 1_000_000.0)),
        "progress" if value.trim() == "end" => Some(FfmpegProgressUpdate::End),
        _ => None,
    }
}

fn parse_whisper_progress_percent(line: &str) -> Option<f64> {
    line.split_whitespace().find_map(|token| {
        let cleaned = token.trim_matches(|char: char| {
            matches!(
                char,
                '[' | ']' | '(' | ')' | ',' | ':' | ';' | '"' | '\''
            )
        });

        cleaned
            .strip_suffix('%')
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value.clamp(0.0, 100.0))
    })
}

fn consume_stream_lines<R: Read>(
    mut reader: R,
    mut on_line: impl FnMut(&str),
) -> io::Result<()> {
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

fn run_command_streaming(
    mut command: StdCommand,
    mut on_stdout_line: impl FnMut(&str),
    mut on_stderr_line: impl FnMut(&str) + Send + 'static,
) -> Result<StreamCommandOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("命令启动失败: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取命令标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取命令错误输出".to_string())?;

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
    let status = child
        .wait()
        .map_err(|e| format!("等待命令结束失败: {}", e))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "读取命令错误输出失败: 线程中断".to_string())??;

    if let Err(error) = stdout_result {
        return Err(format!("读取命令输出失败: {}", error));
    }

    Ok(StreamCommandOutput { status, stderr })
}

fn run_ffmpeg_with_progress(
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
    let output = run_command_streaming(command, |line| match parse_ffmpeg_progress_line(line) {
        Some(FfmpegProgressUpdate::OutTimeSeconds(current_seconds)) => {
            let Some(total_seconds) = total_duration else {
                return;
            };

            let fraction = (current_seconds / total_seconds).clamp(0.0, 1.0);
            let percent =
                progress_range.0 + ((progress_range.1 - progress_range.0) * fraction);

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
        Some(FfmpegProgressUpdate::End) => {
            if total_duration.is_some() {
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
        }
        None => {}
    }, |_| {})?;

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

fn run_whisper_with_progress(
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
    )?;

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

// ─── Commands ────────────────────────────────────────────

#[tauri::command]
fn get_file_info(app: AppHandle, path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取文件: {}", e))?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_type = match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif" | "bmp" | "tiff" | "tif" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" => "video",
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "flac" | "wma" => "audio",
        "md" | "markdown" | "mdown" => "markdown",
        _ => "unknown",
    }
    .to_string();

    let actions = build_actions(&ext, &file_type);
    let media = match file_type.as_str() {
        "video" | "audio" => probe_media_info(&path),
        _ => None,
    };
    let runtime = match file_type.as_str() {
        "video" | "audio" => Some(runtime_info(&app)),
        _ => None,
    };

    Ok(FileInfo {
        name,
        path,
        extension: ext,
        size: metadata.len(),
        file_type,
        actions,
        media,
        runtime,
    })
}

#[tauri::command]
async fn convert_image(
    input_path: String,
    output_format: String,
    quality: Option<u8>,
) -> Result<ConversionResult, String> {
    let ext = Path::new(&input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let out = make_output_path(&input_path, &output_format);
    let out_str = out.to_string_lossy().to_string();

    if ext == "heic" || ext == "heif" {
        match output_format.as_str() {
            "jpg" | "jpeg" => {
                let q_str = quality.unwrap_or(85).to_string();
                let r = StdCommand::new("sips")
                    .args([
                        "-s",
                        "format",
                        "jpeg",
                        "-s",
                        "formatOptions",
                        &q_str,
                        &input_path,
                        "--out",
                        &out_str,
                    ])
                    .output()
                    .map_err(|e| format!("sips 调用失败: {}", e))?;
                if !r.status.success() {
                    return Err(format!(
                        "HEIC 转换失败: {}",
                        String::from_utf8_lossy(&r.stderr)
                    ));
                }
            }
            "png" => {
                let r = StdCommand::new("sips")
                    .args(["-s", "format", "png", &input_path, "--out", &out_str])
                    .output()
                    .map_err(|e| format!("sips 调用失败: {}", e))?;
                if !r.status.success() {
                    return Err(format!(
                        "HEIC 转换失败: {}",
                        String::from_utf8_lossy(&r.stderr)
                    ));
                }
            }
            "webp" => {
                let tmp_png = make_output_path(&input_path, "tmp.png");
                let tmp_str = tmp_png.to_string_lossy().to_string();
                let r = StdCommand::new("sips")
                    .args(["-s", "format", "png", &input_path, "--out", &tmp_str])
                    .output()
                    .map_err(|e| format!("sips 调用失败: {}", e))?;
                if !r.status.success() {
                    return Err(format!(
                        "HEIC 转换失败: {}",
                        String::from_utf8_lossy(&r.stderr)
                    ));
                }
                let img =
                    image::open(&tmp_png).map_err(|e| format!("读取临时 PNG 失败: {}", e))?;
                save_image_with_quality(&img, &out, "webp", quality)?;
                let _ = std::fs::remove_file(&tmp_png);
            }
            _ => return Err(format!("不支持的输出格式: {}", output_format)),
        }
    } else {
        let img = image::open(&input_path).map_err(|e| format!("无法读取图片: {}", e))?;
        save_image_with_quality(&img, &out, &output_format, quality)?;
    }

    Ok(ConversionResult {
        output_path: out_str,
        output_size: file_size(&out),
        message: "转换完成".into(),
    })
}

#[tauri::command]
async fn export_markdown(input_path: String) -> Result<ConversionResult, String> {
    let raw_content =
        std::fs::read_to_string(&input_path).map_err(|e| format!("无法读取文件: {}", e))?;
    let content = strip_frontmatter(&raw_content);

    let title = Path::new(&input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Document");

    let html_body = render_markdown(content);
    let full_html = build_markdown_document(title, &html_body);
    let out = make_output_path(&input_path, "html");
    std::fs::write(&out, &full_html).map_err(|e| format!("写入失败: {}", e))?;

    Ok(ConversionResult {
        output_path: out.to_string_lossy().to_string(),
        output_size: file_size(&out),
        message: "HTML 导出完成".into(),
    })
}

#[tauri::command]
async fn video_to_gif(
    app: AppHandle,
    input_path: String,
    fps: u32,
    width: i32,
    start_time: Option<f64>,
    duration: Option<f64>,
    job_id: Option<String>,
) -> Result<ConversionResult, String> {
    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("需要安装 FFmpeg".into());
    };

    let media = probe_media_info(&input_path);
    let (start, clip_duration) = clamp_gif_window(
        start_time,
        duration,
        media.as_ref().and_then(|info| info.duration_seconds),
    );

    let out = make_output_path(&input_path, "gif");
    let out_str = out.to_string_lossy().to_string();

    let scale_filter = if width > 0 {
        format!("fps={},scale={}:-1:flags=lanczos", fps, width)
    } else {
        format!("fps={}", fps)
    };

    let args = vec![
        "-y".into(),
        "-ss".into(),
        format!("{:.2}", start),
        "-t".into(),
        format!("{:.2}", clip_duration),
        "-i".into(),
        input_path.clone(),
        "-vf".into(),
        scale_filter,
        "-loop".into(),
        "0".into(),
        out_str.clone(),
    ];

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path.clone());
        run_ffmpeg_with_progress(
            &reporter,
            ffmpeg,
            args,
            "convert",
            "正在转换 GIF...",
            Some(clip_duration),
            (0.0, 100.0),
        )
        .map_err(|details| format!("GIF 转换失败: {}", details))?;

        reporter.emit(
            "convert",
            Some(100.0),
            false,
            Some("GIF 转换完成"),
            Some(clip_duration),
            Some(clip_duration),
        );

        Ok(ConversionResult {
            output_path: out_str,
            output_size: file_size(&out),
            message: format!(
                "GIF 转换完成（{:.1}s - {:.1}s）",
                start,
                start + clip_duration
            ),
        })
    })
    .await
    .map_err(|error| format!("GIF 任务执行失败: {}", error))?
}

#[tauri::command]
async fn extract_audio(
    app: AppHandle,
    input_path: String,
    output_format: String,
    job_id: Option<String>,
) -> Result<ConversionResult, String> {
    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("需要安装 FFmpeg".into());
    };

    let total_duration = probe_media_info(&input_path).and_then(|info| info.duration_seconds);
    let out = make_output_path(&input_path, &output_format);
    let out_str = out.to_string_lossy().to_string();

    let args: Vec<String> = match output_format.as_str() {
        "mp3" => vec![
            "-y".into(),
            "-i".into(),
            input_path.clone(),
            "-vn".into(),
            "-acodec".into(),
            "libmp3lame".into(),
            "-q:a".into(),
            "2".into(),
            out_str.clone(),
        ],
        "wav" => vec![
            "-y".into(),
            "-i".into(),
            input_path.clone(),
            "-vn".into(),
            "-acodec".into(),
            "pcm_s16le".into(),
            out_str.clone(),
        ],
        _ => return Err(format!("不支持的音频格式: {}", output_format)),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path);
        run_ffmpeg_with_progress(
            &reporter,
            ffmpeg,
            args,
            "extract",
            "正在提取音频...",
            total_duration,
            (0.0, 100.0),
        )
        .map_err(|details| format!("音频提取失败: {}", details))?;

        reporter.emit(
            "extract",
            Some(100.0),
            false,
            Some("音频提取完成"),
            total_duration,
            total_duration,
        );

        Ok(ConversionResult {
            output_path: out_str,
            output_size: file_size(&out),
            message: "音频提取完成".into(),
        })
    })
    .await
    .map_err(|error| format!("音频提取任务执行失败: {}", error))?
}

#[tauri::command]
async fn compress_video(
    app: AppHandle,
    input_path: String,
    quality: String,
    max_resolution: Option<String>,
    job_id: Option<String>,
) -> Result<ConversionResult, String> {
    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("需要安装 FFmpeg".into());
    };

    let total_duration = probe_media_info(&input_path).and_then(|info| info.duration_seconds);
    let crf = match quality.as_str() {
        "high" => "18",
        "small" => "28",
        "tiny" => "35",
        _ => "23",
    };

    let out = make_output_path(&input_path, "mp4");
    let out_str = out.to_string_lossy().to_string();

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        crf.into(),
        "-preset".into(),
        "medium".into(),
    ];

    if let Some(ref res) = max_resolution {
        if let Some(max_long_edge) = max_long_edge_for_resolution(res) {
            args.extend([
                "-vf".into(),
                compression_scale_filter(max_long_edge),
            ]);
        }
    }

    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        out_str.clone(),
    ]);

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path);
        run_ffmpeg_with_progress(
            &reporter,
            ffmpeg,
            args,
            "compress",
            "正在压缩视频...",
            total_duration,
            (0.0, 100.0),
        )
        .map_err(|details| format!("视频压缩失败: {}", details))?;

        reporter.emit(
            "compress",
            Some(100.0),
            false,
            Some("视频压缩完成"),
            total_duration,
            total_duration,
        );

        Ok(ConversionResult {
            output_path: out_str,
            output_size: file_size(&out),
            message: "视频压缩完成".into(),
        })
    })
    .await
    .map_err(|error| format!("视频压缩任务执行失败: {}", error))?
}

#[tauri::command]
async fn transcribe_audio(
    app: AppHandle,
    input_path: String,
    model_size: String,
    language: Option<String>,
    output_format: Option<String>,
    job_id: Option<String>,
) -> Result<ConversionResult, String> {
    let Some(whisper_cmd) = whisper_cpp_command_path() else {
        return Err("需要安装 whisper-cpp".into());
    };

    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("转写前需要 FFmpeg 预处理音频".into());
    };

    let model_lookup = inspect_models(&app, &model_size);
    let Some(model_path) = model_lookup.requested_model_path else {
        return Err(format!(
            "未找到 Whisper 模型 ({})。请下载对应的 ggml-{}.bin，并放到 {}。",
            model_size,
            model_size,
            model_lookup.current_directory.to_string_lossy()
        ));
    };

    let total_duration = probe_media_info(&input_path).and_then(|info| info.duration_seconds);
    let tmp_wav = make_output_path(&input_path, "tmp_whisper.wav");
    let tmp_wav_str = tmp_wav.to_string_lossy().to_string();

    let fmt = output_format.unwrap_or_else(|| "txt".to_string());
    let (whisper_output_flag, file_ext) = match fmt.as_str() {
        "srt" => ("-osrt", "srt"),
        "vtt" => ("-ovtt", "vtt"),
        _ => ("-otxt", "txt"),
    };

    let out = make_output_path(&input_path, file_ext);
    let out_str = out.to_string_lossy().to_string();
    let of_base = out_str
        .strip_suffix(&format!(".{}", file_ext))
        .unwrap_or(&out_str)
        .to_string();

    let mut whisper_args = vec![
        "-pp".to_string(),
        "-m".to_string(),
        model_path.to_string_lossy().to_string(),
        "-f".into(),
        tmp_wav_str.clone(),
        whisper_output_flag.into(),
        "-of".into(),
        of_base,
    ];

    if let Some(lang) = language {
        whisper_args.extend(["-l".into(), lang]);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path.clone());
        let transcription = (|| {
            run_ffmpeg_with_progress(
                &reporter,
                ffmpeg,
                vec![
                    "-y".into(),
                    "-i".into(),
                    input_path.clone(),
                    "-ar".into(),
                    "16000".into(),
                    "-ac".into(),
                    "1".into(),
                    "-c:a".into(),
                    "pcm_s16le".into(),
                    tmp_wav_str.clone(),
                ],
                "preprocess",
                "正在预处理音频...",
                total_duration,
                (0.0, 25.0),
            )
            .map_err(|_| "音频预处理失败".to_string())?;

            run_whisper_with_progress(
                &reporter,
                whisper_cmd,
                whisper_args,
                "正在转写音频...",
                (25.0, 95.0),
            )
            .map_err(|details| format!("转写失败: {}", details))?;

            reporter.emit(
                "finalize",
                Some(100.0),
                false,
                Some("转写完成"),
                total_duration,
                total_duration,
            );

            Ok(ConversionResult {
                output_path: out_str,
                output_size: file_size(&out),
                message: match fmt.as_str() {
                    "srt" => "字幕转写完成 (SRT)",
                    "vtt" => "字幕转写完成 (VTT)",
                    _ => "转写完成",
                }
                .into(),
            })
        })();

        let _ = std::fs::remove_file(&tmp_wav);
        transcription
    })
    .await
    .map_err(|error| format!("转写任务执行失败: {}", error))?
}

#[tauri::command]
async fn install_dependency(package_name: String) -> Result<DependencyInstallResult, String> {
    let Some(display_name) = dependency_display_name(&package_name) else {
        return Err(format!("暂不支持自动安装依赖：{}", package_name));
    };

    let Some(brew) = brew_command_path() else {
        return Err("未检测到 Homebrew。请先安装 Homebrew，再回来一键安装依赖。".into());
    };

    if dependency_is_installed(&package_name) {
        return Ok(DependencyInstallResult {
            package_name,
            message: format!("{} 已经可用了。", display_name),
        });
    }

    let package_name_for_install = package_name.clone();
    let install_output = tauri::async_runtime::spawn_blocking(move || {
        command_with_augmented_path(brew)
            .args(["install", package_name_for_install.as_str()])
            .output()
    })
    .await
    .map_err(|error| format!("安装任务执行失败: {}", error))?
    .map_err(|error| format!("brew 调用失败: {}", error))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr)
            .trim()
            .to_string();
        let stdout = String::from_utf8_lossy(&install_output.stdout)
            .trim()
            .to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "brew 没有返回更多细节。".into()
        };

        return Err(format!("自动安装 {} 失败：{}", display_name, details));
    }

    if !dependency_is_installed(&package_name) {
        return Err(format!(
            "{} 安装过程已结束，但当前仍未检测到命令。可以稍后重试一次，或在终端运行 brew install {}。",
            display_name, package_name
        ));
    }

    Ok(DependencyInstallResult {
        package_name,
        message: format!("{} 安装完成，已准备好重新检测。", display_name),
    })
}

#[tauri::command]
fn get_drag_icon(app: AppHandle) -> String {
    ensure_drag_icon(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    StdCommand::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| format!("无法打开 Finder: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_target(target: String, ensure_directory: Option<bool>) -> Result<(), String> {
    if ensure_directory.unwrap_or(false) && !is_probably_url(&target) {
        std::fs::create_dir_all(&target).map_err(|e| format!("无法创建目录: {}", e))?;
    }

    StdCommand::new("open")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("无法打开目标: {}", e))?;
    Ok(())
}

// ─── App Setup ───────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            get_file_info,
            convert_image,
            export_markdown,
            video_to_gif,
            compress_video,
            extract_audio,
            transcribe_audio,
            install_dependency,
            get_drag_icon,
            reveal_in_finder,
            open_target,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forph");
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_gif_window, compression_scale_filter, max_long_edge_for_resolution,
        parse_ffmpeg_progress_line, parse_whisper_progress_percent, strip_frontmatter,
        FfmpegProgressUpdate,
    };

    #[test]
    fn keeps_markdown_without_frontmatter() {
        let content = "# Title\n\n---\n\nBody";
        assert_eq!(strip_frontmatter(content), content);
    }

    #[test]
    fn strips_standard_frontmatter_block() {
        let content = "---\ntitle: Demo\ntags:\n  - note\n---\n# Title\n";
        assert_eq!(strip_frontmatter(content), "# Title\n");
    }

    #[test]
    fn keeps_body_separator_lines() {
        let content = "# Title\n\nSection A\n---\nSection B\n";
        assert_eq!(strip_frontmatter(content), content);
    }

    #[test]
    fn keeps_leading_blank_lines() {
        let content = "\n---\ntitle: Demo\n---\n# Title\n";
        assert_eq!(strip_frontmatter(content), content);
    }

    #[test]
    fn keeps_unclosed_frontmatter() {
        let content = "---\ntitle: Demo\n# Title\n";
        assert_eq!(strip_frontmatter(content), content);
    }

    #[test]
    fn keeps_yaml_values_that_contain_delimiters() {
        let content = "---\ntitle: a --- b\nsummary: still yaml\n---\n# Title\n";
        assert_eq!(strip_frontmatter(content), "# Title\n");
    }

    #[test]
    fn clamps_gif_window_into_video_bounds() {
        let (start, duration) = clamp_gif_window(Some(10.0), Some(8.0), Some(12.0));
        assert_eq!(start, 10.0);
        assert_eq!(duration, 2.0);
    }

    #[test]
    fn defaults_gif_duration_to_five_seconds() {
        let (start, duration) = clamp_gif_window(None, None, Some(20.0));
        assert_eq!(start, 0.0);
        assert_eq!(duration, 5.0);
    }

    #[test]
    fn maps_resolution_presets_to_long_edge_caps() {
        assert_eq!(max_long_edge_for_resolution("1080p"), Some(1080));
        assert_eq!(max_long_edge_for_resolution("720p"), Some(720));
        assert_eq!(max_long_edge_for_resolution("480p"), Some(480));
        assert_eq!(max_long_edge_for_resolution("unknown"), None);
    }

    #[test]
    fn builds_portrait_safe_compression_scale_filter() {
        assert_eq!(
            compression_scale_filter(1080),
            "scale='if(gt(iw,ih),min(1080,iw),-2)':'if(gt(iw,ih),-2,min(1080,ih))'"
        );
    }

    #[test]
    fn parses_ffmpeg_out_time_progress_lines() {
        assert_eq!(
            parse_ffmpeg_progress_line("out_time_us=1000000"),
            Some(FfmpegProgressUpdate::OutTimeSeconds(1.0))
        );
        assert_eq!(
            parse_ffmpeg_progress_line("out_time_ms=2500000"),
            Some(FfmpegProgressUpdate::OutTimeSeconds(2.5))
        );
    }

    #[test]
    fn ignores_invalid_ffmpeg_progress_lines() {
        assert_eq!(parse_ffmpeg_progress_line("out_time_us=oops"), None);
        assert_eq!(parse_ffmpeg_progress_line("bitrate=400kbits/s"), None);
        assert_eq!(
            parse_ffmpeg_progress_line("progress=end"),
            Some(FfmpegProgressUpdate::End)
        );
    }

    #[test]
    fn parses_whisper_progress_from_wrapped_tokens() {
        assert_eq!(parse_whisper_progress_percent("[42%]"), Some(42.0));
        assert_eq!(parse_whisper_progress_percent("progress: 87.5%"), Some(87.5));
        assert_eq!(parse_whisper_progress_percent("no-progress-here"), None);
    }
}
