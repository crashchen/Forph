use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command as StdCommand,
};
use tauri::{AppHandle, Manager};

mod ffmpeg;
mod pdf;
mod progress;
mod validation;
mod whisper;

use ffmpeg::{
    clamp_gif_window, compression_scale_filter, max_long_edge_for_resolution,
    run_ffmpeg_with_progress,
};
#[cfg(test)]
use ffmpeg::{parse_ffmpeg_progress_line, FfmpegProgressUpdate};
use pdf::{build_pdf_markdown_document, extract_pdf_pages_with_pdftotext};
#[cfg(test)]
use pdf::{clean_pdf_page_text, extract_clean_pdf_pages, is_pdf_list_item, normalize_pdf_raw_text};
use progress::{JobRegistry, ProgressReporter};
use validation::{
    commit_temporary_output, discard_temporary_output, file_size, make_output_path_for_input,
    make_temporary_output_path, unique_temp_file_path, validate_existing_local_target,
    validate_input_file_path, validate_open_target_request, ValidatedOpenTarget,
};
use whisper::{
    build_whisper_args, normalized_transcription_language, normalized_transcription_model,
    normalized_transcription_output_format, run_mixed_language_transcription,
    run_whisper_with_progress,
};
#[cfg(test)]
use whisper::{
    merge_srt_outputs, merge_vtt_outputs, normalize_detected_language_label,
    normalize_speech_segments, parse_detected_language, parse_silencedetect_event_line,
    parse_whisper_progress_percent, speech_segment, SilenceEvent,
};

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
    pdftotext_available: bool,
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
pub struct ModelImportResult {
    model_name: String,
    source_path: String,
    target_path: String,
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

pub(crate) fn command_with_augmented_path(program: impl AsRef<std::ffi::OsStr>) -> StdCommand {
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

fn pdftotext_command_path() -> Option<PathBuf> {
    resolve_command_path("pdftotext")
}

fn sips_command_path() -> PathBuf {
    resolve_command_path("sips").unwrap_or_else(|| PathBuf::from("/usr/bin/sips"))
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

fn downloads_dir() -> PathBuf {
    home_dir().join("Downloads")
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

fn find_downloaded_model_candidate_in_dir(dir: &Path, model_name: &str) -> Option<PathBuf> {
    let exact_name = format!("ggml-{}.bin", model_name);
    let prefix = format!("ggml-{}", model_name);

    let entries = std::fs::read_dir(dir).ok()?;

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let file_name = path.file_name()?.to_str()?;
            let is_match = file_name == exact_name
                || (file_name.starts_with(&prefix) && file_name.ends_with(".bin"));
            if !is_match || !path.is_file() {
                return None;
            }

            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());

            Some((modified, path))
        })
        .max_by_key(|(modified, path)| {
            (
                modified.unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                path.file_name()
                    .map(|name| name.to_os_string())
                    .unwrap_or_default(),
            )
        })
        .map(|(_, path)| path)
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
        pdftotext_available: pdftotext_command_path().is_some(),
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
        "pdf" => vec![
            FileAction {
                id: "pdf_txt".into(),
                label: "提取纯文本".into(),
                group: "文档提取".into(),
            },
            FileAction {
                id: "pdf_md".into(),
                label: "导出 Markdown".into(),
                group: "文档提取".into(),
            },
        ],
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
    let escaped_title = escape_html_text(title);
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
        escaped_title,
        markdown_css(),
        html_body
    )
}

