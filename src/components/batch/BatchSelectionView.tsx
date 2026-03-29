import { AlertTriangle, type LucideIcon, X } from "lucide-react";
import type { FileAction, FileInfo, RuntimeInfo } from "../../lib/types";
import {
  ACTION_IDS,
  type ActionId,
} from "../../lib/actionIds";
import { getBatchActionDisabledReason } from "../../lib/actions";
import { formatSize } from "../../lib/format";
import { GifOptions } from "../GifOptions";
import { CompressOptions } from "../CompressOptions";
import { ImageOptions } from "../ImageOptions";
import { DependencySection } from "../DependencySection";
import { TranscriptionPreferences } from "../TranscriptionPreferences";
import type {
  BatchPanelState,
  InstallableDependency,
} from "./batchState";
import type {
  TranscriptionLanguage,
  TranscriptionModel,
} from "../../lib/transcription";

interface BatchSelectionViewProps {
  files: FileInfo[];
  fileTypeLabel: string;
  Icon: LucideIcon;
  totalSize: number;
  importWarnings: string[];
  groupedActions: Array<[string, FileAction[]]>;
  runtime?: RuntimeInfo | null;
  isDragOver: boolean;
  state: BatchPanelState;
  onReset: () => void;
  onToggleActionPanel: (action: FileAction) => void;
  onRunAction: (actionId: ActionId) => void;
  onGifConvert: (
    fps: number,
    width: number,
    startTime: number,
    duration: number,
  ) => void;
  onCompress: (quality: string, maxResolution?: string) => void;
  onImageConvert: (quality?: number) => void;
  onInstallDependency: (pkg: InstallableDependency) => void;
  onImportDownloadedModel: () => void;
  onRetryModelDetection: () => void;
  selectedModel: TranscriptionModel;
  effectiveModel: TranscriptionModel | null;
  selectedLanguage: TranscriptionLanguage;
  preferMixedLanguageMode: boolean;
  onModelChange: (model: TranscriptionModel) => void;
  onLanguageChange: (language: TranscriptionLanguage) => void;
  onMixedLanguageModeChange: (enabled: boolean) => void;
}

export function BatchSelectionView({
  files,
  fileTypeLabel,
  Icon,
  totalSize,
  importWarnings,
  groupedActions,
  runtime,
  isDragOver,
  state,
  onReset,
  onToggleActionPanel,
  onRunAction,
  onGifConvert,
  onCompress,
  onImageConvert,
  onInstallDependency,
  onImportDownloadedModel,
  onRetryModelDetection,
  selectedModel,
  effectiveModel,
  selectedLanguage,
  preferMixedLanguageMode,
  onModelChange,
  onLanguageChange,
  onMixedLanguageModeChange,
}: BatchSelectionViewProps) {
  const currentFile = files[0];
  const imageOutputFormat =
    state.optionsPanel?.kind === "image" ? state.optionsPanel.format : null;

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
              {files.length} {fileTypeLabel}
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

      {groupedActions.map(([group, actions]) => (
        <div key={group} className="mb-3">
          <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2 px-1">
            {group}
          </p>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => {
              const disabledReason = getBatchActionDisabledReason(files, action);
              const disabled = Boolean(disabledReason);
              const hasOptionsPanel =
                action.id === ACTION_IDS.VID_GIF ||
                action.id === ACTION_IDS.VID_COMPRESS ||
                action.id === ACTION_IDS.IMG_JPG ||
                action.id === ACTION_IDS.IMG_PNG ||
                action.id === ACTION_IDS.IMG_WEBP;

              return (
                <button
                  key={action.id}
                  title={disabledReason ?? action.label}
                  disabled={disabled}
                  onClick={() => {
                    if (hasOptionsPanel) {
                      onToggleActionPanel(action);
                      return;
                    }

                    onRunAction(action.id);
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

      {state.optionsPanel?.kind === "gif" && currentFile && (
        <GifOptions file={currentFile} onConvert={onGifConvert} />
      )}
      {state.optionsPanel?.kind === "compress" && currentFile && (
        <CompressOptions file={currentFile} onCompress={onCompress} />
      )}
      {imageOutputFormat && (
        <ImageOptions
          outputFormat={imageOutputFormat}
          onConvert={onImageConvert}
        />
      )}

      {runtime && currentFile?.file_type !== "image" && currentFile?.file_type !== "markdown" && (
        <TranscriptionPreferences
          runtime={runtime}
          selectedModel={selectedModel}
          effectiveModel={effectiveModel}
          selectedLanguage={selectedLanguage}
          preferMixedLanguageMode={preferMixedLanguageMode}
          onModelChange={onModelChange}
          onLanguageChange={onLanguageChange}
          onMixedLanguageModeChange={onMixedLanguageModeChange}
        />
      )}

      {runtime && (
        <DependencySection
          runtime={runtime}
          installingDependency={state.dependency.installingDependency}
          modelImportState={state.dependency.modelImportState}
          selectedModel={selectedModel}
          effectiveModel={effectiveModel}
          dependencyMessage={state.dependency.message}
          dependencyError={state.dependency.error}
          onInstallDependency={onInstallDependency}
          onImportDownloadedModel={onImportDownloadedModel}
          onRetryModelDetection={onRetryModelDetection}
        />
      )}

      <p className="text-center text-xs text-white/20 mt-6">
        选择操作后会按当前顺序批量处理 {files.length} 个文件
      </p>
    </div>
  );
}
