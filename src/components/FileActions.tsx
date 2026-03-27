import { useState, useCallback, useEffect, useRef } from "react";
import { FileText, Image, Music, Video, X } from "lucide-react";
import type {
  FileAction,
  FileInfo,
  ConversionResult,
  MediaInfo,
} from "../lib/types";
import {
  convertImage,
  exportMarkdown,
  extractAudio,
  getFileInfo,
  installDependency,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";
import { formatSize } from "../lib/format";
import { formatDuration } from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import { GifOptions } from "./GifOptions";
import { DependencySection, type InstallableDependency } from "./DependencySection";

interface FileActionsProps {
  file: FileInfo;
  isDragOver: boolean;
  onConversionStart: (actionId: string) => void;
  onFileRefreshed: (sourcePath: string, file: FileInfo) => void;
  onResult: (result: ConversionResult) => void;
  onError: (error: string) => void;
  onReset: () => void;
}

const typeIcons: Record<string, typeof Image> = {
  image: Image,
  markdown: FileText,
  video: Video,
  audio: Music,
};

function formatMediaSummary(fileType: FileInfo["file_type"], media?: MediaInfo | null) {
  if (!media) return null;

  const parts: string[] = [];
  const duration = formatDuration(media.duration_seconds);
  if (duration) parts.push(duration);

  if (fileType === "video") {
    if (media.video_width && media.video_height) {
      parts.push(`${media.video_width}×${media.video_height}`);
    }
    parts.push(media.has_audio ? "含音轨" : "无音轨");
  }

  if (fileType === "audio" && media.audio_sample_rate_hz) {
    parts.push(`${(media.audio_sample_rate_hz / 1000).toFixed(1)}kHz`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

function requiresFfmpegForTranscription(file: FileInfo): boolean {
  if (file.file_type === "video") return true;
  return file.extension.toLowerCase() !== "wav";
}

function getActionDisabledReason(file: FileInfo, action: FileAction): string | null {
  const runtime = file.runtime;
  const media = file.media;

  if (!runtime) {
    return null;
  }

  if (action.id === "vid_gif") {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (action.id === "vid_mp3" || action.id === "vid_wav") {
    if (!runtime.ffmpeg_available) {
      return "需要先安装 FFmpeg";
    }
    if (media?.has_audio === false) {
      return "这个视频里没有可提取的音轨";
    }
    return null;
  }

  if (action.id === "aud_mp3" || action.id === "aud_wav") {
    return runtime.ffmpeg_available ? null : "需要先安装 FFmpeg";
  }

  if (action.id === "vid_transcribe" || action.id === "aud_transcribe") {
    if (!runtime.whisper_available) {
      return "需要先安装 whisper-cpp";
    }
    if (!runtime.base_model_available) {
      return "缺少 ggml-base.bin 模型";
    }
    if (requiresFfmpegForTranscription(file) && !runtime.ffmpeg_available) {
      return "当前文件转写前需要 FFmpeg 预处理";
    }
    if (action.id === "vid_transcribe" && media?.has_audio === false) {
      return "这个视频里没有可转写的音轨";
    }
    return null;
  }

  return null;
}

export function FileActions({
  file,
  isDragOver,
  onConversionStart,
  onFileRefreshed,
  onResult,
  onError,
  onReset,
}: FileActionsProps) {
  const [showGifOptions, setShowGifOptions] = useState(false);
  const [installingDependency, setInstallingDependency] =
    useState<InstallableDependency | null>(null);
  const [dependencyMessage, setDependencyMessage] = useState<string | null>(null);
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const Icon = typeIcons[file.file_type] || FileText;
  const runtime = file.runtime;
  const mediaSummary = formatMediaSummary(file.file_type, file.media);
  const activeFilePathRef = useRef(file.path);
  const installRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeFilePathRef.current = file.path;
    installRequestIdRef.current += 1;
    setShowGifOptions(false);
    setInstallingDependency(null);
    setDependencyMessage(null);
    setDependencyError(null);
  }, [file.path]);

  const executeAction = useCallback(
    async (action: FileAction) => {
      onConversionStart(action.id);
      try {
        let result: ConversionResult;

        if (action.id.startsWith("img_")) {
          const fmt = action.id.replace("img_", "");
          result = await convertImage(file.path, fmt);
        } else if (action.id === "md_html") {
          result = await exportMarkdown(file.path);
        } else if (action.id === "vid_mp3" || action.id === "aud_mp3") {
          result = await extractAudio(file.path, "mp3");
        } else if (action.id === "vid_wav" || action.id === "aud_wav") {
          result = await extractAudio(file.path, "wav");
        } else if (
          action.id === "vid_transcribe" ||
          action.id === "aud_transcribe"
        ) {
          result = await transcribeAudio(file.path, "base");
        } else {
          throw new Error(`未知操作: ${action.id}`);
        }
        onResult(result);
      } catch (error) {
        onError(getErrorMessage(error, "转换失败"));
      }
    },
    [file, onConversionStart, onResult, onError],
  );

  const handleDependencyInstall = useCallback(
    async (packageName: InstallableDependency) => {
      const sourcePath = file.path;
      const requestId = installRequestIdRef.current + 1;
      installRequestIdRef.current = requestId;
      setDependencyMessage(null);
      setDependencyError(null);
      setInstallingDependency(packageName);

      try {
        const result = await installDependency(packageName);
        if (
          !isMountedRef.current ||
          installRequestIdRef.current !== requestId ||
          activeFilePathRef.current !== sourcePath
        ) {
          return;
        }

        const refreshedFile = await getFileInfo(sourcePath);
        if (
          !isMountedRef.current ||
          installRequestIdRef.current !== requestId ||
          activeFilePathRef.current !== sourcePath
        ) {
          return;
        }

        onFileRefreshed(sourcePath, refreshedFile);
        setDependencyMessage(`${result.message} 当前文件的可用动作也已经刷新。`);
      } catch (error) {
        if (
          !isMountedRef.current ||
          installRequestIdRef.current !== requestId ||
          activeFilePathRef.current !== sourcePath
        ) {
          return;
        }

        setDependencyError(getErrorMessage(error, "自动安装失败"));
      } finally {
        if (
          isMountedRef.current &&
          installRequestIdRef.current === requestId &&
          activeFilePathRef.current === sourcePath
        ) {
          setInstallingDependency(null);
        }
      }
    },
    [file.path, onFileRefreshed],
  );

  const handleGifConvert = useCallback(
    async (
      fps: number,
      width: number,
      startTime: number,
      duration: number,
    ) => {
      onConversionStart("vid_gif");
      try {
        const result = await videoToGif(file.path, fps, width, startTime, duration);
        onResult(result);
      } catch (error) {
        onError(getErrorMessage(error, "GIF 转换失败"));
      }
    },
    [file, onConversionStart, onResult, onError],
  );

  const groups = file.actions.reduce(
    (acc, action) => {
      if (!acc[action.group]) acc[action.group] = [];
      acc[action.group].push(action);
      return acc;
    },
    {} as Record<string, FileAction[]>,
  );

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
            <h3 className="text-sm font-semibold text-white/90 truncate">
              {file.name}
            </h3>
            <p className="text-xs text-white/40 mt-0.5">
              {file.extension.toUpperCase()} &middot; {formatSize(file.size)}
            </p>
            {mediaSummary && (
              <p className="text-xs text-white/30 mt-1">{mediaSummary}</p>
            )}
          </div>
          <button
            onClick={onReset}
            className="no-drag p-2 rounded-lg hover:bg-surface-hover text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {Object.entries(groups).map(([group, actions]) => (
        <div key={group} className="mb-3">
          <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2 px-1">
            {group}
          </p>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => {
              const disabledReason = getActionDisabledReason(file, action);
              const disabled = Boolean(disabledReason);

              if (action.id === "vid_gif") {
                return (
                  <button
                    key={action.id}
                    title={disabledReason ?? action.label}
                    disabled={disabled}
                    onClick={() => setShowGifOptions((value) => !value)}
                    className={`no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                      disabled
                        ? "cursor-not-allowed text-white/28 border-white/6 hover:bg-transparent"
                        : "cursor-pointer text-white/70 hover:text-white/90"
                    }`}
                  >
                    {action.label}
                  </button>
                );
              }

              return (
                <button
                  key={action.id}
                  title={disabledReason ?? action.label}
                  disabled={disabled}
                  onClick={() => executeAction(action)}
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

      {showGifOptions && <GifOptions file={file} onConvert={handleGifConvert} />}

      {runtime && (
        <DependencySection
          runtime={runtime}
          installingDependency={installingDependency}
          dependencyMessage={dependencyMessage}
          dependencyError={dependencyError}
          onInstallDependency={handleDependencyInstall}
        />
      )}

      <p className="text-center text-xs text-white/20 mt-6">
        可以重新拖入别的文件，或者点右上角关闭当前文件
      </p>
    </div>
  );
}
