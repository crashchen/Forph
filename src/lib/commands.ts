import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConversionResult,
  ConversionProgressEvent,
  DependencyInstallResult,
  FileInfo,
} from "./types";

export const CONVERSION_PROGRESS_EVENT = "forph://conversion-progress";

export async function listenConversionProgress(
  handler: (payload: ConversionProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ConversionProgressEvent>(CONVERSION_PROGRESS_EVENT, (event) => {
    handler(event.payload);
  });
}

export async function getFileInfo(path: string): Promise<FileInfo> {
  return invoke("get_file_info", { path });
}

export async function convertImage(
  inputPath: string,
  outputFormat: string,
  quality?: number,
): Promise<ConversionResult> {
  return invoke("convert_image", {
    inputPath,
    outputFormat,
    quality: quality ?? null,
  });
}

export async function exportMarkdown(
  inputPath: string,
): Promise<ConversionResult> {
  return invoke("export_markdown", { inputPath });
}

export async function videoToGif(
  inputPath: string,
  fps: number,
  width: number,
  startTime?: number,
  duration?: number,
  jobId?: string,
): Promise<ConversionResult> {
  return invoke("video_to_gif", {
    inputPath,
    fps,
    width,
    startTime: startTime ?? null,
    duration: duration ?? null,
    jobId: jobId ?? null,
  });
}

export async function extractAudio(
  inputPath: string,
  outputFormat: string,
  jobId?: string,
): Promise<ConversionResult> {
  return invoke("extract_audio", {
    inputPath,
    outputFormat,
    jobId: jobId ?? null,
  });
}

export async function compressVideo(
  inputPath: string,
  quality: string,
  maxResolution?: string,
  jobId?: string,
): Promise<ConversionResult> {
  return invoke("compress_video", {
    inputPath,
    quality,
    maxResolution: maxResolution ?? null,
    jobId: jobId ?? null,
  });
}

export async function transcribeAudio(
  inputPath: string,
  modelSize: string,
  language?: string,
  outputFormat?: string,
  jobId?: string,
): Promise<ConversionResult> {
  return invoke("transcribe_audio", {
    inputPath,
    modelSize,
    language: language ?? null,
    outputFormat: outputFormat ?? null,
    jobId: jobId ?? null,
  });
}

export async function installDependency(
  packageName: "ffmpeg" | "whisper-cpp",
): Promise<DependencyInstallResult> {
  return invoke("install_dependency", { packageName });
}

export async function getDragIcon(): Promise<string> {
  return invoke("get_drag_icon");
}

export async function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export async function openTarget(
  target: string,
  options?: { ensureDirectory?: boolean },
): Promise<void> {
  return invoke("open_target", {
    target,
    ensureDirectory: options?.ensureDirectory ?? null,
  });
}
