use std::path::{Path, PathBuf};

use crate::command_with_augmented_path;

pub(crate) fn normalize_pdf_raw_text(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|ch| matches!(*ch, '\n' | '\u{000C}' | '\t') || !ch.is_control())
        .collect()
}

fn normalize_pdf_line_whitespace(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn is_pdf_list_item(line: &str) -> bool {
    let trimmed = line.trim_start();

    if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("• ") {
        return true;
    }

    let digit_count = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count();

    if digit_count == 0 {
        return false;
    }

    matches!(trimmed.chars().nth(digit_count), Some('.') | Some(')'))
        && trimmed
            .chars()
            .nth(digit_count + 1)
            .map(|ch| ch.is_whitespace())
            .unwrap_or(false)
}

fn flush_pdf_paragraph_block(lines: &[String]) -> Option<String> {
    let mut rebuilt = Vec::new();
    let mut prose = String::new();

    for line in lines {
        if is_pdf_list_item(line) {
            if !prose.is_empty() {
                rebuilt.push(prose.trim().to_string());
                prose.clear();
            }
            rebuilt.push(line.to_string());
            continue;
        }

        if prose.is_empty() {
            prose.push_str(line);
        } else {
            prose.push(' ');
            prose.push_str(line);
        }
    }

    if !prose.is_empty() {
        rebuilt.push(prose.trim().to_string());
    }

    let paragraph = rebuilt
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    (!paragraph.is_empty()).then_some(paragraph)
}

pub(crate) fn clean_pdf_page_text(page: &str) -> String {
    let mut paragraphs = Vec::new();
    let mut current_lines = Vec::new();

    for raw_line in page.lines() {
        let line = normalize_pdf_line_whitespace(raw_line);
        if line.is_empty() {
            if let Some(paragraph) = flush_pdf_paragraph_block(&current_lines) {
                paragraphs.push(paragraph);
            }
            current_lines.clear();
            continue;
        }

        current_lines.push(line);
    }

    if let Some(paragraph) = flush_pdf_paragraph_block(&current_lines) {
        paragraphs.push(paragraph);
    }

    paragraphs.join("\n\n")
}

pub(crate) fn extract_clean_pdf_pages(raw: &str) -> Vec<(usize, String)> {
    normalize_pdf_raw_text(raw)
        .split('\u{000C}')
        .enumerate()
        .filter_map(|(index, page)| {
            let cleaned = clean_pdf_page_text(page);
            (!cleaned.is_empty()).then_some((index + 1, cleaned))
        })
        .collect()
}

pub(crate) fn build_pdf_markdown_document(title: &str, pages: &[(usize, String)]) -> String {
    let normalized_title = title.replace(['\r', '\n'], " ");
    let mut output = format!("# {}\n", normalized_title.trim());

    for (page_number, page_text) in pages {
        output.push_str(&format!("\n## Page {}\n\n{}\n", page_number, page_text));
    }

    output.trim_end().to_string() + "\n"
}

pub(crate) fn extract_pdf_pages_with_pdftotext(
    pdftotext: PathBuf,
    input_path: &Path,
) -> Result<Vec<(usize, String)>, String> {
    let extraction_output = command_with_augmented_path(pdftotext)
        .args(["-enc", "UTF-8", "-eol", "unix", "-q"])
        .arg(input_path)
        .arg("-")
        .output()
        .map_err(|error| format!("调用 pdftotext 失败: {}", error))?;

    if !extraction_output.status.success() {
        let stderr = String::from_utf8_lossy(&extraction_output.stderr)
            .trim()
            .to_string();
        let details = if stderr.is_empty() {
            "文件可能已加密、损坏，或当前系统无法读取它的文本层。".into()
        } else {
            stderr
        };
        return Err(format!("PDF 文本提取失败：{}", details));
    }

    let raw_text = String::from_utf8_lossy(&extraction_output.stdout).to_string();
    let pages = extract_clean_pdf_pages(&raw_text);
    if pages.is_empty() {
        return Err("该 PDF 没有可提取文本层，可能是扫描件；v1 暂不支持 OCR。".into());
    }

    Ok(pages)
}
