import { useEffect, useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import { ACTION_LABELS, type ActionId } from "../lib/actionIds";
import type { FileInfo } from "../lib/types";
import { cancelJob, listenConversionProgress } from "../lib/commands";
import { getErrorMessage } from "../lib/errors";
import {
  formatMediaClock,
  formatProgressStage,
  formatProgressTimeRange,
} from "../lib/format";

interface ConvertingProps {
  file: FileInfo;
  actionId: ActionId;
  jobId?: string;
}

function formatPercent(percent?: number | null): string | null {
  if (percent == null || Number.isNaN(percent)) {
    return null;
  }

  return `${Math.round(percent)}%`;
}

export function Converting({ file, actionId, jobId }: ConvertingProps) {
  const label = ACTION_LABELS[actionId] || "处理中";
  const [percent, setPercent] = useState<number | null>(null);
  const [indeterminate, setIndeterminate] = useState(true);
  const [message, setMessage] = useState<string>("请稍候，正在本地处理...");
  const [stage, setStage] = useState<string | null>(null);
  const [currentSeconds, setCurrentSeconds] = useState<number | null>(null);
  const [totalSeconds, setTotalSeconds] = useState<number | null>(null);
  const [cancelState, setCancelState] = useState<{
    jobId: string | null;
    requested: boolean;
    error: string | null;
  }>({ jobId: null, requested: false, error: null });

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenConversionProgress((event) => {
      if (disposed || event.jobId !== jobId || event.filePath !== file.path) {
        return;
      }

      setIndeterminate(event.indeterminate);
      setPercent(event.percent ?? null);
      setStage(event.stage);
      setCurrentSeconds(event.currentSeconds ?? null);
      setTotalSeconds(event.totalSeconds ?? null);
      if (event.message) {
        setMessage(event.message);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error: unknown) => {
        console.error("Failed to listen for conversion progress", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [file.path, jobId]);

  const displayPercent = indeterminate ? null : formatPercent(percent);
  const progressWidth = percent != null ? `${Math.max(0, Math.min(100, percent))}%` : "100%";
  const stageLabel = formatProgressStage(stage);
  const timeRange = formatProgressTimeRange(currentSeconds, totalSeconds);
  const currentTimeOnly =
    timeRange == null ? formatMediaClock(currentSeconds) : null;
  const progressMeta = [stageLabel, displayPercent, timeRange ?? currentTimeOnly].filter(
    Boolean,
  );
  const cancelRequested = cancelState.jobId === jobId && cancelState.requested;
  const cancelError = cancelState.jobId === jobId ? cancelState.error : null;

  async function handleCancel() {
    if (!jobId || cancelRequested) {
      return;
    }

    setCancelState({ jobId, requested: true, error: null });
    setMessage("正在取消当前任务...");

    try {
      await cancelJob(jobId);
      setMessage("已发送取消请求，正在收尾...");
    } catch (error) {
      setCancelState({
        jobId,
        requested: false,
        error: getErrorMessage(error, "取消请求失败"),
      });
    }
  }

  return (
    <div className="animate-fade-up text-center max-w-md">
      <div className="glass p-10 rounded-2xl">
        <Loader2 size={40} className="spin-slow text-accent mx-auto mb-5" />
        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {label}...
        </h2>
        <p className="text-sm text-white/40">{file.name}</p>

        <div className="mt-6 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className={`h-full rounded-full ${indeterminate ? "w-full progress-shimmer" : "bg-accent transition-all duration-300"}`}
            style={indeterminate ? undefined : { width: progressWidth }}
          />
        </div>

        <p className="text-xs text-white/25 mt-4">{message}</p>
        {progressMeta.length > 0 && (
          <p className="text-xs text-white/35 mt-1 font-mono">
            {progressMeta.join(" · ")}
          </p>
        )}
        {cancelError && (
          <p className="text-xs text-danger mt-3">{cancelError}</p>
        )}
        {jobId && (
          <button
            onClick={() => {
              void handleCancel();
            }}
            disabled={cancelRequested}
            className={`no-drag mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${
              cancelRequested
                ? "cursor-not-allowed bg-warning/10 text-warning"
                : "cursor-pointer text-white/40 hover:text-white/70 hover:bg-white/5"
            }`}
          >
            <XCircle size={15} />
            {cancelRequested ? "正在取消..." : "取消当前任务"}
          </button>
        )}
      </div>
    </div>
  );
}
