export interface FileInfo {
  name: string;
  path: string;
  extension: string;
  size: number;
  file_type: "image" | "video" | "audio" | "markdown" | "unknown";
  actions: FileAction[];
  media?: MediaInfo | null;
  runtime?: RuntimeInfo | null;
}

export interface FileAction {
  id: string;
  label: string;
  group: string;
}

export interface ConversionResult {
  output_path: string;
  output_size: number;
  message: string;
}

export interface MediaInfo {
  duration_seconds?: number | null;
  video_width?: number | null;
  video_height?: number | null;
  has_audio: boolean;
  audio_sample_rate_hz?: number | null;
}

export interface RuntimeInfo {
  brew_available: boolean;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  whisper_available: boolean;
  available_models: string[];
  model_directory?: string | null;
  legacy_model_directories: string[];
  base_model_available: boolean;
  base_model_path?: string | null;
  using_legacy_model_directory: boolean;
}

export interface DependencyInstallResult {
  package_name: string;
  message: string;
}

export type AppView =
  | { stage: "idle" }
  | { stage: "actions"; file: FileInfo }
  | { stage: "converting"; file: FileInfo; actionId: string }
  | { stage: "done"; file: FileInfo; result: ConversionResult }
  | { stage: "error"; file: FileInfo; error: string };
