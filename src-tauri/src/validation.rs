use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub(crate) enum ValidatedOpenTarget {
    Url(String),
    Path(PathBuf),
}

pub(crate) fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub(crate) fn validate_input_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径不能为空。".into());
    }

    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return Err("只能处理本地绝对路径文件。".into());
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("无法解析文件路径: {}", e))?;
    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("无法读取文件: {}", e))?;
    if !metadata.is_file() {
        return Err("只能处理本地文件。".into());
    }

    Ok(resolved)
}

pub(crate) fn make_output_path_for_input(input: &Path, new_ext: &str) -> Result<PathBuf, String> {
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "无法从输入文件名生成输出文件名。".to_string())?;
    let parent = input
        .parent()
        .ok_or_else(|| "无法确定输出目录。".to_string())?;

    let candidate = parent.join(format!("{}.{}", stem, new_ext));
    if !candidate.exists() {
        return Ok(candidate);
    }

    for i in 1..1000 {
        let path = parent.join(format!("{}_{}.{}", stem, i, new_ext));
        if !path.exists() {
            return Ok(path);
        }
    }

    Err("无法生成不冲突的输出文件名。".into())
}

pub(crate) fn unique_temp_file_path(prefix: &str, extension: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "{}-{}-{}.{}",
        prefix,
        std::process::id(),
        unique,
        extension
    ))
}

pub(crate) fn make_temporary_output_path(final_path: &Path) -> Result<PathBuf, String> {
    let parent = final_path
        .parent()
        .ok_or_else(|| "无法确定临时输出目录。".to_string())?;
    let stem = final_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "无法从输出文件名生成临时文件名。".to_string())?;
    let extension = final_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "无法确定临时输出格式。".to_string())?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    for index in 0..1000 {
        let candidate = parent.join(format!(
            ".{}.forph-{}-{}-{}.{}",
            stem,
            std::process::id(),
            unique,
            index,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("无法生成临时输出文件名。".into())
}

pub(crate) fn discard_temporary_output(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub(crate) fn commit_temporary_output(temp_path: &Path, final_path: &Path) -> Result<(), String> {
    if !temp_path.exists() {
        return Err("转换没有生成有效的临时输出文件。".into());
    }

    if final_path.exists() {
        discard_temporary_output(temp_path);
        return Err("输出文件已存在，请重试生成新的文件名。".into());
    }

    std::fs::rename(temp_path, final_path).map_err(|error| {
        discard_temporary_output(temp_path);
        format!("写入输出文件失败: {}", error)
    })
}

fn is_http_url(target: &str) -> bool {
    target.starts_with("http://") || target.starts_with("https://")
}

fn is_trusted_open_url(target: &str) -> bool {
    matches!(target, "https://brew.sh" | "https://brew.sh/")
        || target.starts_with("https://huggingface.co/")
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("只能打开本地绝对路径。".into());
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => parts.push(part.to_os_string()),
            std::path::Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err("只能打开本地绝对路径。".into());
                }
            }
            std::path::Component::Prefix(_) => {
                return Err("只能打开本地绝对路径。".into());
            }
        }
    }

    let mut normalized = PathBuf::from("/");
    for part in parts {
        normalized.push(part);
    }
    Ok(normalized)
}

pub(crate) fn validate_existing_local_target(target: &str) -> Result<PathBuf, String> {
    if target.trim().is_empty() {
        return Err("目标不能为空。".into());
    }
    if is_http_url(target.trim()) {
        return Err("只允许打开受信任的下载地址。".into());
    }

    let normalized = normalize_absolute_path(Path::new(target))?;
    if !normalized.exists() {
        return Err("只能打开已存在的本地路径。".into());
    }

    normalized
        .canonicalize()
        .map_err(|error| format!("无法解析路径: {}", error))
}

pub(crate) fn validate_open_target_request(
    target: &str,
    ensure_directory: bool,
    allowed_model_directory: &Path,
) -> Result<ValidatedOpenTarget, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("目标不能为空。".into());
    }

    if is_http_url(trimmed) {
        if ensure_directory {
            return Err("模型目录只能是本地绝对路径。".into());
        }
        if !is_trusted_open_url(trimmed) {
            return Err("只允许打开受信任的下载地址。".into());
        }
        return Ok(ValidatedOpenTarget::Url(trimmed.to_string()));
    }

    let normalized = normalize_absolute_path(Path::new(target))?;
    if ensure_directory {
        let allowed = normalize_absolute_path(allowed_model_directory)?;
        if normalized != allowed {
            return Err("模型目录以外的路径不允许自动创建。".into());
        }
        return Ok(ValidatedOpenTarget::Path(normalized));
    }

    Ok(ValidatedOpenTarget::Path(validate_existing_local_target(
        trimmed,
    )?))
}
