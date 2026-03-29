import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  FileText,
  Image,
  Music,
  Video,
  type LucideIcon,
} from "lucide-react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  ACTION_IDS,
  imageActionIdFromOutputFormat,
  imageOutputFormatFromActionId,
  isImageActionId,
  type ActionId,
} from "../lib/actionIds";
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
  importDownloadedModel,
  installDependency,
  listenConversionProgress,
  revealInFinder,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";
import { getErrorMessage } from "../lib/errors";
import {
  actionUsesRealtimeProgress,
  getBatchActions,
  shouldSkipBatchAction,
} from "../lib/actions";
import { BatchProgressView } from "./batch/BatchProgressView";
import { BatchResultView } from "./batch/BatchResultView";
import { BatchSelectionView } from "./batch/BatchSelectionView";
import {
  batchPanelReducer,
  buildInitialResults,
  createInitialBatchState,
  type BatchActionOptions,
  type BatchRunContext,
  type InstallableDependency,
} from "./batch/batchState";
import { formatSize } from "../lib/format";
import {
  loadTranscriptionPreferences,
  modelFileName,
  resolveEffectiveTranscriptionModel,
  saveTranscriptionPreferences,
  waitForModelAvailability,
  type TranscriptionLanguage,
  type TranscriptionModel,
} from "../lib/transcription";

interface BatchPanelProps {
  files: FileInfo[];
  importSummary: BatchImportSummary;
  isDragOver: boolean;
  onFilesRefreshed: (files: FileInfo[]) => void;
  onReset: () => void;
}

