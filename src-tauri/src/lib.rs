use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

// ─── Types ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct FileInfo {
    name: String,
    path: String,
    extension: String,
    size: u64,
    file_type: String,
    actions: Vec<FileAction>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileAction {
    id: String,
    label: String,
    group: String,
}

#[derive(Serialize, Deserialize)]
pub struct ConversionResult {
    output_path: String,
    output_size: u64,
    message: String,
}

// ─── Helpers ─────────────────────────────────────────────

fn has_command(cmd: &str) -> bool {
    StdCommand::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn make_output_path(input: &str, new_ext: &str) -> PathBuf {
    let p = Path::new(input);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let parent = p.parent().unwrap_or(Path::new("."));

    let candidate = parent.join(format!("{}.{}", stem, new_ext));
    if !candidate.exists() {
        return candidate;
    }
    // Avoid overwriting: append _1, _2, etc.
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
                id: "vid_mp3".into(),
                label: "提取音频 (MP3)".into(),
                group: "音频处理".into(),
            },
            FileAction {
                id: "vid_transcribe".into(),
                label: "转写文字".into(),
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

/// Strip YAML frontmatter only when the file begins with a standalone `---` block.
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

// ─── Commands ────────────────────────────────────────────

#[tauri::command]
fn get_file_info(path: String) -> Result<FileInfo, String> {
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

    Ok(FileInfo {
        name,
        path,
        extension: ext,
        size: metadata.len(),
        file_type,
        actions,
    })
}

#[tauri::command]
async fn convert_image(
    input_path: String,
    output_format: String,
) -> Result<ConversionResult, String> {
    let ext = Path::new(&input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let out = make_output_path(&input_path, &output_format);
    let out_str = out.to_string_lossy().to_string();

    if ext == "heic" || ext == "heif" {
        // Use macOS native sips for HEIC
        let sips_fmt = match output_format.as_str() {
            "jpg" | "jpeg" => "jpeg",
            "png" => "png",
            "webp" => {
                // sips can't do webp, convert to png first then use image crate
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
                let img = image::open(&tmp_png).map_err(|e| format!("读取临时 PNG 失败: {}", e))?;
                img.save_with_format(&out, image::ImageFormat::WebP)
                    .map_err(|e| format!("保存 WebP 失败: {}", e))?;
                let _ = std::fs::remove_file(&tmp_png);
                return Ok(ConversionResult {
                    output_path: out_str,
                    output_size: file_size(&out),
                    message: "转换完成".into(),
                });
            }
            _ => return Err(format!("不支持的输出格式: {}", output_format)),
        };
        let r = StdCommand::new("sips")
            .args(["-s", "format", sips_fmt, &input_path, "--out", &out_str])
            .output()
            .map_err(|e| format!("sips 调用失败: {}", e))?;
        if !r.status.success() {
            return Err(format!(
                "HEIC 转换失败: {}",
                String::from_utf8_lossy(&r.stderr)
            ));
        }
    } else {
        let img = image::open(&input_path).map_err(|e| format!("无法读取图片: {}", e))?;
        let fmt = match output_format.as_str() {
            "jpg" | "jpeg" => image::ImageFormat::Jpeg,
            "png" => image::ImageFormat::Png,
            "webp" => image::ImageFormat::WebP,
            _ => return Err(format!("不支持的输出格式: {}", output_format)),
        };
        img.save_with_format(&out, fmt)
            .map_err(|e| format!("保存失败: {}", e))?;
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
    input_path: String,
    fps: u32,
    width: i32,
    start_time: Option<f64>,
    duration: Option<f64>,
) -> Result<ConversionResult, String> {
    if !has_command("ffmpeg") {
        return Err("需要安装 FFmpeg: brew install ffmpeg".into());
    }

    let out = make_output_path(&input_path, "gif");
    let out_str = out.to_string_lossy().to_string();

    let scale_filter = if width > 0 {
        format!("fps={},scale={}:-1:flags=lanczos", fps, width)
    } else {
        format!("fps={}", fps)
    };

    let mut args: Vec<String> = vec!["-y".into()];

    if let Some(ss) = start_time {
        args.extend(["-ss".into(), format!("{:.2}", ss)]);
    }
    if let Some(t) = duration {
        args.extend(["-t".into(), format!("{:.2}", t)]);
    }

    args.extend([
        "-i".into(),
        input_path.clone(),
        "-vf".into(),
        scale_filter,
        "-loop".into(),
        "0".into(),
        out_str.clone(),
    ]);

    let r = StdCommand::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("ffmpeg 调用失败: {}", e))?;

    if !r.status.success() {
        return Err(format!(
            "GIF 转换失败: {}",
            String::from_utf8_lossy(&r.stderr)
        ));
    }

    Ok(ConversionResult {
        output_path: out_str,
        output_size: file_size(&out),
        message: "GIF 转换完成".into(),
    })
}

#[tauri::command]
async fn extract_audio(
    input_path: String,
    output_format: String,
) -> Result<ConversionResult, String> {
    if !has_command("ffmpeg") {
        return Err("需要安装 FFmpeg: brew install ffmpeg".into());
    }

    let out = make_output_path(&input_path, &output_format);
    let out_str = out.to_string_lossy().to_string();

    let codec = match output_format.as_str() {
        "mp3" => "libmp3lame",
        "wav" => "pcm_s16le",
        "aac" | "m4a" => "aac",
        _ => return Err(format!("不支持的音频格式: {}", output_format)),
    };

    let r = StdCommand::new("ffmpeg")
        .args([
            "-y",
            "-i",
            &input_path,
            "-vn",
            "-acodec",
            codec,
            "-q:a",
            "2",
            &out_str,
        ])
        .output()
        .map_err(|e| format!("ffmpeg 调用失败: {}", e))?;

    if !r.status.success() {
        return Err(format!(
            "音频提取失败: {}",
            String::from_utf8_lossy(&r.stderr)
        ));
    }

    Ok(ConversionResult {
        output_path: out_str,
        output_size: file_size(&out),
        message: "音频提取完成".into(),
    })
}

#[tauri::command]
async fn transcribe_audio(
    input_path: String,
    model_size: String,
    language: Option<String>,
) -> Result<ConversionResult, String> {
    // Check for whisper binary
    let whisper_cmd = if has_command("whisper-cpp") {
        "whisper-cpp"
    } else if has_command("whisper") {
        "whisper"
    } else {
        return Err("需要安装 whisper-cpp: brew install whisper-cpp".into());
    };

    // Determine model path (Homebrew installs models to a standard location)
    let home = std::env::var("HOME").unwrap_or_default();
    let model_name = format!("ggml-{}.bin", model_size);

    // Common model locations
    let model_paths = vec![
        format!(
            "{}/Library/Application Support/Forph/models/{}",
            home, model_name
        ),
        format!("/opt/homebrew/share/whisper-cpp/models/{}", model_name),
        format!("/usr/local/share/whisper-cpp/models/{}", model_name),
    ];

    let model_path = model_paths
        .iter()
        .find(|p| Path::new(p).exists())
        .ok_or_else(|| {
            format!(
                "未找到 Whisper 模型 ({})。请运行:\n\
                 brew install whisper-cpp\n\
                 或手动下载模型到 ~/Library/Application Support/Forph/models/",
                model_size
            )
        })?;

    // First extract audio to WAV (whisper.cpp needs WAV 16kHz)
    let tmp_wav = make_output_path(&input_path, "tmp_whisper.wav");
    let tmp_wav_str = tmp_wav.to_string_lossy().to_string();

    if has_command("ffmpeg") {
        let r = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-i",
                &input_path,
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                &tmp_wav_str,
            ])
            .output()
            .map_err(|e| format!("ffmpeg 调用失败: {}", e))?;

        if !r.status.success() {
            return Err("音频预处理失败".into());
        }
    } else {
        // If no ffmpeg, try using the input directly (might work for wav files)
        if !input_path.ends_with(".wav") {
            return Err("需要安装 FFmpeg 来预处理音频: brew install ffmpeg".into());
        }
    }

    let wav_input = if tmp_wav.exists() {
        tmp_wav_str.clone()
    } else {
        input_path.clone()
    };

    let out = make_output_path(&input_path, "txt");
    let out_str = out.to_string_lossy().to_string();

    let mut args = vec![
        "-m".to_string(),
        model_path.clone(),
        "-f".into(),
        wav_input.clone(),
        "-otxt".into(),
        "-of".into(),
        out_str.trim_end_matches(".txt").to_string(),
    ];

    if let Some(lang) = language {
        args.extend(["-l".into(), lang]);
    }

    let r = StdCommand::new(whisper_cmd)
        .args(&args)
        .output()
        .map_err(|e| format!("whisper 调用失败: {}", e))?;

    // Clean up temp WAV
    let _ = std::fs::remove_file(&tmp_wav);

    if !r.status.success() {
        return Err(format!("转写失败: {}", String::from_utf8_lossy(&r.stderr)));
    }

    Ok(ConversionResult {
        output_path: out_str,
        output_size: file_size(&out),
        message: "转写完成".into(),
    })
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
fn open_file(path: String) -> Result<(), String> {
    StdCommand::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("无法打开文件: {}", e))?;
    Ok(())
}

// ─── App Setup ───────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_file_info,
            convert_image,
            export_markdown,
            video_to_gif,
            extract_audio,
            transcribe_audio,
            reveal_in_finder,
            open_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forph");
}

#[cfg(test)]
mod tests {
    use super::strip_frontmatter;

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
}
