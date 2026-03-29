import type { ActionId, ImageOutputFormat } from "../../lib/actionIds";
import type {
  BatchFileResult,
  ConversionProgressEvent,
  FileInfo,
} from "../../lib/types";
import type {
  ModelImportState,
  TranscriptionLanguage,
  TranscriptionModel,
} from "../../lib/transcription";

export type InstallableDependency = "ffmpeg" | "whisper-cpp";

export interface BatchActionOptions {
  gifFps?: number;
  gifWidth?: number;
  gifStartTime?: number;
  gifDuration?: number;
  compressQuality?: string;
  compressMaxResolution?: string;
  imageQuality?: number;
  transcriptionModel?: TranscriptionModel;
  transcriptionLanguage?: TranscriptionLanguage;
  transcriptionMixedLanguageMode?: boolean;
}

export interface BatchRunContext {
  actionId: ActionId;
  options?: BatchActionOptions;
}

export type BatchOptionsPanel =
  | null
  | { kind: "gif" }
  | { kind: "compress" }
  | { kind: "image"; format: ImageOutputFormat };

export interface BatchProgressState {
  currentIndex: number | null;
  currentJobId: string | null;
  currentFileProgress: number | null;
  currentProgressIndeterminate: boolean;
  currentMessage: string;
  currentStage: string | null;
  currentSeconds: number | null;
  totalSeconds: number | null;
}

export interface BatchDependencyState {
  installingDependency: InstallableDependency | null;
  modelImportState: ModelImportState;
  message: string | null;
  error: string | null;
}

export interface BatchPanelState {
  phase: "selecting" | "converting" | "done";
  completionState: "completed" | "stopped";
  results: BatchFileResult[];
  progress: BatchProgressState;
  optionsPanel: BatchOptionsPanel;
  dependency: BatchDependencyState;
  lastRunContext: BatchRunContext | null;
  stopRequested: boolean;
}

const defaultProgressState = (): BatchProgressState => ({
  currentIndex: null,
  currentJobId: null,
  currentFileProgress: null,
  currentProgressIndeterminate: true,
  currentMessage: "准备开始处理...",
  currentStage: null,
  currentSeconds: null,
  totalSeconds: null,
});

const defaultDependencyState = (): BatchDependencyState => ({
  installingDependency: null,
  modelImportState: "idle",
  message: null,
  error: null,
});

export function buildInitialResults(files: FileInfo[]): BatchFileResult[] {
  return files.map((file) => ({
    file,
    status: "pending",
  }));
}

export function createInitialBatchState(files: FileInfo[]): BatchPanelState {
  return {
    phase: "selecting",
    completionState: "completed",
    results: buildInitialResults(files),
    progress: defaultProgressState(),
    optionsPanel: null,
    dependency: defaultDependencyState(),
    lastRunContext: null,
    stopRequested: false,
  };
}

type BatchPanelAction =
  | { type: "resetForFiles"; files: FileInfo[] }
  | { type: "toggleGifOptions" }
  | { type: "toggleCompressOptions" }
  | { type: "toggleImageOptions"; format: ImageOutputFormat }
  | { type: "runStarted"; context: BatchRunContext }
  | { type: "resultsReplaced"; results: BatchFileResult[] }
  | { type: "fileStarted"; index: number; jobId: string | null }
  | { type: "progressReceived"; event: ConversionProgressEvent }
  | { type: "fileFinished"; results: BatchFileResult[] }
  | { type: "runCompleted"; results: BatchFileResult[]; stopped: boolean }
  | { type: "dependencyInstallStarted"; dependency: InstallableDependency }
  | { type: "modelImportStarted" }
  | { type: "modelRefreshStarted"; message: string }
  | { type: "modelRefreshCompleted"; state: Exclude<ModelImportState, "importing">; message?: string | null; error?: string | null }
  | { type: "dependencyInstallFinished"; message?: string | null; error?: string | null }
  | { type: "stopRequested" };

export function batchPanelReducer(
  state: BatchPanelState,
  action: BatchPanelAction,
): BatchPanelState {
  switch (action.type) {
    case "resetForFiles":
      return createInitialBatchState(action.files);

    case "toggleGifOptions":
      return {
        ...state,
        optionsPanel: state.optionsPanel?.kind === "gif" ? null : { kind: "gif" },
      };

    case "toggleCompressOptions":
      return {
        ...state,
        optionsPanel:
          state.optionsPanel?.kind === "compress" ? null : { kind: "compress" },
      };

    case "toggleImageOptions":
      return {
        ...state,
        optionsPanel:
          state.optionsPanel?.kind === "image" &&
          state.optionsPanel.format === action.format
            ? null
            : { kind: "image", format: action.format },
      };

    case "runStarted":
      return {
        ...state,
        phase: "converting",
        completionState: "completed",
        progress: defaultProgressState(),
        optionsPanel: null,
        lastRunContext: action.context,
        stopRequested: false,
      };

    case "resultsReplaced":
      return {
        ...state,
        results: action.results,
      };

    case "fileStarted":
      return {
        ...state,
        progress: {
          currentIndex: action.index,
          currentJobId: action.jobId,
          currentFileProgress: action.jobId ? 0 : null,
          currentProgressIndeterminate: action.jobId !== null,
          currentMessage: "正在处理当前文件...",
          currentStage: null,
          currentSeconds: null,
          totalSeconds: null,
        },
      };

    case "progressReceived":
      return {
        ...state,
        progress: {
          ...state.progress,
          currentFileProgress: action.event.percent ?? null,
          currentProgressIndeterminate: action.event.indeterminate,
          currentMessage: action.event.message ?? state.progress.currentMessage,
          currentStage: action.event.stage,
          currentSeconds: action.event.currentSeconds ?? null,
          totalSeconds: action.event.totalSeconds ?? null,
        },
      };

    case "fileFinished":
      return {
        ...state,
        results: action.results,
        progress: defaultProgressState(),
      };

    case "runCompleted":
      return {
        ...state,
        phase: "done",
        completionState: action.stopped ? "stopped" : "completed",
        results: action.results,
        progress: {
          ...defaultProgressState(),
          currentMessage: action.stopped
            ? "已按你的要求在当前文件后停止，剩余项未执行。"
            : "全部处理完成。",
        },
        stopRequested: false,
      };

    case "dependencyInstallStarted":
      return {
        ...state,
        dependency: {
          installingDependency: action.dependency,
          modelImportState: "idle",
          message: null,
          error: null,
        },
      };

    case "modelImportStarted":
      return {
        ...state,
        dependency: {
          installingDependency: null,
          modelImportState: "importing",
          message: null,
          error: null,
        },
      };

    case "modelRefreshStarted":
      return {
        ...state,
        dependency: {
          installingDependency: null,
          modelImportState: "refreshing",
          message: action.message,
          error: null,
        },
      };

    case "modelRefreshCompleted":
      return {
        ...state,
        dependency: {
          installingDependency: null,
          modelImportState: action.state,
          message: action.message ?? null,
          error: action.error ?? null,
        },
      };

    case "dependencyInstallFinished":
      return {
        ...state,
        dependency: {
          installingDependency: null,
          modelImportState: "idle",
          message: action.message ?? null,
          error: action.error ?? null,
        },
      };

    case "stopRequested":
      return {
        ...state,
        stopRequested: true,
      };
  }
}