fn save_image_with_quality(
    img: &image::DynamicImage,
    path: &Path,
    format: &str,
    quality: Option<u8>,
) -> Result<(), String> {
    match format {
        "jpg" | "jpeg" => {
            let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
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

fn escape_html_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn dependency_is_installed(package_name: &str) -> bool {
    match package_name {
        "ffmpeg" => has_command("ffmpeg"),
        "poppler" => pdftotext_command_path().is_some(),
        "whisper-cpp" => whisper_cpp_command_path().is_some(),
        _ => false,
    }
}

fn dependency_display_name(package_name: &str) -> Option<&'static str> {
    match package_name {
        "ffmpeg" => Some("FFmpeg"),
        "poppler" => Some("Poppler (pdftotext)"),
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
        "pdf" => "pdf",
        _ => "unknown",
    }
    .to_string();

    let actions = build_actions(&ext, &file_type);
    let media = match file_type.as_str() {
        "video" | "audio" => probe_media_info(&path),
        _ => None,
    };
    let runtime = match file_type.as_str() {
        "video" | "audio" | "pdf" => Some(runtime_info(&app)),
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
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let out = make_output_path_for_input(&input, &output_format)?;
    let out_str = out.to_string_lossy().to_string();

    if ext == "heic" || ext == "heif" {
        match output_format.as_str() {
            "jpg" | "jpeg" => {
                let q_str = quality.unwrap_or(85).to_string();
                let r = command_with_augmented_path(sips_command_path())
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
                let r = command_with_augmented_path(sips_command_path())
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
                let tmp_png = unique_temp_file_path("forph-heic", "png");
                let tmp_str = tmp_png.to_string_lossy().to_string();
                let r = command_with_augmented_path(sips_command_path())
                    .args(["-s", "format", "png", &input_path, "--out", &tmp_str])
                    .output()
                    .map_err(|e| format!("sips 调用失败: {}", e))?;
                if !r.status.success() {
                    return Err(format!(
                        "HEIC 转换失败: {}",
                        String::from_utf8_lossy(&r.stderr)
                    ));
                }
                let result = (|| {
                    let img =
                        image::open(&tmp_png).map_err(|e| format!("读取临时 PNG 失败: {}", e))?;
                    save_image_with_quality(&img, &out, "webp", quality)
                })();
                let _ = std::fs::remove_file(&tmp_png);
                result?;
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
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let raw_content =
        std::fs::read_to_string(&input_path).map_err(|e| format!("无法读取文件: {}", e))?;
    let content = strip_frontmatter(&raw_content);

    let title = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Document");

    let html_body = render_markdown(content);
    let full_html = build_markdown_document(title, &html_body);
    let out = make_output_path_for_input(&input, "html")?;
    std::fs::write(&out, &full_html).map_err(|e| format!("写入失败: {}", e))?;

    Ok(ConversionResult {
        output_path: out.to_string_lossy().to_string(),
        output_size: file_size(&out),
        message: "HTML 导出完成".into(),
    })
}

#[tauri::command]
async fn extract_pdf_text(
    input_path: String,
    output_format: String,
) -> Result<ConversionResult, String> {
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let (extension, message) = match output_format.as_str() {
        "txt" => ("txt", "PDF 纯文本提取完成"),
        "md" => ("md", "PDF Markdown 导出完成"),
        _ => return Err("PDF 仅支持导出 TXT 或 Markdown。".into()),
    };

    let Some(pdftotext) = pdftotext_command_path() else {
        return Err("需要安装 Poppler (pdftotext)".into());
    };
    let input_path_for_extract = PathBuf::from(input_path);

    let title = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Document");

    let pages = tauri::async_runtime::spawn_blocking(move || {
        extract_pdf_pages_with_pdftotext(pdftotext, &input_path_for_extract)
    })
    .await
    .map_err(|error| format!("PDF 提取任务执行失败: {}", error))??;

    let output_text = match extension {
        "txt" => pages
            .iter()
            .map(|(_, page)| page.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        "md" => build_pdf_markdown_document(title, &pages),
        _ => unreachable!("PDF output format is validated above"),
    };

    let out = make_output_path_for_input(&input, extension)?;
    std::fs::write(&out, output_text).map_err(|e| format!("写入失败: {}", e))?;

    Ok(ConversionResult {
        output_path: out.to_string_lossy().to_string(),
        output_size: file_size(&out),
        message: message.into(),
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
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("需要安装 FFmpeg".into());
    };

    let media = probe_media_info(&input_path);
    let (start, clip_duration) = clamp_gif_window(
        start_time,
        duration,
        media.as_ref().and_then(|info| info.duration_seconds),
    );

    let out = make_output_path_for_input(&input, "gif")?;
    let out_str = out.to_string_lossy().to_string();
    let temp_out = make_temporary_output_path(&out)?;
    let temp_out_str = temp_out.to_string_lossy().to_string();

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
        temp_out_str,
    ];

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path.clone());
        let result = (|| {
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
            commit_temporary_output(&temp_out, &out)?;

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
        })();
        if result.is_err() {
            discard_temporary_output(&temp_out);
        }
        result
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
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let Some(ffmpeg) = ffmpeg_command_path() else {
        return Err("需要安装 FFmpeg".into());
    };

    let total_duration = probe_media_info(&input_path).and_then(|info| info.duration_seconds);
    let out = make_output_path_for_input(&input, &output_format)?;
    let out_str = out.to_string_lossy().to_string();
    let temp_out = make_temporary_output_path(&out)?;
    let temp_out_str = temp_out.to_string_lossy().to_string();

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
            temp_out_str.clone(),
        ],
        "wav" => vec![
            "-y".into(),
            "-i".into(),
            input_path.clone(),
            "-vn".into(),
            "-acodec".into(),
            "pcm_s16le".into(),
            temp_out_str,
        ],
        _ => return Err(format!("不支持的音频格式: {}", output_format)),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path);
        let result = (|| {
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
            commit_temporary_output(&temp_out, &out)?;

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
        })();
        if result.is_err() {
            discard_temporary_output(&temp_out);
        }
        result
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
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
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

    let out = make_output_path_for_input(&input, "mp4")?;
    let out_str = out.to_string_lossy().to_string();
    let temp_out = make_temporary_output_path(&out)?;
    let temp_out_str = temp_out.to_string_lossy().to_string();

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
            args.extend(["-vf".into(), compression_scale_filter(max_long_edge)]);
        }
    }

    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        temp_out_str,
    ]);

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path);
        let result = (|| {
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
            commit_temporary_output(&temp_out, &out)?;

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
        })();
        if result.is_err() {
            discard_temporary_output(&temp_out);
        }
        result
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
    mixed_language_mode: Option<bool>,
) -> Result<ConversionResult, String> {
    let input = validate_input_file_path(&input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let Some(whisper_cmd) = whisper_cpp_command_path() else {
        return Err("需要安装 whisper-cpp".into());
    };
    let model_size = normalized_transcription_model(model_size)?;
    let language = normalized_transcription_language(language)?;

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
    let tmp_wav = unique_temp_file_path("forph-whisper", "wav");
    let tmp_wav_str = tmp_wav.to_string_lossy().to_string();

    let fmt = normalized_transcription_output_format(output_format)?;
    let (whisper_output_flag, file_ext) = match fmt.as_str() {
        "srt" => ("-osrt", "srt"),
        "vtt" => ("-ovtt", "vtt"),
        "txt" => ("-otxt", "txt"),
        _ => unreachable!("transcription output format is validated above"),
    };

    let out = make_output_path_for_input(&input, file_ext)?;
    let out_str = out.to_string_lossy().to_string();
    let temp_out = make_temporary_output_path(&out)?;
    let temp_out_str = temp_out.to_string_lossy().to_string();
    let temp_of_base = temp_out_str
        .strip_suffix(&format!(".{}", file_ext))
        .unwrap_or(&temp_out_str)
        .to_string();
    let use_mixed_language_mode = mixed_language_mode.unwrap_or(false)
        && language == "auto"
        && total_duration.unwrap_or(0.0) > 0.0;

    tauri::async_runtime::spawn_blocking(move || {
        let reporter = ProgressReporter::new(app, job_id, input_path.clone());
        let transcription = (|| {
            run_ffmpeg_with_progress(
                &reporter,
                ffmpeg.clone(),
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
                if use_mixed_language_mode {
                    (0.0, 15.0)
                } else {
                    (0.0, 25.0)
                },
            )
            .map_err(|_| "音频预处理失败".to_string())?;

            if use_mixed_language_mode {
                run_mixed_language_transcription(
                    &reporter,
                    &ffmpeg,
                    &whisper_cmd,
                    &model_path,
                    &tmp_wav,
                    whisper_output_flag,
                    &fmt,
                    &temp_out,
                    total_duration.unwrap_or_default(),
                )?;
            } else {
                let whisper_args = build_whisper_args(
                    &model_path,
                    &tmp_wav,
                    whisper_output_flag,
                    Path::new(&temp_of_base),
                    &language,
                    false,
                );

                run_whisper_with_progress(
                    &reporter,
                    whisper_cmd,
                    whisper_args,
                    "正在转写音频...",
                    (25.0, 95.0),
                )
                .map_err(|details| format!("转写失败: {}", details))?;
            }

            commit_temporary_output(&temp_out, &out)?;

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
        if transcription.is_err() {
            discard_temporary_output(&temp_out);
        }
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
fn import_downloaded_model(
    app: AppHandle,
    model_name: Option<String>,
) -> Result<ModelImportResult, String> {
    let model_name = model_name
        .unwrap_or_else(|| "base".into())
        .trim()
        .to_string();

    if model_name.is_empty() {
        return Err("模型名称不能为空。".into());
    }

    let downloads = downloads_dir();
    let source_path =
        find_downloaded_model_candidate_in_dir(&downloads, &model_name).ok_or_else(|| {
            format!(
                "没有在下载目录里找到 ggml-{}.bin。请先下载模型，或确认它仍在 {}。",
                model_name,
                downloads.to_string_lossy()
            )
        })?;

    let target_dir = preferred_model_directory(&app);
    std::fs::create_dir_all(&target_dir).map_err(|error| format!("无法创建模型目录: {}", error))?;

    let target_path = target_dir.join(format!("ggml-{}.bin", model_name));
    std::fs::copy(&source_path, &target_path)
        .map_err(|error| format!("复制模型文件失败: {}", error))?;

    Ok(ModelImportResult {
        model_name,
        source_path: source_path.to_string_lossy().to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        message: "已从下载目录导入模型文件。".into(),
    })
}

#[tauri::command]
fn get_drag_icon(app: AppHandle) -> String {
    ensure_drag_icon(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let resolved_path = validate_existing_local_target(&path)?;

    command_with_augmented_path("open")
        .arg("-R")
        .arg(&resolved_path)
        .spawn()
        .map_err(|e| format!("无法打开 Finder: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_target(
    app: AppHandle,
    target: String,
    ensure_directory: Option<bool>,
) -> Result<(), String> {
    let ensure_directory = ensure_directory.unwrap_or(false);
    let validated_target =
        validate_open_target_request(&target, ensure_directory, &preferred_model_directory(&app))?;

    let open_arg = match validated_target {
        ValidatedOpenTarget::Url(url) => url,
        ValidatedOpenTarget::Path(path) => {
            let path_to_open = if ensure_directory {
                std::fs::create_dir_all(&path).map_err(|e| format!("无法创建目录: {}", e))?;
                path.canonicalize()
                    .map_err(|e| format!("无法解析路径: {}", e))?
            } else {
                path
            };
            path_to_open.to_string_lossy().to_string()
        }
    };

    command_with_augmented_path("open")
        .arg(&open_arg)
        .spawn()
        .map_err(|e| format!("无法打开目标: {}", e))?;
    Ok(())
}

#[tauri::command]
fn cancel_job(app: AppHandle, job_id: String) -> Result<(), String> {
    let registry = app.state::<JobRegistry>();
    if registry.cancel(&job_id)? {
        Ok(())
    } else {
        Err("当前任务已经结束或不存在。".into())
    }
}

// ─── App Setup ───────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobRegistry::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            get_file_info,
            convert_image,
            export_markdown,
            extract_pdf_text,
            video_to_gif,
            compress_video,
            extract_audio,
            transcribe_audio,
            install_dependency,
            import_downloaded_model,
            get_drag_icon,
            reveal_in_finder,
            open_target,
            cancel_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forph");
}

#[cfg(test)]
mod tests {
    use super::{
        build_markdown_document, build_pdf_markdown_document, clamp_gif_window,
        clean_pdf_page_text, commit_temporary_output, compression_scale_filter, escape_html_text,
        extract_clean_pdf_pages, extract_pdf_pages_with_pdftotext,
        find_downloaded_model_candidate_in_dir, is_pdf_list_item, make_output_path_for_input,
        make_temporary_output_path, max_long_edge_for_resolution, merge_srt_outputs,
        merge_vtt_outputs, normalize_detected_language_label, normalize_pdf_raw_text,
        normalize_speech_segments, normalized_transcription_language,
        normalized_transcription_model, normalized_transcription_output_format,
        parse_detected_language, parse_ffmpeg_progress_line, parse_silencedetect_event_line,
        parse_whisper_progress_percent, pdftotext_command_path, speech_segment, strip_frontmatter,
        validate_existing_local_target, validate_input_file_path, validate_open_target_request,
        FfmpegProgressUpdate, SilenceEvent, ValidatedOpenTarget,
    };
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_test_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("forph-{label}-{}-{unique}", std::process::id()))
    }

    fn write_minimal_pdf(path: &Path, page_stream: &str, include_font: bool) {
        fn push_object(bytes: &mut Vec<u8>, offsets: &mut Vec<usize>, id: usize, body: &str) {
            offsets.push(bytes.len());
            write!(bytes, "{id} 0 obj\n{body}\nendobj\n").expect("write pdf object");
        }

        let resources = if include_font {
            "<< /Font << /F1 4 0 R >> >>"
        } else {
            "<< >>"
        };
        let contents = format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            page_stream.len(),
            page_stream
        );

        let mut bytes = Vec::new();
        let mut offsets = Vec::new();
        bytes.extend_from_slice(b"%PDF-1.4\n");
        push_object(
            &mut bytes,
            &mut offsets,
            1,
            "<< /Type /Catalog /Pages 2 0 R >>",
        );
        push_object(
            &mut bytes,
            &mut offsets,
            2,
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        );
        push_object(
            &mut bytes,
            &mut offsets,
            3,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources {resources} /Contents 5 0 R >>"
            ),
        );
        push_object(
            &mut bytes,
            &mut offsets,
            4,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        );
        push_object(&mut bytes, &mut offsets, 5, &contents);

        let xref_start = bytes.len();
        write!(
            bytes,
            "xref\n0 {}\n0000000000 65535 f \n",
            offsets.len() + 1
        )
        .expect("write xref header");
        for offset in offsets {
            write!(bytes, "{offset:010} 00000 n \n").expect("write xref entry");
        }
        write!(
            bytes,
            "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n"
        )
        .expect("write trailer");

        fs::write(path, bytes).expect("write pdf fixture");
    }

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
    fn validates_absolute_existing_input_files() {
        let temp_file = temp_test_path("input-file");
        fs::write(&temp_file, b"demo").expect("write input");

        assert_eq!(
            validate_input_file_path(temp_file.to_string_lossy().as_ref()),
            Ok(temp_file.canonicalize().expect("canonicalize input"))
        );

        let _ = fs::remove_file(temp_file);
    }

    #[test]
    fn rejects_relative_input_paths() {
        assert!(validate_input_file_path("relative.pdf").is_err());
    }

    #[test]
    fn builds_non_conflicting_output_paths() {
        let temp_dir = temp_test_path("output-dir");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let input = temp_dir.join("demo.pdf");
        let first = temp_dir.join("demo.txt");
        fs::write(&input, b"pdf").expect("write input");
        fs::write(&first, b"existing").expect("write first output");

        assert_eq!(
            make_output_path_for_input(&input, "txt").expect("output path"),
            temp_dir.join("demo_1.txt")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn builds_temporary_output_next_to_final_path() {
        let temp_dir = temp_test_path("temp-output-dir");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let final_path = temp_dir.join("movie.mp4");

        let temp_path = make_temporary_output_path(&final_path).expect("temp output path");

        assert_eq!(temp_path.parent(), Some(temp_dir.as_path()));
        assert_eq!(
            temp_path.extension().and_then(|value| value.to_str()),
            Some("mp4")
        );
        assert!(temp_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .starts_with(".movie.forph-"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn commits_temporary_output_to_final_path() {
        let temp_dir = temp_test_path("commit-output-dir");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let final_path = temp_dir.join("audio.mp3");
        let temp_path = make_temporary_output_path(&final_path).expect("temp output path");
        fs::write(&temp_path, b"finished").expect("write temp output");

        commit_temporary_output(&temp_path, &final_path).expect("commit temp output");

        assert!(!temp_path.exists());
        assert_eq!(
            fs::read(&final_path).expect("read final output"),
            b"finished"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn normalizes_pdf_raw_text_to_unix_newlines() {
        let raw = "A\r\nB\rC\u{0007}\u{000C}D\tE";
        assert_eq!(normalize_pdf_raw_text(raw), "A\nB\nC\u{000C}D\tE");
    }

    #[test]
    fn preserves_pdf_list_lines_while_joining_prose() {
        let page = "First line\nsecond line\n\n- item one\n- item two\n\nTail\nline";
        assert_eq!(
            clean_pdf_page_text(page),
            "First line second line\n\n- item one\n- item two\n\nTail line"
        );
    }

    #[test]
    fn recognizes_numbered_pdf_list_items() {
        assert!(is_pdf_list_item("1. First"));
        assert!(is_pdf_list_item("12) Second"));
        assert!(!is_pdf_list_item("2024 report"));
    }

    #[test]
    fn extracts_clean_pdf_pages_and_skips_empty_ones() {
        let raw = "Page one line 1\nline 2\u{000C}\n\n\u{000C}Page three";
        assert_eq!(
            extract_clean_pdf_pages(raw),
            vec![
                (1, "Page one line 1 line 2".into()),
                (3, "Page three".into())
            ]
        );
    }

    #[test]
    fn builds_pdf_markdown_with_page_headings() {
        let document = build_pdf_markdown_document(
            "Demo",
            &[(1, "First page".into()), (3, "Third page".into())],
        );
        assert_eq!(
            document,
            "# Demo\n\n## Page 1\n\nFirst page\n\n## Page 3\n\nThird page\n"
        );
    }

    #[test]
    fn extracts_text_from_real_pdf_fixture() {
        let Some(pdftotext) = pdftotext_command_path() else {
            eprintln!("skipping real PDF fixture test because pdftotext is not installed");
            return;
        };

        let temp_dir = temp_test_path("pdf-text-fixture");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let pdf = temp_dir.join("text.pdf");
        write_minimal_pdf(&pdf, "BT /F1 18 Tf 72 720 Td (Hello Forph PDF) Tj ET", true);

        let pages = extract_pdf_pages_with_pdftotext(pdftotext, &pdf).expect("extract pdf text");
        assert_eq!(pages, vec![(1, "Hello Forph PDF".into())]);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn reports_no_text_layer_for_real_pdf_without_text() {
        let Some(pdftotext) = pdftotext_command_path() else {
            eprintln!("skipping real PDF fixture test because pdftotext is not installed");
            return;
        };

        let temp_dir = temp_test_path("pdf-image-fixture");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let pdf = temp_dir.join("no-text.pdf");
        write_minimal_pdf(&pdf, "0.8 g 72 600 200 120 re f", false);

        let error =
            extract_pdf_pages_with_pdftotext(pdftotext, &pdf).expect_err("expected no text layer");
        assert!(error.contains("没有可提取文本层"));

        let _ = fs::remove_dir_all(temp_dir);
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
        assert_eq!(
            parse_whisper_progress_percent("progress: 87.5%"),
            Some(87.5)
        );
        assert_eq!(parse_whisper_progress_percent("no-progress-here"), None);
    }

    #[test]
    fn escapes_html_text_for_markdown_title() {
        assert_eq!(
            escape_html_text(r#"<script>&"'demo"#),
            "&lt;script&gt;&amp;&quot;&#39;demo"
        );
    }

    #[test]
    fn escapes_markdown_document_title_without_touching_body() {
        let document = build_markdown_document(r#"<script>"'&"#, "<h1>Body</h1>");
        assert!(document.contains("<title>&lt;script&gt;&quot;&#39;&amp;</title>"));
        assert!(document.contains("<h1>Body</h1>"));
    }

    #[test]
    fn allows_brew_download_url() {
        assert_eq!(
            validate_open_target_request("https://brew.sh", false, Path::new("/tmp/models")),
            Ok(ValidatedOpenTarget::Url("https://brew.sh".into()))
        );
    }

    #[test]
    fn allows_huggingface_download_url() {
        let url =
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true";
        assert_eq!(
            validate_open_target_request(url, false, Path::new("/tmp/models")),
            Ok(ValidatedOpenTarget::Url(url.into()))
        );
    }

    #[test]
    fn rejects_non_whitelisted_urls() {
        let error = validate_open_target_request(
            "https://example.com/file.bin",
            false,
            Path::new("/tmp/models"),
        )
        .expect_err("unexpectedly accepted untrusted url");
        assert!(error.contains("受信任"));
    }

    #[test]
    fn rejects_relative_paths_for_open_targets() {
        let error = validate_open_target_request("relative/path", false, Path::new("/tmp/models"))
            .expect_err("unexpectedly accepted relative path");
        assert!(error.contains("绝对路径"));
    }

    #[test]
    fn rejects_missing_local_paths() {
        let missing_path = temp_test_path("missing");
        let error = validate_existing_local_target(missing_path.to_string_lossy().as_ref())
            .expect_err("unexpectedly accepted missing path");
        assert!(error.contains("已存在"));
    }

    #[test]
    fn ensure_directory_only_allows_preferred_model_directory() {
        let temp_root = temp_test_path("models-root");
        let allowed = temp_root.join("models");
        let other = temp_root.join("somewhere-else");

        let allowed_result =
            validate_open_target_request(allowed.to_string_lossy().as_ref(), true, &allowed)
                .expect("expected model directory to be allowed");
        assert_eq!(allowed_result, ValidatedOpenTarget::Path(allowed.clone()));

        let error = validate_open_target_request(other.to_string_lossy().as_ref(), true, &allowed)
            .expect_err("unexpectedly accepted non-model directory");
        assert!(error.contains("模型目录"));
    }

    #[test]
    fn finds_downloaded_model_candidate_in_downloads() {
        let downloads = temp_test_path("downloads");
        fs::create_dir_all(&downloads).expect("create downloads dir");

        let target = downloads.join("ggml-base.bin");
        fs::write(&target, b"model").expect("write model");

        assert_eq!(
            find_downloaded_model_candidate_in_dir(&downloads, "base"),
            Some(target)
        );
    }

    #[test]
    fn prefers_newest_matching_downloaded_model_candidate() {
        let downloads = temp_test_path("downloads-latest");
        fs::create_dir_all(&downloads).expect("create downloads dir");

        let older = downloads.join("ggml-base.bin");
        let newer = downloads.join("ggml-base (1).bin");
        fs::write(&older, b"old").expect("write older model");
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(&newer, b"new").expect("write newer model");

        assert_eq!(
            find_downloaded_model_candidate_in_dir(&downloads, "base"),
            Some(newer)
        );
    }

    #[test]
    fn defaults_transcription_language_to_auto() {
        assert_eq!(
            normalized_transcription_language(None).expect("language should default"),
            "auto"
        );
        assert_eq!(
            normalized_transcription_language(Some("".into())).expect("empty should normalize"),
            "auto"
        );
    }

    #[test]
    fn accepts_supported_transcription_languages() {
        assert_eq!(
            normalized_transcription_language(Some("DE".into())).expect("de should normalize"),
            "de"
        );
        assert_eq!(
            normalized_transcription_language(Some("zh".into())).expect("zh should normalize"),
            "zh"
        );
    }

    #[test]
    fn rejects_unknown_transcription_languages() {
        let error = normalized_transcription_language(Some("it".into()))
            .expect_err("unexpectedly accepted unsupported language");
        assert!(error.contains("不支持"));
    }

    #[test]
    fn accepts_supported_transcription_models() {
        assert_eq!(
            normalized_transcription_model("SMALL".into()).expect("small should normalize"),
            "small"
        );
        assert!(normalized_transcription_model("large".into()).is_err());
    }

    #[test]
    fn validates_transcription_output_formats() {
        assert_eq!(
            normalized_transcription_output_format(None).expect("default output"),
            "txt"
        );
        assert_eq!(
            normalized_transcription_output_format(Some("VTT".into())).expect("vtt output"),
            "vtt"
        );
        assert!(normalized_transcription_output_format(Some("docx".into())).is_err());
    }

    #[test]
    fn parses_silencedetect_log_lines() {
        assert_eq!(
            parse_silencedetect_event_line("[silencedetect @ 0x0] silence_start: 1.234"),
            Some(SilenceEvent::Start(1234))
        );
        assert_eq!(
            parse_silencedetect_event_line(
                "[silencedetect @ 0x0] silence_end: 2.468 | silence_duration: 1.234"
            ),
            Some(SilenceEvent::End(2468))
        );
    }

    #[test]
    fn normalizes_segments_with_padding_split_and_short_merge() {
        let raw_segments = vec![
            speech_segment(1_000, 1_200).expect("segment"),
            speech_segment(1_600, 1_900).expect("segment"),
            speech_segment(2_100, 2_400).expect("segment"),
            speech_segment(5_000, 14_500).expect("segment"),
        ];

        let normalized = normalize_speech_segments(raw_segments, 15_000);
        assert_eq!(
            normalized,
            vec![
                speech_segment(800, 2600).expect("merged short segments"),
                speech_segment(4_800, 12_800).expect("split long segment 1"),
                speech_segment(12_800, 14_700).expect("split long segment 2"),
            ]
        );
    }

    #[test]
    fn parses_detected_language_from_whisper_output() {
        assert_eq!(
            parse_detected_language("main: auto-detected language: de (p = 0.93)"),
            Some("de".into())
        );
        assert_eq!(
            parse_detected_language("auto-detected language: Chinese"),
            Some("zh".into())
        );
        assert_eq!(
            normalize_detected_language_label("Deutsch"),
            Some("de".into())
        );
        assert_eq!(normalize_detected_language_label("unknown"), None);
    }

    #[test]
    fn merges_srt_chunks_using_absolute_offsets() {
        let temp_dir = temp_test_path("srt-merge");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let first = temp_dir.join("chunk-000.srt");
        let second = temp_dir.join("chunk-001.srt");

        fs::write(
            &first,
            "1\n00:00:00,000 --> 00:00:02,000\nHallo\n\n2\n00:00:02,000 --> 00:00:03,000\nWelt\n",
        )
        .expect("write first srt chunk");
        fs::write(&second, "1\n00:00:00,500 --> 00:00:01,500\n你好\n")
            .expect("write second srt chunk");

        let merged = merge_srt_outputs(
            &[
                (speech_segment(0, 3_000).expect("segment 1"), first),
                (speech_segment(20_000, 23_000).expect("segment 2"), second),
            ],
            30_000,
        )
        .expect("merge srt");
        assert!(merged.contains("1\n00:00:00,000 --> 00:00:02,000\nHallo"));
        assert!(merged.contains("2\n00:00:02,000 --> 00:00:03,000\nWelt"));
        assert!(merged.contains("3\n00:00:20,500 --> 00:00:21,500\n你好"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn merges_vtt_chunks_with_single_header_and_absolute_offsets() {
        let temp_dir = temp_test_path("vtt-merge");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let first = temp_dir.join("chunk-000.vtt");
        let second = temp_dir.join("chunk-001.vtt");

        fs::write(&first, "WEBVTT\n\n00:00.000 --> 00:02.000\nHallo\n")
            .expect("write first vtt chunk");
        fs::write(&second, "WEBVTT\n\n00:00.750 --> 00:02.250\n你好\n")
            .expect("write second vtt chunk");

        let merged = merge_vtt_outputs(
            &[
                (speech_segment(0, 3_000).expect("segment 1"), first),
                (speech_segment(20_000, 23_000).expect("segment 2"), second),
            ],
            30_000,
        )
        .expect("merge vtt");
        assert_eq!(merged.matches("WEBVTT").count(), 1);
        assert!(merged.contains("00:00:00.000 --> 00:00:02.000\nHallo"));
        assert!(merged.contains("00:00:20.750 --> 00:00:22.250\n你好"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn preserves_absolute_offsets_for_late_srt_segments() {
        let temp_dir = temp_test_path("srt-late-merge");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let late = temp_dir.join("chunk-late.srt");
        fs::write(&late, "1\n00:00:00,250 --> 00:00:01,250\nSpat\n").expect("write late srt chunk");

        let merged = merge_srt_outputs(
            &[(
                speech_segment(570_000, 572_000).expect("late segment"),
                late,
            )],
            600_000,
        )
        .expect("merge late srt");

        assert!(merged.contains("1\n00:09:30,250 --> 00:09:31,250\nSpat"));

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
