import type { RuntimeInfo } from "../lib/types";
import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  TRANSCRIPTION_MODEL_OPTIONS,
  buildTranscriptionModelHint,
  type TranscriptionLanguage,
  type TranscriptionModel,
} from "../lib/transcription";

interface TranscriptionPreferencesProps {
  runtime: RuntimeInfo;
  selectedModel: TranscriptionModel;
  effectiveModel: TranscriptionModel | null;
  selectedLanguage: TranscriptionLanguage;
  preferMixedLanguageMode: boolean;
  onModelChange: (model: TranscriptionModel) => void;
  onLanguageChange: (language: TranscriptionLanguage) => void;
  onMixedLanguageModeChange: (enabled: boolean) => void;
}

export function TranscriptionPreferences({
  runtime,
  selectedModel,
  effectiveModel,
  selectedLanguage,
  preferMixedLanguageMode,
  onModelChange,
  onLanguageChange,
  onMixedLanguageModeChange,
}: TranscriptionPreferencesProps) {
  const hint = buildTranscriptionModelHint(selectedModel, effectiveModel);

  return (
    <div className="mt-4 glass p-4 rounded-2xl text-left">
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-white/78">转写偏好</p>
          <p className="text-xs text-white/42 mt-1 leading-relaxed">
            默认推荐 `small + 自动检测`。混合语种模式默认关闭，只在长音频多语切换时再打开。
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-white/45">模型</span>
          <div className="flex flex-wrap gap-1.5">
            {TRANSCRIPTION_MODEL_OPTIONS.map((option) => {
              const installed =
                option.value === "base"
                  ? runtime.base_model_available
                  : runtime.available_models.includes(option.value);
              const isSelected = selectedModel === option.value;
              const isEffective = effectiveModel === option.value;

              return (
                <button
                  key={option.value}
                  onClick={() => onModelChange(option.value)}
                  className={`no-drag px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-accent-dim text-accent"
                      : "bg-surface-hover text-white/55 hover:text-white/75"
                  }`}
                >
                  {option.label}
                  {installed ? " · 已装" : ""}
                  {!isSelected && isEffective ? " · 当前" : ""}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-white/45">语言</span>
          <div className="flex flex-wrap gap-1.5">
            {TRANSCRIPTION_LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => onLanguageChange(option.value)}
                className={`no-drag px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                  selectedLanguage === option.value
                    ? "bg-accent-dim text-accent"
                    : "bg-surface-hover text-white/55 hover:text-white/75"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <span className="text-xs text-white/45">混合语种模式</span>
              <p className="text-[11px] text-white/34 leading-relaxed">
                自动检测时会先按停顿切段，再逐段检测语言并分别转写，更适合中德、中英这类长音频混合语种场景，但会明显更慢。
              </p>
            </div>
            <button
              onClick={() => onMixedLanguageModeChange(!preferMixedLanguageMode)}
              className={`no-drag px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                preferMixedLanguageMode
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/55 hover:text-white/75"
              }`}
            >
              {preferMixedLanguageMode ? "已开启" : "已关闭"}
            </button>
          </div>
          {selectedLanguage !== "auto" && (
            <p className="text-[11px] text-white/30 leading-relaxed">
              当前已手动锁定语言，这个模式会先待命；切回“自动检测”后才会生效。
            </p>
          )}
        </div>

        {hint && (
          <p className="text-[11px] text-white/36 leading-relaxed">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
