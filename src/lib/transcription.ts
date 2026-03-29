import { getFileInfo } from "./commands";
import type { FileInfo, RuntimeInfo } from "./types";

export const TRANSCRIPTION_MODELS = ["base", "small", "medium"] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

export const TRANSCRIPTION_MODEL_OPTIONS = [
  { value: "base", label: "base" },
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
] as const;

export const TRANSCRIPTION_LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动检测" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
] as const;
export type TranscriptionLanguage =
  (typeof TRANSCRIPTION_LANGUAGE_OPTIONS)[number]["value"];

export type ModelImportState =
  | "idle"
  | "importing"
  | "refreshing"
  | "success"
  | "stale";

export interface TranscriptionPreferences {
  preferredModel: TranscriptionModel;
  preferredLanguage: TranscriptionLanguage;
  preferMixedLanguageMode: boolean;
}

export interface ResolvedTranscriptionModel {
  selectedModel: TranscriptionModel;
  effectiveModel: TranscriptionModel | null;
  isPreferredInstalled: boolean;
}

const STORAGE_KEY = "forph.transcriptionPreferences.v2";
const LEGACY_STORAGE_KEY = "forph.transcriptionPreferences.v1";

const DEFAULT_PREFERENCES: TranscriptionPreferences = {
  preferredModel: "small",
  preferredLanguage: "auto",
  preferMixedLanguageMode: false,
};

interface LegacyTranscriptionPreferences {
  preferredModel?: string;
  preferredLanguage?: string;
  preferSegmentedAutoDetection?: boolean;
}

function isTranscriptionModel(value: string): value is TranscriptionModel {
  return (TRANSCRIPTION_MODELS as readonly string[]).includes(value);
}

function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.some((option) => option.value === value);
}

export function loadTranscriptionPreferences(): TranscriptionPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFERENCES;
    }

    const parsed = JSON.parse(raw) as
      | Partial<TranscriptionPreferences>
      | LegacyTranscriptionPreferences;
    const storedModel = parsed.preferredModel;
    const storedLanguage = parsed.preferredLanguage;
    const storedMixedLanguageMode =
      "preferMixedLanguageMode" in parsed
        ? parsed.preferMixedLanguageMode
        : undefined;
    const preferredModel = isTranscriptionModel(storedModel ?? "")
      ? (storedModel as TranscriptionModel)
      : DEFAULT_PREFERENCES.preferredModel;
    const preferredLanguage = isTranscriptionLanguage(storedLanguage ?? "")
      ? (storedLanguage as TranscriptionLanguage)
      : DEFAULT_PREFERENCES.preferredLanguage;
    return {
      preferredModel,
      preferredLanguage,
      preferMixedLanguageMode:
        typeof storedMixedLanguageMode === "boolean"
          ? storedMixedLanguageMode
          : DEFAULT_PREFERENCES.preferMixedLanguageMode,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveTranscriptionPreferences(
  preferences: TranscriptionPreferences,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore storage write failures in private browsing or restricted envs.
  }
}

export function modelFileName(model: TranscriptionModel): string {
  return `ggml-${model}.bin`;
}

export function modelDownloadUrl(model: TranscriptionModel): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName(model)}?download=true`;
}

export function isModelAvailable(
  runtime: RuntimeInfo | null | undefined,
  model: TranscriptionModel,
): boolean {
  if (!runtime) {
    return false;
  }

  if (model === "base" && runtime.base_model_available) {
    return true;
  }

  return runtime.available_models.includes(model);
}

export function resolveEffectiveTranscriptionModel(
  runtime: RuntimeInfo | null | undefined,
  preferredModel: TranscriptionModel,
): ResolvedTranscriptionModel {
  if (isModelAvailable(runtime, preferredModel)) {
    return {
      selectedModel: preferredModel,
      effectiveModel: preferredModel,
      isPreferredInstalled: true,
    };
  }

  for (const candidate of ["small", "base", "medium"] as const) {
    if (isModelAvailable(runtime, candidate)) {
      return {
        selectedModel: preferredModel,
        effectiveModel: candidate,
        isPreferredInstalled: false,
      };
    }
  }

  return {
    selectedModel: preferredModel,
    effectiveModel: null,
    isPreferredInstalled: false,
  };
}

export function buildTranscriptionModelHint(
  selectedModel: TranscriptionModel,
  effectiveModel: TranscriptionModel | null,
): string | null {
  if (!effectiveModel) {
    return `当前还没有可用模型。建议先下载并导入 ${selectedModel}。`;
  }

  if (effectiveModel !== selectedModel) {
    return `当前未安装 ${selectedModel}，已临时使用 ${effectiveModel}。建议补上 ${selectedModel} 以匹配你的偏好。`;
  }

  if (effectiveModel === "base") {
    return "base 更轻更快，但在混合语种和复杂口音场景下会明显弱于 small。";
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isExpectedModelReady(
  file: FileInfo,
  expectedModel: TranscriptionModel,
): boolean {
  const runtime = file.runtime;
  if (!runtime) {
    return false;
  }

  if (expectedModel === "base" && runtime.base_model_available) {
    return true;
  }

  return runtime.available_models.includes(expectedModel);
}

export async function waitForModelAvailability(
  sourcePath: string,
  expectedModel: TranscriptionModel,
  options?: {
    attempts?: number;
    delayMs?: number;
    shouldContinue?: () => boolean;
  },
): Promise<{ status: "ready" | "stale"; file: FileInfo | null }> {
  const attempts = options?.attempts ?? 8;
  const delayMs = options?.delayMs ?? 250;
  const shouldContinue = options?.shouldContinue ?? (() => true);
  let lastFile: FileInfo | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!shouldContinue()) {
      return { status: "stale", file: lastFile };
    }

    try {
      const nextFile = await getFileInfo(sourcePath);
      lastFile = nextFile;

      if (isExpectedModelReady(nextFile, expectedModel)) {
        return { status: "ready", file: nextFile };
      }
    } catch {
      // Keep retrying: the source file is valid, but runtime refresh may still be settling.
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  return { status: "stale", file: lastFile };
}
