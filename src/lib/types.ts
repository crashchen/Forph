export interface FileInfo {
  name: string;
  path: string;
  extension: string;
  size: number;
  file_type: "image" | "video" | "audio" | "markdown" | "unknown";
  actions: FileAction[];
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

export type AppView =
  | { stage: "idle" }
  | { stage: "actions"; file: FileInfo }
  | { stage: "converting"; file: FileInfo; actionId: string }
  | { stage: "done"; file: FileInfo; result: ConversionResult }
  | { stage: "error"; file: FileInfo; error: string };
