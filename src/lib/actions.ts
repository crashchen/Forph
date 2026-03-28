import type { FileInfo, FileAction } from "./types";

function requiresFfmpegForTranscription(file: FileInfo): boolean {
  return file.file_type === "video" || file.file_type === "audio";
}

function normalizeImageExtension(extension: string): string {
  return extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase();
}

function imageActionOrder(actionId: string): number {
  return ["img_jpg", "img_png", "img_webp"].indexOf(actionId);
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

export function getBatchActions(files: FileInfo[]): FileAction[] {
  if (files.length === 0) {
    return [];
  }

  if (files[0].file_type === "image") {
    const byId = new Map<string, FileAction>();

    for (const file of files) {
      for (const action of file.actions) {
        if (!byId.has(action.id)) {
          byId.set(action.id, action);
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) => {
      return imageActionOrder(a.id) - imageActionOrder(b.id);
    });
  }

  const intersectionIds = files.slice(1).reduce<Set<string>>(
    (ids, file) =>
      new Set(file.actions.map((action) => action.id).filter((id) => ids.has(id))),
    new Set(files[0].actions.map((action) => action.id)),
  );

  return files[0].actions.filter((action) => intersectionIds.has(action.id));
}

export function shouldSkipBatchAction(file: FileInfo, actionId: string): boolean {
  if (!actionId.startsWith("img_")) {
    return false;
  }

  const targetFormat = normalizeImageExtension(actionId.replace("img_", ""));
  const sourceFormat = normalizeImageExtension(file.extension);

  return targetFormat === sourceFormat;
}

export function actionUsesRealtimeProgress(actionId: string): boolean {
  return (
    actionId === "vid_gif" ||
    actionId === "vid_compress" ||
    actionId === "vid_mp3" ||
    actionId === "vid_wav" ||
    actionId === "aud_mp3" ||
    actionId === "aud_wav" ||
    actionId === "vid_transcribe" ||
    actionId === "aud_transcribe" ||
    actionId === "vid_transcribe_srt" ||
    actionId === "aud_transcribe_srt" ||
    actionId === "vid_transcribe_vtt" ||
    actionId === "aud_transcribe_vtt"
  );
}

export function getBatchActionDisabledReason(
  files: FileInfo[],
  action: FileAction,
): string | null {
  if (files.length === 0) {
    return null;
  }

  const first = files[0];
  const baseReason = getActionDisabledReason(first, action);
  const isVideoAudioDependentAction =
    action.id === "vid_mp3" ||
    action.id === "vid_wav" ||
    action.id === "vid_transcribe" ||
    action.id === "vid_transcribe_srt" ||
    action.id === "vid_transcribe_vtt";

  if (!isVideoAudioDependentAction) {
    return baseReason;
  }

  const allMuted = files.every((file) => file.media?.has_audio === false);
  if (allMuted) {
    return action.id === "vid_mp3" || action.id === "vid_wav"
      ? "这些视频里都没有可提取的音轨"
      : "这些视频里都没有可转写的音轨";
  }

  if (baseReason === "这个视频里没有可提取的音轨" || baseReason === "这个视频里没有可转写的音轨") {
    return null;
  }

  return baseReason;
}
