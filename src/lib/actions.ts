import {
  ACTION_IDS,
  IMAGE_ACTION_IDS,
  REALTIME_ACTION_IDS,
  imageOutputFormatFromActionId,
  isImageActionId,
} from "./actionIds";
import type { FileInfo, FileAction } from "./types";

function requiresFfmpegForTranscription(file: FileInfo): boolean {
  return file.file_type === "video" || file.file_type === "audio";
}

function normalizeImageExtension(extension: string): string {
  return extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase();
}

function imageActionOrder(actionId: FileAction["id"]): number {
  return IMAGE_ACTION_IDS.indexOf(actionId as (typeof IMAGE_ACTION_IDS)[number]);
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

  if (action.id === ACTION_IDS.VID_GIF || action.id === ACTION_IDS.VID_COMPRESS) {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (action.id === ACTION_IDS.VID_MP3 || action.id === ACTION_IDS.VID_WAV) {
    if (!runtime.ffmpeg_available) {
      return "需要先安装 FFmpeg";
    }
    if (media?.has_audio === false) {
      return "这个视频里没有可提取的音轨";
    }
    return null;
  }

  if (action.id === ACTION_IDS.AUD_MP3 || action.id === ACTION_IDS.AUD_WAV) {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (
    action.id === ACTION_IDS.VID_TRANSCRIBE ||
    action.id === ACTION_IDS.AUD_TRANSCRIBE ||
    action.id === ACTION_IDS.VID_TRANSCRIBE_SRT ||
    action.id === ACTION_IDS.AUD_TRANSCRIBE_SRT ||
    action.id === ACTION_IDS.VID_TRANSCRIBE_VTT ||
    action.id === ACTION_IDS.AUD_TRANSCRIBE_VTT
  ) {
    if (!runtime.whisper_available) {
      return "需要先安装 whisper-cpp";
    }
    if (runtime.available_models.length === 0 && !runtime.base_model_available) {
      return "缺少 Whisper 模型";
    }
    if (requiresFfmpegForTranscription(file) && !runtime.ffmpeg_available) {
      return "当前文件转写前需要 FFmpeg 预处理";
    }
    if (
      (action.id === ACTION_IDS.VID_TRANSCRIBE ||
        action.id === ACTION_IDS.VID_TRANSCRIBE_SRT ||
        action.id === ACTION_IDS.VID_TRANSCRIBE_VTT) &&
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

export function shouldSkipBatchAction(
  file: FileInfo,
  actionId: FileAction["id"],
): boolean {
  if (!isImageActionId(actionId)) {
    return false;
  }

  const targetFormat = normalizeImageExtension(
    imageOutputFormatFromActionId(actionId),
  );
  const sourceFormat = normalizeImageExtension(file.extension);

  return targetFormat === sourceFormat;
}

export function actionUsesRealtimeProgress(actionId: FileAction["id"]): boolean {
  return REALTIME_ACTION_IDS.has(actionId);
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
    action.id === ACTION_IDS.VID_MP3 ||
    action.id === ACTION_IDS.VID_WAV ||
    action.id === ACTION_IDS.VID_TRANSCRIBE ||
    action.id === ACTION_IDS.VID_TRANSCRIBE_SRT ||
    action.id === ACTION_IDS.VID_TRANSCRIBE_VTT;

  if (!isVideoAudioDependentAction) {
    return baseReason;
  }

  const allMuted = files.every((file) => file.media?.has_audio === false);
  if (allMuted) {
    return action.id === ACTION_IDS.VID_MP3 || action.id === ACTION_IDS.VID_WAV
      ? "这些视频里都没有可提取的音轨"
      : "这些视频里都没有可转写的音轨";
  }

  if (baseReason === "这个视频里没有可提取的音轨" || baseReason === "这个视频里没有可转写的音轨") {
    return null;
  }

  return baseReason;
}
