import { invoke } from "@tauri-apps/api/core";
import type { FileInfo, ConversionResult } from "./types";

export async function getFileInfo(path: string): Promise<FileInfo> {
  return invoke("get_file_info", { path });
}

export async function convertImage(
  inputPath: string,
  outputFormat: string,
): Promise<ConversionResult> {
  return invoke("convert_image", {
    inputPath,
    outputFormat,
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
): Promise<ConversionResult> {
  return invoke("video_to_gif", {
    inputPath,
    fps,
    width,
    startTime: startTime ?? null,
    duration: duration ?? null,
  });
}

export async function extractAudio(
  inputPath: string,
  outputFormat: string,
): Promise<ConversionResult> {
  return invoke("extract_audio", { inputPath, outputFormat });
}

export async function transcribeAudio(
  inputPath: string,
  modelSize: string,
  language?: string,
): Promise<ConversionResult> {
  return invoke("transcribe_audio", {
    inputPath,
    modelSize,
    language: language ?? null,
  });
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