const typeIcons: Record<string, LucideIcon> = {
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

const TRANSCRIPTION_ACTION_IDS = new Set<ActionId>([
  ACTION_IDS.VID_TRANSCRIBE,
  ACTION_IDS.AUD_TRANSCRIBE,
  ACTION_IDS.VID_TRANSCRIBE_SRT,
  ACTION_IDS.AUD_TRANSCRIBE_SRT,
  ACTION_IDS.VID_TRANSCRIBE_VTT,
  ACTION_IDS.AUD_TRANSCRIBE_VTT,
]);

function createJobId(actionId: ActionId, filePath: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = filePath.split("/").pop() ?? "file";
  return `${actionId}:${name}:${suffix}`;
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
  actionId: ActionId,
  opts?: BatchActionOptions,
  jobId?: string,
) {
  switch (actionId) {
    case ACTION_IDS.IMG_JPG:
    case ACTION_IDS.IMG_PNG:
    case ACTION_IDS.IMG_WEBP:
      return convertImage(
        file.path,
        imageOutputFormatFromActionId(actionId),
        opts?.imageQuality,
      );
    case ACTION_IDS.MD_HTML:
      return exportMarkdown(file.path);
    case ACTION_IDS.VID_GIF:
      return videoToGif(
        file.path,
        opts?.gifFps ?? 15,
        opts?.gifWidth ?? 480,
        opts?.gifStartTime,
        opts?.gifDuration,
        jobId,
      );
    case ACTION_IDS.VID_COMPRESS:
      return compressVideo(
        file.path,
        opts?.compressQuality ?? "balanced",
        opts?.compressMaxResolution,
        jobId,
      );
    case ACTION_IDS.VID_MP3:
    case ACTION_IDS.AUD_MP3:
      return extractAudio(file.path, "mp3", jobId);
    case ACTION_IDS.VID_WAV:
    case ACTION_IDS.AUD_WAV:
      return extractAudio(file.path, "wav", jobId);
    case ACTION_IDS.VID_TRANSCRIBE:
    case ACTION_IDS.AUD_TRANSCRIBE:
      return transcribeAudio(
        file.path,
        opts?.transcriptionModel ?? "base",
        opts?.transcriptionLanguage ?? "auto",
        undefined,
        jobId,
        opts?.transcriptionMixedLanguageMode,
      );
    case ACTION_IDS.VID_TRANSCRIBE_SRT:
    case ACTION_IDS.AUD_TRANSCRIBE_SRT:
      return transcribeAudio(
        file.path,
        opts?.transcriptionModel ?? "base",
        opts?.transcriptionLanguage ?? "auto",
        "srt",
        jobId,
        opts?.transcriptionMixedLanguageMode,
      );
    case ACTION_IDS.VID_TRANSCRIBE_VTT:
    case ACTION_IDS.AUD_TRANSCRIBE_VTT:
      return transcribeAudio(
        file.path,
        opts?.transcriptionModel ?? "base",
        opts?.transcriptionLanguage ?? "auto",
        "vtt",
        jobId,
        opts?.transcriptionMixedLanguageMode,
      );
  }
}

export function BatchPanel({
  files,
  importSummary,
  isDragOver,
  onFilesRefreshed,
  onReset,
}: BatchPanelProps) {
  const [state, dispatch] = useReducer(batchPanelReducer, files, createInitialBatchState);
  const [preferredModel, setPreferredModel] = useState<TranscriptionModel>(
    () => loadTranscriptionPreferences().preferredModel,
  );
  const [preferredLanguage, setPreferredLanguage] = useState<TranscriptionLanguage>(
    () => loadTranscriptionPreferences().preferredLanguage,
  );
  const [preferMixedLanguageMode, setPreferMixedLanguageMode] =
    useState<boolean>(() => loadTranscriptionPreferences().preferMixedLanguageMode);
  const stopAfterCurrentRef = useRef(false);
  const isMountedRef = useRef(true);
  const resultsRef = useRef(state.results);
  const modelRefreshRequestIdRef = useRef(0);
  const previousFileIdentityRef = useRef<string | null>(null);
  const fileIdentity = useMemo(
    () => files.map((file) => file.path).join("\n"),
    [files],
  );

  useEffect(() => {
    resultsRef.current = state.results;
  }, [state.results]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousFileIdentityRef.current === fileIdentity) {
      return;
    }

    previousFileIdentityRef.current = fileIdentity;
    dispatch({ type: "resetForFiles", files });
    stopAfterCurrentRef.current = false;
  }, [fileIdentity, files]);

  useEffect(() => {
    saveTranscriptionPreferences({
      preferredModel,
      preferredLanguage,
      preferMixedLanguageMode,
    });
  }, [preferMixedLanguageMode, preferredLanguage, preferredModel]);

  useEffect(() => {
    dispatch({ type: "modelRefreshCompleted", state: "idle" });
    modelRefreshRequestIdRef.current += 1;
  }, [preferredModel]);

  useEffect(() => {
    if (!state.progress.currentJobId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenConversionProgress((event: ConversionProgressEvent) => {
      if (
        disposed ||
        !state.progress.currentJobId ||
        event.jobId !== state.progress.currentJobId
      ) {
        return;
      }

      dispatch({ type: "progressReceived", event });
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
  }, [state.progress.currentJobId]);

  const fileType = files[0]?.file_type ?? "unknown";
  const runtime = files[0]?.runtime;
  const resolvedModel = useMemo(
    () => resolveEffectiveTranscriptionModel(runtime, preferredModel),
    [runtime, preferredModel],
  );
  const effectiveModel = resolvedModel.effectiveModel;
  const Icon = typeIcons[fileType] ?? FileText;
  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );
  const importWarnings = useMemo(
    () => formatImportWarnings(importSummary),
    [importSummary],
  );
  const groupedActions = useMemo(
    () =>
      Object.entries(
        getBatchActions(files).reduce<Record<string, FileAction[]>>((acc, action) => {
          if (!acc[action.group]) {
            acc[action.group] = [];
          }
          acc[action.group].push(action);
          return acc;
        }, {}),
      ),
    [files],
  );

  const buildTranscriptionOptions = useCallback(
    (): Pick<
      BatchActionOptions,
      "transcriptionModel" | "transcriptionLanguage" | "transcriptionMixedLanguageMode"
    > => ({
      transcriptionModel: effectiveModel ?? preferredModel,
      transcriptionLanguage: preferredLanguage,
      transcriptionMixedLanguageMode: preferMixedLanguageMode,
    }),
    [effectiveModel, preferMixedLanguageMode, preferredLanguage, preferredModel],
  );

  const mergeActionOptions = useCallback(
    (actionId: ActionId, options?: BatchActionOptions): BatchActionOptions | undefined => {
      if (!TRANSCRIPTION_ACTION_IDS.has(actionId)) {
        return options;
      }

      return {
        ...options,
        ...buildTranscriptionOptions(),
      };
    },
    [buildTranscriptionOptions],
  );

  const executeBatch = useCallback(
    async (
      context: BatchRunContext,
      selectedIndices: number[],
      mode: "all" | "partial",
    ) => {
      if (selectedIndices.length === 0) {
        return;
      }

      dispatch({ type: "runStarted", context });
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
        dispatch({ type: "resultsReplaced", results: [...nextResults] });
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
            dispatch({ type: "resultsReplaced", results: [...nextResults] });
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
          dispatch({ type: "resultsReplaced", results: [...nextResults] });
          dispatch({ type: "fileStarted", index, jobId: jobId ?? null });
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

        dispatch({ type: "fileFinished", results: [...nextResults] });
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
        dispatch({
          type: "runCompleted",
          results: [...nextResults],
          stopped,
        });
      }
    },
    [files],
  );

  const startBatch = useCallback(
    async (actionId: ActionId, options?: BatchActionOptions) => {
      const selectedIndices = files.map((_, index) => index);
      await executeBatch(
        { actionId, options: mergeActionOptions(actionId, options) },
        selectedIndices,
        "all",
      );
    },
    [executeBatch, files, mergeActionOptions],
  );

  const retryFailedItems = useCallback(async () => {
    if (!state.lastRunContext) {
      return;
    }

    const failedIndices = resultsRef.current
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "error")
      .map(({ index }) => index);

    await executeBatch(state.lastRunContext, failedIndices, "partial");
  }, [executeBatch, state.lastRunContext]);

  const continueRemainingItems = useCallback(async () => {
    if (!state.lastRunContext) {
      return;
    }

    const cancelledIndices = resultsRef.current
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "cancelled")
      .map(({ index }) => index);

    await executeBatch(state.lastRunContext, cancelledIndices, "partial");
  }, [executeBatch, state.lastRunContext]);

  const refreshBatchFilesForModel = useCallback(
    async (
      expectedModel: TranscriptionModel,
      messagePrefix: string,
    ): Promise<"ready" | "stale"> => {
      const firstFile = files[0];
      if (!firstFile) {
        return "stale";
      }
      const requestId = modelRefreshRequestIdRef.current + 1;
      modelRefreshRequestIdRef.current = requestId;

      dispatch({
        type: "modelRefreshStarted",
        message: `${messagePrefix} 正在刷新模型状态...`,
      });

      const refreshResult = await waitForModelAvailability(firstFile.path, expectedModel, {
        attempts: 8,
        delayMs: 250,
        shouldContinue: () =>
          isMountedRef.current && modelRefreshRequestIdRef.current === requestId,
      });

      if (!isMountedRef.current || modelRefreshRequestIdRef.current !== requestId) {
        return "stale";
      }

      const refreshedSettled = await Promise.allSettled(
        files.map((file) => getFileInfo(file.path)),
      );
      if (!isMountedRef.current || modelRefreshRequestIdRef.current !== requestId) {
        return "stale";
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

      if (refreshResult.status === "ready") {
        dispatch({
          type: "modelRefreshCompleted",
          state: "success",
          message:
            refreshFailures > 0
              ? `${modelFileName(expectedModel)} 已就绪，已刷新 ${files.length - refreshFailures} 个文件，${refreshFailures} 个保留原状态。`
              : `${modelFileName(expectedModel)} 已就绪，文件列表已刷新。`,
        });
        return "ready";
      }

      dispatch({
        type: "modelRefreshCompleted",
        state: "stale",
        message: `${modelFileName(expectedModel)} 已复制到模型目录，但当前还没完成识别。可以点“重新检测模型”再试一次。`,
      });
      return "stale";
    },
    [files, onFilesRefreshed],
  );

  const handleDependencyInstall = useCallback(
    async (packageName: InstallableDependency) => {
      dispatch({ type: "dependencyInstallStarted", dependency: packageName });

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
        dispatch({
          type: "dependencyInstallFinished",
          message:
            refreshFailures > 0
              ? `${result.message} 已刷新 ${files.length - refreshFailures} 个文件，${refreshFailures} 个保留原状态。`
              : `${result.message} 文件列表已刷新。`,
        });
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }

        dispatch({
          type: "dependencyInstallFinished",
          error: getErrorMessage(error, "自动安装失败"),
        });
      }
    },
    [files, onFilesRefreshed],
  );

  const handleModelImport = useCallback(async () => {
    dispatch({ type: "modelImportStarted" });

    try {
      const result = await importDownloadedModel(preferredModel);
      if (!isMountedRef.current) {
        return;
      }

      await refreshBatchFilesForModel(preferredModel, result.message);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      dispatch({
        type: "modelRefreshCompleted",
        state: "idle",
        error: getErrorMessage(error, "自动导入模型失败"),
      });
    }
  }, [preferredModel, refreshBatchFilesForModel]);

  const handleRetryModelDetection = useCallback(async () => {
    await refreshBatchFilesForModel(
      preferredModel,
      `正在重新检测 ${modelFileName(preferredModel)}。`,
    );
  }, [preferredModel, refreshBatchFilesForModel]);

  const handleDragAllOut = useCallback(async () => {
    const paths = state.results
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
  }, [state.results]);

  const handleToggleActionPanel = useCallback((action: FileAction) => {
    if (action.id === ACTION_IDS.VID_GIF) {
      dispatch({ type: "toggleGifOptions" });
      return;
    }

    if (action.id === ACTION_IDS.VID_COMPRESS) {
      dispatch({ type: "toggleCompressOptions" });
      return;
    }

    if (isImageActionId(action.id)) {
      dispatch({
        type: "toggleImageOptions",
        format: imageOutputFormatFromActionId(action.id),
      });
    }
  }, []);

  const handleImageConvert = useCallback(
    async (quality?: number) => {
      if (state.optionsPanel?.kind !== "image") {
        return;
      }

      await startBatch(imageActionIdFromOutputFormat(state.optionsPanel.format), {
        imageQuality: quality,
      });
    },
    [startBatch, state.optionsPanel],
  );

  const handleRequestStop = useCallback(() => {
    stopAfterCurrentRef.current = true;
    dispatch({ type: "stopRequested" });
  }, []);

  if (state.phase === "selecting") {
    return (
      <BatchSelectionView
        files={files}
        fileTypeLabel={typeLabels[fileType] || "个文件"}
        Icon={Icon}
        totalSize={totalSize}
        importWarnings={importWarnings}
        groupedActions={groupedActions}
        runtime={runtime}
        isDragOver={isDragOver}
        state={state}
        onReset={onReset}
        onToggleActionPanel={handleToggleActionPanel}
        onRunAction={(actionId) => {
          void startBatch(actionId);
        }}
        onGifConvert={(fps, width, startTime, duration) => {
          void startBatch(ACTION_IDS.VID_GIF, {
            gifFps: fps,
            gifWidth: width,
            gifStartTime: startTime,
            gifDuration: duration,
          });
        }}
        onCompress={(quality, maxResolution) => {
          void startBatch(ACTION_IDS.VID_COMPRESS, {
            compressQuality: quality,
            compressMaxResolution: maxResolution,
          });
        }}
        onImageConvert={(quality) => {
          void handleImageConvert(quality);
        }}
        onInstallDependency={(pkg) => {
          void handleDependencyInstall(pkg);
        }}
        onImportDownloadedModel={() => {
          void handleModelImport();
        }}
        onRetryModelDetection={() => {
          void handleRetryModelDetection();
        }}
        selectedModel={preferredModel}
        effectiveModel={effectiveModel}
        selectedLanguage={preferredLanguage}
        preferMixedLanguageMode={preferMixedLanguageMode}
        onModelChange={setPreferredModel}
        onLanguageChange={setPreferredLanguage}
        onMixedLanguageModeChange={setPreferMixedLanguageMode}
      />
    );
  }

  if (state.phase === "converting") {
    return (
      <BatchProgressView
        files={files}
        results={state.results}
        progress={state.progress}
        stopRequested={state.stopRequested}
        buildStatusLabel={buildStatusLabel}
        onRequestStop={handleRequestStop}
      />
    );
  }

  return (
    <BatchResultView
      results={state.results}
      totalSize={totalSize}
      completionState={state.completionState}
      buildStatusLabel={buildStatusLabel}
      onRevealOutputDir={revealInFinder}
      onRetryFailedItems={() => {
        void retryFailedItems();
      }}
      onContinueRemainingItems={() => {
        void continueRemainingItems();
      }}
      onDragAllOut={() => {
        void handleDragAllOut();
      }}
      onReset={onReset}
      hasLastRunContext={state.lastRunContext !== null}
    />
  );
}
