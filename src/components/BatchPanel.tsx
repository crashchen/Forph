import { useState, useCallback, useEffect, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderOpen,
  GripVertical,
  Image,
  Loader2,
  Music,
  RotateCcw,
  Video,
  X,
  XCircle,
} from "lucide-react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type {
  BatchFileResult,
  BatchImportSummary,
  ConversionProgressEvent,
  FileAction,
  FileInfo,
} from "../lib/types";
import {
  compressVideo,
  convertImage,
  exportMarkdown,
  extractAudio,
  getDragIcon,
  getFileInfo,
  installDependency,
  listenConversionProgress,
  revealInFinder,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";
import {
  formatProgressStage,
  formatProgressTimeRange,
  formatSize,
} from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import {
  actionUsesRealtimeProgress,
  getBatchActionDisabledReason,
  getBatchActions,
  shouldSkipBatchAction,
} from "../lib/actions";
import { GifOptions } from "./GifOptions";
import { CompressOptions } from "./CompressOptions";
import { ImageOptions } from "./ImageOptions";
import {
  DependencySection,
  type InstallableDependency,
} from "./DependencySection";

interface BatchPanelProps {
  files: FileInfo[];
  importSummary: BatchImportSummary;
  isDragOver: boolean;
  onFilesRefreshed: (files: FileInfo[]) => void;
  onReset: () => void;
}

interface BatchActionOptions {
  gifFps?: number;
  gifWidth?: number;
  gifStartTime?: number;
  gifDuration?: number;
  compressQuality?: string;
  compressMaxResolution?: string;
  imageQuality?: number;
}

interface BatchRunContext {
  actionId: string;
  options?: BatchActionOptions;
}

const typeIcons: Record<string, typeof Image> = {
  image: Image,
  markdown: FileText,
  video: Video,
  audio: Music,
};

const typeLabels: Record<string, string> = {
  image: "张图片",
  video: "个视频",
  audio: "个音频",
  markdown: "个文档",
};

function createJobId(actionId: string, filePath: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = filePath.split("/").pop() ?? "file";
  return `${actionId}:${name}:${suffix}`;
}

function buildInitialResults(files: FileInfo[]): BatchFileResult[] {
  return files.map((file) => ({
    file,
    status: "pending",
  }));
}

function formatImportWarnings(summary: BatchImportSummary): string[] {
  const warnings: string[] = [];

  if (summary.unreadableCount > 0) {
    warnings.push(`跳过了 ${summary.unreadableCount} 个无法读取的文件`);
  }
  if (summary.unsupportedCount > 0) {
    warnings.push(`跳过了 ${summary.unsupportedCount} 个不支持的文件`);
  }
  if (summary.filteredOutCount > 0) {
    warnings.push(`跳过了 ${summary.filteredOutCount} 个不同类型的文件`);
  }

  return warnings;
}

function formatPercent(value: number | null): string | null {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return `${Math.round(value)}%`;
}

function buildStatusLabel(result: BatchFileResult): string {
  switch (result.status) {
    case "success":
      return result.result ? formatSize(result.result.output_size) : "完成";
    case "error":
      return result.error ?? "失败";
    case "skipped":
      return "已跳过";
    case "cancelled":
      return "剩余项未执行";
    case "running":
      return "处理中";
    default:
      return "待处理";
  }
}

async function runAction(
  file: FileInfo,
  actionId: string,
  opts?: BatchActionOptions,
  jobId?: string,
) {
  if (actionId.startsWith("img_")) {
    return convertImage(file.path, actionId.replace("img_", ""), opts?.imageQuality);
  }
  if (actionId === "md_html") {
    return exportMarkdown(file.path);
  }
  if (actionId === "vid_gif") {
    return videoToGif(
      file.path,
      opts?.gifFps ?? 15,
      opts?.gifWidth ?? 480,
      opts?.gifStartTime,
      opts?.gifDuration,
      jobId,
    );
  }
  if (actionId === "vid_compress") {
    return compressVideo(
      file.path,
      opts?.compressQuality ?? "balanced",
      opts?.compressMaxResolution,
      jobId,
    );
  }
  if (actionId === "vid_mp3" || actionId === "aud_mp3") {
    return extractAudio(file.path, "mp3", jobId);
  }
  if (actionId === "vid_wav" || actionId === "aud_wav") {
    return extractAudio(file.path, "wav", jobId);
  }
  if (actionId === "vid_transcribe" || actionId === "aud_transcribe") {
    return transcribeAudio(file.path, "base", undefined, undefined, jobId);
  }
  if (actionId === "vid_transcribe_srt" || actionId === "aud_transcribe_srt") {
    return transcribeAudio(file.path, "base", undefined, "srt", jobId);
  }
  if (actionId === "vid_transcribe_vtt" || actionId === "aud_transcribe_vtt") {
    return transcribeAudio(file.path, "base", undefined, "vtt", jobId);
  }

  throw new Error(`未知操作: ${actionId}`);
}

export function BatchPanel({
  files,
  importSummary,
  isDragOver,
  onFilesRefreshed,
  onReset,
}: BatchPanelProps) {
  const [phase, setPhase] = useState<"selecting" | "converting" | "done">(
    "selecting",
  );
  const [completionState, setCompletionState] = useState<"completed" | "stopped">(
    "completed",
  );
  const [results, setResults] = useState<BatchFileResult[]>(() =>
    buildInitialResults(files),
  );
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [currentFileProgress, setCurrentFileProgress] = useState<number | null>(
    null,
  );
  const [currentProgressIndeterminate, setCurrentProgressIndeterminate] =
    useState(true);
  const [currentMessage, setCurrentMessage] = useState("准备开始处理...");
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [currentSeconds, setCurrentSeconds] = useState<number | null>(null);
  const [totalSeconds, setTotalSeconds] = useState<number | null>(null);
  const [showGifOptions, setShowGifOptions] = useState(false);
  const [showCompressOptions, setShowCompressOptions] = useState(false);
  const [imageOutputFormat, setImageOutputFormat] = useState<string | null>(null);
  const [installingDependency, setInstallingDependency] =
    useState<InstallableDependency | null>(null);
  const [dependencyMessage, setDependencyMessage] = useState<string | null>(
    null,
  );
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const [lastRunContext, setLastRunContext] = useState<BatchRunContext | null>(
    null,
  );
  const [stopRequested, setStopRequested] = useState(false);
  const stopAfterCurrentRef = useRef(false);
  const isMountedRef = useRef(true);
  const resultsRef = useRef(results);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPhase("selecting");
    setCompletionState("completed");
    setResults(buildInitialResults(files));
    setCurrentIndex(null);
    setCurrentJobId(null);
    setCurrentFileProgress(null);
    setCurrentProgressIndeterminate(true);
    setCurrentMessage("准备开始处理...");
    setCurrentStage(null);
    setCurrentSeconds(null);
    setTotalSeconds(null);
    setShowGifOptions(false);
    setShowCompressOptions(false);
    setImageOutputFormat(null);
    setDependencyMessage(null);
    setDependencyError(null);
    setStopRequested(false);
    stopAfterCurrentRef.current = false;
  }, [files]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenConversionProgress((event: ConversionProgressEvent) => {
      if (disposed || !currentJobId || event.jobId !== currentJobId) {
        return;
      }

      setCurrentFileProgress(event.percent ?? null);
      setCurrentProgressIndeterminate(event.indeterminate);
      setCurrentMessage(event.message ?? "正在处理当前文件...");
      setCurrentStage(event.stage);
      setCurrentSeconds(event.currentSeconds ?? null);
      setTotalSeconds(event.totalSeconds ?? null);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentJobId]);

  const fileType = files[0]?.file_type ?? "unknown";
  const runtime = files[0]?.runtime;
  const Icon = typeIcons[fileType] || FileText;
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const importWarnings = formatImportWarnings(importSummary);

  const executeBatch = useCallback(
    async (
      context: BatchRunContext,
      selectedIndices: number[],
      mode: "all" | "partial",
    ) => {
      if (selectedIndices.length === 0) {
        return;
      }

      setLastRunContext(context);
      setPhase("converting");
      setCompletionState("completed");
      setCurrentIndex(null);
      setCurrentJobId(null);
      setCurrentFileProgress(null);
      setCurrentProgressIndeterminate(true);
      setCurrentMessage("准备开始处理...");
      setCurrentStage(null);
      setCurrentSeconds(null);
      setTotalSeconds(null);
      setStopRequested(false);
      stopAfterCurrentRef.current = false;

      const nextResults =
        mode === "all"
          ? buildInitialResults(files)
          : resultsRef.current.map((result) => ({ ...result }));

      if (mode === "partial") {
        for (const index of selectedIndices) {
          nextResults[index] = {
            file: files[index],
            status: "pending",
          };
        }
      }

      if (isMountedRef.current) {
        setResults([...nextResults]);
      }

      let stopped = false;

      for (const index of selectedIndices) {
        if (stopAfterCurrentRef.current) {
          stopped = true;
          break;
        }

        const file = files[index];

        if (shouldSkipBatchAction(file, context.actionId)) {
          nextResults[index] = {
            file,
            status: "skipped",
          };
          if (isMountedRef.current) {
            setResults([...nextResults]);
          }
          continue;
        }

        const jobId = actionUsesRealtimeProgress(context.actionId)
          ? createJobId(context.actionId, file.path)
          : undefined;

        nextResults[index] = {
          file,
          status: "running",
        };

        if (isMountedRef.current) {
          setCurrentIndex(index);
          setCurrentJobId(jobId ?? null);
          setCurrentFileProgress(jobId ? 0 : null);
          setCurrentProgressIndeterminate(Boolean(jobId));
          setCurrentMessage("正在处理当前文件...");
          setCurrentStage(null);
          setCurrentSeconds(null);
          setTotalSeconds(null);
          setResults([...nextResults]);
        }

        try {
          const result = await runAction(file, context.actionId, context.options, jobId);
          nextResults[index] = {
            file,
            status: "success",
            result,
          };
        } catch (error) {
          nextResults[index] = {
            file,
            status: "error",
            error: getErrorMessage(error, "转换失败"),
          };
        }

        if (!isMountedRef.current) {
          return;
        }

        setCurrentJobId(null);
        setCurrentFileProgress(null);
        setCurrentProgressIndeterminate(true);
        setCurrentStage(null);
        setCurrentSeconds(null);
        setTotalSeconds(null);
        setResults([...nextResults]);
      }

      if (stopAfterCurrentRef.current) {
        stopped = true;
      }

      if (stopped) {
        for (const index of selectedIndices) {
          if (nextResults[index].status === "pending") {
            nextResults[index] = {
              file: files[index],
              status: "cancelled",
            };
          }
        }
      }

      if (isMountedRef.current) {
        setResults([...nextResults]);
        setCurrentIndex(null);
        setCurrentJobId(null);
        setCurrentFileProgress(null);
        setCurrentProgressIndeterminate(true);
        setCurrentMessage(
          stopped ? "已按你的要求在当前文件后停止，剩余项未执行。" : "全部处理完成。",
        );
        setCurrentStage(null);
        setCurrentSeconds(null);
        setTotalSeconds(null);
        setCompletionState(stopped ? "stopped" : "completed");
        setPhase("done");
      }
    },
    [files],
  );

  const startBatch = useCallback(
    async (actionId: string, options?: BatchActionOptions) => {
      const selectedIndices = files.map((_, index) => index);
      await executeBatch({ actionId, options }, selectedIndices, "all");
    },
    [executeBatch, files],
  );

  const retryFailedItems = useCallback(async () => {
    if (!lastRunContext) {
      return;
    }

    const failedIndices = resultsRef.current
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "error")
      .map(({ index }) => index);

    await executeBatch(lastRunContext, failedIndices, "partial");
  }, [executeBatch, lastRunContext]);

  const continueRemainingItems = useCallback(async () => {
    if (!lastRunContext) {
      return;
    }

    const cancelledIndices = resultsRef.current
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "cancelled")
      .map(({ index }) => index);

    await executeBatch(lastRunContext, cancelledIndices, "partial");
  }, [executeBatch, lastRunContext]);

  const handleDependencyInstall = useCallback(
    async (packageName: InstallableDependency) => {
      setDependencyMessage(null);
      setDependencyError(null);
      setInstallingDependency(packageName);

      try {
        const result = await installDependency(packageName);
        if (!isMountedRef.current) {
          return;
        }

        const refreshedSettled = await Promise.allSettled(
          files.map((file) => getFileInfo(file.path)),
        );
        if (!isMountedRef.current) {
          return;
        }

        let refreshFailures = 0;
        const refreshed = refreshedSettled.map((entry, index) => {
          if (entry.status === "fulfilled") {
            return entry.value;
          }

          refreshFailures += 1;
          return files[index];
        });

        onFilesRefreshed(refreshed);
        setDependencyMessage(
          refreshFailures > 0
            ? `${result.message} 已刷新 ${files.length - refreshFailures} 个文件，${refreshFailures} 个保留原状态。`
            : `${result.message} 文件列表已刷新。`,
        );
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        setDependencyError(getErrorMessage(error, "自动安装失败"));
      } finally {
        if (isMountedRef.current) {
          setInstallingDependency(null);
        }
      }
    },
    [files, onFilesRefreshed],
  );

  const handleDragAllOut = useCallback(async () => {
    const paths = results
      .filter((result) => result.status === "success" && result.result)
      .map((result) => result.result!.output_path);
    if (paths.length === 0) {
      return;
    }
    try {
      const icon = await getDragIcon();
      await startDrag({ item: paths, icon });
    } catch {
      // Drag cancelled or not supported
    }
  }, [results]);

  const successResults = results.filter((result) => result.status === "success");
  const failedResults = results.filter((result) => result.status === "error");
  const skippedResults = results.filter((result) => result.status === "skipped");
  const cancelledResults = results.filter(
    (result) => result.status === "cancelled",
  );
  const totalOutputSize = successResults.reduce(
    (sum, result) => sum + (result.result?.output_size ?? 0),
    0,
  );

  if (phase === "selecting") {
    const groups = getBatchActions(files).reduce(
      (acc, action) => {
        if (!acc[action.group]) {
          acc[action.group] = [];
        }
        acc[action.group].push(action);
        return acc;
      },
      {} as Record<string, FileAction[]>,
    );

    return (
      <div
        className={`animate-fade-up w-full max-w-xl transition-opacity ${isDragOver ? "opacity-30" : ""}`}
      >
        <div className="glass p-5 rounded-2xl mb-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent-dim flex items-center justify-center shrink-0">
              <Icon size={22} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0 text-left">
              <h3 className="text-sm font-semibold text-white/90">
                {files.length} {typeLabels[fileType] || "个文件"}
              </h3>
              <p className="text-xs text-white/40 mt-0.5">
                共 {formatSize(totalSize)}
              </p>
            </div>
            <button
              onClick={onReset}
              className="no-drag p-2 rounded-lg hover:bg-surface-hover text-white/30 hover:text-white/60 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-3 max-h-32 overflow-y-auto space-y-1">
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between text-xs text-white/40 px-1"
              >
                <span className="truncate flex-1 min-w-0">{file.name}</span>
                <span className="shrink-0 ml-2 text-white/25">
                  {formatSize(file.size)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {importWarnings.length > 0 && (
          <div className="mb-4 glass p-4 rounded-2xl text-left">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-white/78">这次批量已自动收口</p>
                {importWarnings.map((warning) => (
                  <p key={warning} className="text-xs text-white/42 leading-relaxed">
                    {warning}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}

        {Object.entries(groups).map(([group, groupActions]) => (
          <div key={group} className="mb-3">
            <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2 px-1">
              {group}
            </p>
            <div className="flex flex-wrap gap-2">
              {groupActions.map((action) => {
                const disabledReason = getBatchActionDisabledReason(files, action);
                const disabled = Boolean(disabledReason);
                const hasOptionsPanel =
                  action.id === "vid_gif" ||
                  action.id === "vid_compress" ||
                  action.id.startsWith("img_");

                if (hasOptionsPanel) {
                  const togglePanel = () => {
                    if (action.id === "vid_gif") {
                      setShowGifOptions((value) => !value);
                      setShowCompressOptions(false);
                      setImageOutputFormat(null);
                    } else if (action.id === "vid_compress") {
                      setShowCompressOptions((value) => !value);
                      setShowGifOptions(false);
                      setImageOutputFormat(null);
                    } else {
                      const format = action.id.replace("img_", "");
                      setImageOutputFormat((value) => (value === format ? null : format));
                      setShowGifOptions(false);
                      setShowCompressOptions(false);
                    }
                  };

                  return (
                    <button
                      key={action.id}
                      title={disabledReason ?? action.label}
                      disabled={disabled}
                      onClick={togglePanel}
                      className={`no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                        disabled
                          ? "cursor-not-allowed text-white/28 border-white/6 hover:bg-transparent"
                          : "cursor-pointer text-white/70 hover:text-white/90"
                      }`}
                    >
                      {action.label}
                    </button>
                  );
                }

                return (
                  <button
                    key={action.id}
                    title={disabledReason ?? action.label}
                    disabled={disabled}
                    onClick={() => {
                      void startBatch(action.id);
                    }}
                    className={`no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                      disabled
                        ? "cursor-not-allowed text-white/28 border-white/6 hover:bg-transparent"
                        : "cursor-pointer text-white/70 hover:text-white/90"
                    }`}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {showGifOptions && (
          <GifOptions
            file={files[0]}
            onConvert={(fps, width, startTime, duration) => {
              void startBatch("vid_gif", {
                gifFps: fps,
                gifWidth: width,
                gifStartTime: startTime,
                gifDuration: duration,
              });
            }}
          />
        )}
        {showCompressOptions && (
          <CompressOptions
            file={files[0]}
            onCompress={(quality, maxResolution) => {
              void startBatch("vid_compress", {
                compressQuality: quality,
                compressMaxResolution: maxResolution,
              });
            }}
          />
        )}
        {imageOutputFormat && (
          <ImageOptions
            outputFormat={imageOutputFormat}
            onConvert={(quality) => {
              void startBatch(`img_${imageOutputFormat}`, {
                imageQuality: quality,
              });
            }}
          />
        )}

        {runtime && (
          <DependencySection
            runtime={runtime}
            installingDependency={installingDependency}
            dependencyMessage={dependencyMessage}
            dependencyError={dependencyError}
            onInstallDependency={handleDependencyInstall}
          />
        )}

        <p className="text-center text-xs text-white/20 mt-6">
          选择操作后会按当前顺序批量处理 {files.length} 个文件
        </p>
      </div>
    );
  }

  if (phase === "converting") {
    const completedCount = results.filter((result) =>
      ["success", "error", "skipped", "cancelled"].includes(result.status),
    ).length;
    const totalProgress =
      files.length > 0
        ? ((completedCount + (currentFileProgress ?? 0) / 100) / files.length) * 100
        : 0;
    const currentFile =
      currentIndex != null && currentIndex < files.length ? files[currentIndex] : null;
    const currentStageLabel = formatProgressStage(currentStage);
    const currentTimeRange = formatProgressTimeRange(currentSeconds, totalSeconds);
    const currentPercentLabel = currentProgressIndeterminate
      ? null
      : formatPercent(currentFileProgress);
    const currentMeta = [currentStageLabel, currentPercentLabel, currentTimeRange].filter(
      Boolean,
    );

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

          <p className="text-xs text-white/25 mt-4">{currentMessage}</p>
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
                      <CheckCircle2
                        size={12}
                        className="text-success shrink-0"
                      />
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
            onClick={() => {
              stopAfterCurrentRef.current = true;
              setStopRequested(true);
            }}
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

  const firstOutputDir = successResults[0]?.result?.output_path
    .split("/")
    .slice(0, -1)
    .join("/");

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div className="glass p-8 rounded-2xl text-center">
        <div
          className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5 ${
            completionState === "stopped" ? "bg-warning-dim" : "bg-success-dim"
          }`}
        >
          {completionState === "stopped" ? (
            <AlertTriangle size={28} className="text-warning" />
          ) : (
            <CheckCircle2 size={32} className="text-success" />
          )}
        </div>

        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {completionState === "stopped" ? "批量处理已停止" : "批量处理完成"}
        </h2>
        <p className="text-sm text-white/50">
          {successResults.length > 0 && (
            <span className="text-success">{successResults.length} 成功</span>
          )}
          {failedResults.length > 0 && (
            <span className="text-danger ml-2">{failedResults.length} 失败</span>
          )}
          {skippedResults.length > 0 && (
            <span className="text-white/35 ml-2">{skippedResults.length} 跳过</span>
          )}
          {cancelledResults.length > 0 && (
            <span className="text-warning ml-2">{cancelledResults.length} 未执行</span>
          )}
        </p>

        {successResults.length > 0 && (
          <div className="mt-2 flex items-center justify-center gap-2 text-xs text-white/35">
            <span>{formatSize(totalSize)}</span>
            <span>&rarr;</span>
            <span
              className={
                totalOutputSize < totalSize ? "text-success" : "text-white/50"
              }
            >
              {formatSize(totalOutputSize)}
            </span>
            {totalOutputSize < totalSize && (
              <span className="text-success">
                (-{Math.round(((totalSize - totalOutputSize) / totalSize) * 100)}%)
              </span>
            )}
          </div>
        )}

        <div
          className="mt-4 glass p-3 rounded-xl text-left max-h-48 overflow-y-auto cursor-grab active:cursor-grabbing select-none transition-colors hover:ring-1 hover:ring-accent/20"
          onMouseDown={() => {
            void handleDragAllOut();
          }}
        >
          <div className="space-y-1.5">
            {results.map((result) => (
              <div key={result.file.path} className="flex items-center gap-2 text-xs">
                {result.status === "success" || result.status === "skipped" ? (
                  <CheckCircle2 size={12} className="text-success shrink-0" />
                ) : result.status === "cancelled" ? (
                  <AlertTriangle size={12} className="text-warning shrink-0" />
                ) : (
                  <XCircle size={12} className="text-danger shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0 text-white/50">
                  {result.file.name}
                </span>
                <span
                  className={`shrink-0 truncate max-w-[140px] ${
                    result.status === "error"
                      ? "text-danger/60"
                      : result.status === "cancelled"
                        ? "text-warning/70"
                        : "text-white/25"
                  }`}
                >
                  {buildStatusLabel(result)}
                </span>
              </div>
            ))}
          </div>
          {successResults.length > 0 && (
            <div className="flex items-center justify-center gap-1 mt-2 text-[10px] text-white/15">
              <GripVertical size={10} />
              <span>拖拽到其他应用</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          {firstOutputDir && (
            <button
              onClick={() => revealInFinder(firstOutputDir)}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
            >
              <FolderOpen size={15} />
              在 Finder 中显示
            </button>
          )}
          {failedResults.length > 0 && lastRunContext && (
            <button
              onClick={() => {
                void retryFailedItems();
              }}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-danger/10 text-danger text-sm font-medium hover:bg-danger/20 transition-colors cursor-pointer"
            >
              <RotateCcw size={15} />
              重试失败项
            </button>
          )}
          {cancelledResults.length > 0 && lastRunContext && (
            <button
              onClick={() => {
                void continueRemainingItems();
              }}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-warning/10 text-warning text-sm font-medium hover:bg-warning/20 transition-colors cursor-pointer"
            >
              <RotateCcw size={15} />
              继续剩余项
            </button>
          )}
        </div>

        <button
          onClick={onReset}
          className="no-drag mt-4 flex items-center gap-1.5 mx-auto text-xs text-white/30 hover:text-white/50 transition-colors cursor-pointer"
        >
          <RotateCcw size={12} />
          处理新文件
        </button>
      </div>
    </div>
  );
}
