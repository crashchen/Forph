import { useState, useCallback, useEffect, useRef } from "react";
import { FileText, Image, Music, Video, X } from "lucide-react";
import type {
  FileAction,
  FileInfo,
  ConversionResult,
  MediaInfo,
} from "../lib/types";
import {
  compressVideo,
  convertImage,
  exportMarkdown,
  extractAudio,
  getFileInfo,
  installDependency,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";
import { formatSize, formatDuration } from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import {
  actionUsesRealtimeProgress,
  getActionDisabledReason,
} from "../lib/actions";
import { GifOptions } from "./GifOptions";
import { CompressOptions } from "./CompressOptions";
import { ImageOptions } from "./ImageOptions";
import { DependencySection, type InstallableDependency } from "./DependencySection";

interface FileActionsProps {
  file: FileInfo;
  isDragOver: boolean;
  onConversionStart: (actionId: string, jobId?: string) => void;
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

function createJobId(actionId: string, filePath: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = filePath.split("/").pop() ?? "file";
  return `${actionId}:${name}:${suffix}`;
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
  const [showCompressOptions, setShowCompressOptions] = useState(false);
  const [imageOutputFormat, setImageOutputFormat] = useState<string | null>(null);
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
    setShowCompressOptions(false);
    setImageOutputFormat(null);
    setInstallingDependency(null);
    setDependencyMessage(null);
    setDependencyError(null);
  }, [file.path]);

  const executeAction = useCallback(
    async (action: FileAction) => {
      const jobId = actionUsesRealtimeProgress(action.id)
        ? createJobId(action.id, file.path)
        : undefined;
      onConversionStart(action.id, jobId);
      try {
        let result: ConversionResult;

        if (action.id === "md_html") {
          result = await exportMarkdown(file.path);
        } else if (action.id === "vid_mp3" || action.id === "aud_mp3") {
          result = await extractAudio(file.path, "mp3", jobId);
        } else if (action.id === "vid_wav" || action.id === "aud_wav") {
          result = await extractAudio(file.path, "wav", jobId);
        } else if (
          action.id === "vid_transcribe" ||
          action.id === "aud_transcribe"
        ) {
          result = await transcribeAudio(file.path, "base", undefined, undefined, jobId);
        } else if (
          action.id === "vid_transcribe_srt" ||
          action.id === "aud_transcribe_srt"
        ) {
          result = await transcribeAudio(file.path, "base", undefined, "srt", jobId);
        } else if (
          action.id === "vid_transcribe_vtt" ||
          action.id === "aud_transcribe_vtt"
        ) {
          result = await transcribeAudio(file.path, "base", undefined, "vtt", jobId);
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

  const handleImageConvert = useCallback(
    async (quality?: number) => {
      if (!imageOutputFormat) return;
      const actionId = `img_${imageOutputFormat}`;
      onConversionStart(actionId);
      try {
        const result = await convertImage(file.path, imageOutputFormat, quality);
        onResult(result);
      } catch (error) {
        onError(getErrorMessage(error, "图片转换失败"));
      }
    },
    [file, imageOutputFormat, onConversionStart, onResult, onError],
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

  const handleCompress = useCallback(
    async (quality: string, maxResolution?: string) => {
      const jobId = createJobId("vid_compress", file.path);
      onConversionStart("vid_compress", jobId);
      try {
        const result = await compressVideo(file.path, quality, maxResolution, jobId);
        onResult(result);
      } catch (error) {
        onError(getErrorMessage(error, "视频压缩失败"));
      }
    },
    [file, onConversionStart, onResult, onError],
  );

  const handleGifConvert = useCallback(
    async (
      fps: number,
      width: number,
      startTime: number,
      duration: number,
    ) => {
      const jobId = createJobId("vid_gif", file.path);
      onConversionStart("vid_gif", jobId);
      try {
        const result = await videoToGif(
          file.path,
          fps,
          width,
          startTime,
          duration,
          jobId,
        );
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

              const hasOptionsPanel =
                action.id === "vid_gif" ||
                action.id === "vid_compress" ||
                action.id.startsWith("img_");

              if (hasOptionsPanel) {
                const togglePanel = () => {
                  if (action.id === "vid_gif") {
                    setShowGifOptions((v) => !v);
                    setShowCompressOptions(false);
                    setImageOutputFormat(null);
                  } else if (action.id === "vid_compress") {
                    setShowCompressOptions((v) => !v);
                    setShowGifOptions(false);
                    setImageOutputFormat(null);
                  } else {
                    const fmt = action.id.replace("img_", "");
                    setImageOutputFormat((v) => (v === fmt ? null : fmt));
                    setShowGifOptions(false);
                    setShowCompressOptions(false);
                  }
                };
                return (
                  <button
                    key={action.id}
                    title={disabledReason ?? action.label}
                    disabled={disabled}
                    onClick={togglePanel}
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
      {showCompressOptions && <CompressOptions file={file} onCompress={handleCompress} />}
      {imageOutputFormat && (
        <ImageOptions
          outputFormat={imageOutputFormat}
          onConvert={handleImageConvert}
        />
      )}

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
