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
import type { BatchFileResult, BatchImportSummary, FileAction, FileInfo } from "../lib/types";
import {
  getDragIcon,
  getFileInfo,
  importDownloadedModel,
  installDependency,
  revealInFinder,
} from "../lib/commands";
import { getErrorMessage } from "../lib/errors";
import { getBatchActions } from "../lib/actions";
import { BatchProgressView } from "./batch/BatchProgressView";
import { BatchResultView } from "./batch/BatchResultView";
import { BatchSelectionView } from "./batch/BatchSelectionView";
import {
  batchPanelReducer,
  createInitialBatchState,
  type BatchActionOptions,
  type InstallableDependency,
} from "./batch/batchState";
import { useBatchRunner } from "./batch/useBatchRunner";
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
  pdf: "份 PDF",
};

const TRANSCRIPTION_ACTION_IDS = new Set<ActionId>([
  ACTION_IDS.VID_TRANSCRIBE,
  ACTION_IDS.AUD_TRANSCRIBE,
  ACTION_IDS.VID_TRANSCRIBE_SRT,
  ACTION_IDS.AUD_TRANSCRIBE_SRT,
  ACTION_IDS.VID_TRANSCRIBE_VTT,
  ACTION_IDS.AUD_TRANSCRIBE_VTT,
]);

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
      return "已取消 / 未执行";
    case "running":
      return "处理中";
    default:
      return "待处理";
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
  const isMountedRef = useRef(true);
  const modelRefreshRequestIdRef = useRef(0);
  const previousFileIdentityRef = useRef<string | null>(null);
  const fileIdentity = useMemo(
    () => files.map((file) => file.path).join("\n"),
    [files],
  );

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

  const {
    startBatch,
    retryFailedItems,
    continueRemainingItems,
    requestStop,
  } = useBatchRunner({
    files,
    state,
    dispatch,
    mergeActionOptions,
  });

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
        onRequestStop={requestStop}
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
