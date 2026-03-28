import type { FileInfo, FileAction } from "./types";

function requiresFfmpegForTranscription(file: FileInfo): boolean {
  return file.file_type === "video" || file.file_type === "audio";
}

export function getActionDisabledReason(
  file: FileInfo,
  action: FileAction,
): string | null {
  const runtime = file.runtime;
  const media = file.media;

  if (!runtime) {
    return null;
  }

  if (action.id === "vid_gif" || action.id === "vid_compress") {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (action.id === "vid_mp3" || action.id === "vid_wav") {
    if (!runtime.ffmpeg_available) {
      return "需要先安装 FFmpeg";
    }
    if (media?.has_audio === false) {
      return "这个视频里没有可提取的音轨";
    }
    return null;
  }

  if (action.id === "aud_mp3" || action.id === "aud_wav") {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (
    action.id === "vid_transcribe" ||
    action.id === "aud_transcribe" ||
    action.id === "vid_transcribe_srt" ||
    action.id === "aud_transcribe_srt" ||
    action.id === "vid_transcribe_vtt" ||
    action.id === "aud_transcribe_vtt"
  ) {
    if (!runtime.whisper_available) {
      return "需要先安装 whisper-cpp";
    }
    if (!runtime.base_model_available) {
      return "缺少 ggml-base.bin 模型";
    }
    if (requiresFfmpegForTranscription(file) && !runtime.ffmpeg_available) {
      return "当前文件转写前需要 FFmpeg 预处理";
    }
    if (
      (action.id === "vid_transcribe" ||
        action.id === "vid_transcribe_srt" ||
        action.id === "vid_transcribe_vtt") &&
      media?.has_audio === false
    ) {
      return "这个视频里没有可转写的音轨";
    }
    return null;
  }

  return null;
}
