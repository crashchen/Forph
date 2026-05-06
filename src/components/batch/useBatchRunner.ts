import { useCallback, useEffect, useRef, type Dispatch } from "react";
import {
  ACTION_IDS,
  imageOutputFormatFromActionId,
  type ActionId,
} from "../../lib/actionIds";
import type { ConversionResult, FileInfo } from "../../lib/types";
import {
  cancelJob,
  compressVideo,
  convertImage,
  extractAudio,
  extractPdfText,
  exportMarkdown,
  listenConversionProgress,
  transcribeAudio,
  videoToGif,
} from "../../lib/commands";
import { getErrorMessage } from "../../lib/errors";
import {
  actionUsesRealtimeProgress,
  shouldSkipBatchAction,
} from "../../lib/actions";
import {
  buildInitialResults,
  type BatchActionOptions,
  type BatchPanelAction,
  type BatchPanelState,
  type BatchRunContext,
} from "./batchState";

interface UseBatchRunnerOptions {
  files: FileInfo[];
  state: BatchPanelState;
  dispatch: Dispatch<BatchPanelAction>;
  mergeActionOptions: (
    actionId: ActionId,
    options?: BatchActionOptions,
  ) => BatchActionOptions | undefined;
}

function createJobId(actionId: ActionId, filePath: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = filePath.split("/").pop() ?? "file";
  return `${actionId}:${name}:${suffix}`;
}

function isCancellationMessage(message: string): boolean {
  return message.includes("任务已取消");
}

async function runAction(
  file: FileInfo,
  actionId: ActionId,
  opts?: BatchActionOptions,
  jobId?: string,
): Promise<ConversionResult> {
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
    case ACTION_IDS.PDF_TXT:
      return extractPdfText(file.path, "txt");
    case ACTION_IDS.PDF_MD:
      return extractPdfText(file.path, "md");
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

export function useBatchRunner({
  files,
  state,
  dispatch,
  mergeActionOptions,
}: UseBatchRunnerOptions) {
  const stopAfterCurrentRef = useRef(false);
  const isMountedRef = useRef(true);
  const resultsRef = useRef(state.results);

  useEffect(() => {
    resultsRef.current = state.results;
  }, [state.results]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    stopAfterCurrentRef.current = false;
  }, [files]);

  useEffect(() => {
    if (!state.progress.currentJobId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenConversionProgress((event) => {
      if (
        disposed ||
        !state.progress.currentJobId ||
        event.jobId !== state.progress.currentJobId
      ) {
        return;
      }

      dispatch({ type: "progressReceived", event });
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }

        unlisten = fn;
      })
      .catch((error: unknown) => {
        console.error("Failed to listen for batch conversion progress", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dispatch, state.progress.currentJobId]);

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
          const errorMessage = getErrorMessage(error, "转换失败");
          const cancelled = isCancellationMessage(errorMessage);
          nextResults[index] = {
            file,
            status: cancelled ? "cancelled" : "error",
            error: cancelled ? undefined : errorMessage,
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
    [dispatch, files],
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

  const requestStop = useCallback(() => {
    stopAfterCurrentRef.current = true;
    dispatch({ type: "stopRequested" });
    const currentJobId = state.progress.currentJobId;
    if (currentJobId) {
      void cancelJob(currentJobId).catch((error: unknown) => {
        console.error("Failed to cancel batch job", error);
      });
    }
  }, [dispatch, state.progress.currentJobId]);

  return {
    startBatch,
    retryFailedItems,
    continueRemainingItems,
    requestStop,
  };
}
