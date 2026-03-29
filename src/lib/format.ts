export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds?: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

const progressStageLabels: Record<string, string> = {
  convert: "转换中",
  extract: "提取中",
  compress: "压缩中",
  preprocess: "预处理中",
  analyze: "分析片段",
  detect: "检测语言",
  transcribe: "转写中",
  merge: "合并结果",
  finalize: "收尾中",
};

export function formatProgressStage(stage?: string | null): string | null {
  if (!stage) {
    return null;
  }

  return progressStageLabels[stage] ?? stage;
}

export function formatMediaClock(seconds?: number | null): string | null {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) {
    return null;
  }

  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatProgressTimeRange(
  currentSeconds?: number | null,
  totalSeconds?: number | null,
): string | null {
  const current = formatMediaClock(currentSeconds);
  const total = formatMediaClock(totalSeconds);

  if (current && total) {
    return `${current} / ${total}`;
  }

  return current ?? total ?? null;
}
