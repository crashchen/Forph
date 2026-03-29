import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { BatchFileResult, FileInfo } from "../../lib/types";
import {
  formatProgressStage,
  formatProgressTimeRange,
} from "../../lib/format";
import type { BatchProgressState } from "./batchState";

interface BatchProgressViewProps {
  files: FileInfo[];
  results: BatchFileResult[];
  progress: BatchProgressState;
  stopRequested: boolean;
  buildStatusLabel: (result: BatchFileResult) => string;
  onRequestStop: () => void;
}

function formatPercent(value: number | null): string | null {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return `${Math.round(value)}%`;
}

export function BatchProgressView({
  files,
  results,
  progress,
  stopRequested,
  buildStatusLabel,
  onRequestStop,
}: BatchProgressViewProps) {
  const completedCount = results.filter((result) =>
    ["success", "error", "skipped", "cancelled"].includes(result.status),
  ).length;
  const totalProgress =
    files.length > 0
      ? ((completedCount + (progress.currentFileProgress ?? 0) / 100) / files.length) * 100
      : 0;
  const currentFile =
    progress.currentIndex != null && progress.currentIndex < files.length
      ? files[progress.currentIndex]
      : null;
  const currentStageLabel = formatProgressStage(progress.currentStage);
  const currentTimeRange = formatProgressTimeRange(
    progress.currentSeconds,
    progress.totalSeconds,
  );
  const currentPercentLabel = progress.currentProgressIndeterminate
    ? null
    : formatPercent(progress.currentFileProgress);
  const currentMeta = [
    currentStageLabel,
    currentPercentLabel,
    currentTimeRange,
  ].filter(Boolean);

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div className="glass p-8 rounded-2xl text-center">
        <Loader2 size={40} className="spin-slow text-accent mx-auto mb-5" />
        <h2 className="text-lg font-semibold text-white/90 mb-1">
          批量处理中...
        </h2>
        <p className="text-sm text-white/50">
          {completedCount} / {files.length}
          {currentFile && (
            <span className="text-white/30 ml-2">· {currentFile.name}</span>
          )}
        </p>

        <div className="mt-5 h-2 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, totalProgress))}%` }}
          />
        </div>

        <p className="text-xs text-white/25 mt-4">{progress.currentMessage}</p>
        {currentMeta.length > 0 && (
          <p className="text-xs text-white/35 mt-1 font-mono">
            当前文件 {currentMeta.join(" · ")}
          </p>
        )}

        {results.some((result) => result.status !== "pending") && (
          <div className="mt-4 max-h-40 overflow-y-auto space-y-1 text-left">
            {results
              .filter((result) => result.status !== "pending")
              .map((result) => (
                <div
                  key={result.file.path}
                  className="flex items-center gap-2 text-xs px-1"
                >
                  {result.status === "success" || result.status === "skipped" ? (
                    <CheckCircle2 size={12} className="text-success shrink-0" />
                  ) : result.status === "running" ? (
                    <Loader2 size={12} className="spin-slow text-accent shrink-0" />
                  ) : (
                    <XCircle size={12} className="text-danger shrink-0" />
                  )}
                  <span className="truncate text-white/40">{result.file.name}</span>
                  <span className="shrink-0 text-white/25 ml-auto">
                    {buildStatusLabel(result)}
                  </span>
                </div>
              ))}
          </div>
        )}

        <button
          onClick={onRequestStop}
          disabled={stopRequested}
          className={`no-drag mt-5 px-5 py-2 rounded-xl text-sm transition-colors ${
            stopRequested
              ? "cursor-not-allowed bg-warning/10 text-warning"
              : "cursor-pointer text-white/40 hover:text-white/60 hover:bg-white/5"
          }`}
        >
          {stopRequested ? "已请求：当前文件完成后停止" : "处理完当前文件后停止"}
        </button>
      </div>
    </div>
  );
}
