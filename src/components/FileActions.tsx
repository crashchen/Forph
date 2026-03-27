import { useState, useCallback, useEffect } from "react";
import {
  AlertTriangle,
  Download,
  FileText,
  FolderOpen,
  Image,
  Music,
  Video,
  X,
} from "lucide-react";
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
  openTarget,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";

interface FileActionsProps {
  file: FileInfo;
  isDragOver: boolean;
  onConversionStart: (actionId: string) => void;
  onFileRefreshed: (file: FileInfo) => void;
  onResult: (result: ConversionResult) => void;
  onError: (error: string) => void;
  onReset: () => void;
}

type InstallableDependency = "ffmpeg" | "whisper-cpp";

const MODEL_DOWNLOAD_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true";
const HOMEBREW_URL = "https://brew.sh";
const GIF_FILE_SIZE_WARNING_BYTES = 50 * 1024 * 1024;

const typeIcons: Record<string, typeof Image> = {
  image: Image,
  markdown: FileText,
  video: Video,
  audio: Music,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds?: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

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

function needsFfmpegForTranscription(file: FileInfo): boolean {
  if (file.file_type === "video") {
    return true;
  }

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
    if (needsFfmpegForTranscription(file) && !runtime.ffmpeg_available) {
      return "当前文件转写前需要 FFmpeg 预处理";
    }
    if (action.id === "vid_transcribe" && media?.has_audio === false) {
      return "这个视频里没有可转写的音轨";
    }
    return null;
  }

  return null;
}

function buildGifWarnings(file: FileInfo): string[] {
  const warnings: string[] = [];
  const media = file.media;

  if ((media?.duration_seconds ?? 0) > 15) {
    warnings.push("这个视频超过 15 秒，更适合先截取 3-10 秒的小片段再转 GIF。");
  }
  if (file.size > GIF_FILE_SIZE_WARNING_BYTES) {
    warnings.push("源文件已经超过 50MB，导出的 GIF 很可能会明显偏大。");
  }
  if ((media?.video_width ?? 0) > 1920 || (media?.video_height ?? 0) > 1080) {
    warnings.push("源视频分辨率超过 1080p，建议先降宽度再导出 GIF。");
  }

  return warnings;
}

function GifOptions({
  file,
  onConvert,
}: {
  file: FileInfo;
  onConvert: (
    fps: number,
    width: number,
    startTime: number,
    duration: number,
  ) => void;
}) {
  const [fps, setFps] = useState(15);
  const [width, setWidth] = useState(480);
  const [startTime, setStartTime] = useState(0);
  const [duration, setDuration] = useState(5);
  const warnings = buildGifWarnings(file);
  const totalDuration = file.media?.duration_seconds ?? null;

  const safeStart = Math.max(0, startTime);
  const remaining = totalDuration ? Math.max(0.2, totalDuration - safeStart) : 10;
  const safeDuration = Math.min(Math.max(1, duration), Math.min(10, remaining));
  const endTime = safeStart + safeDuration;

  return (
    <div className="animate-fade-up mt-4 glass p-4 rounded-xl space-y-4">
      {warnings.length > 0 && (
        <div className="no-drag rounded-xl border border-warning/20 bg-warning-dim px-4 py-3 text-left">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-white/78">GIF 更适合短片段</p>
              {warnings.map((warning) => (
                <p key={warning} className="text-xs leading-relaxed text-white/48">
                  {warning}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-left">
          <span className="text-xs text-white/45">开始时间</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={startTime}
            onChange={(event) => setStartTime(Number(event.target.value) || 0)}
            className="no-drag w-full rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm text-white/80 outline-none transition-colors focus:border-accent/40"
          />
        </label>
        <label className="space-y-1 text-left">
          <span className="text-xs text-white/45">持续时长</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value) || 1)}
            className="no-drag w-full rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm text-white/80 outline-none transition-colors focus:border-accent/40"
          />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">帧率</span>
        <div className="flex gap-1.5">
          {[10, 15, 24].map((value) => (
            <button
              key={value}
              onClick={() => setFps(value)}
              className={`no-drag px-2.5 py-1 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                fps === value
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {value}fps
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">宽度</span>
        <div className="flex gap-1.5">
          {[320, 480, 720].map((value) => (
            <button
              key={value}
              onClick={() => setWidth(value)}
              className={`no-drag px-2.5 py-1 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                width === value
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {value}w
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-left">
        <p className="text-xs text-white/40">
          预览
          <span className="ml-2 text-white/65">
            {safeStart.toFixed(1)}s - {endTime.toFixed(1)}s
          </span>
        </p>
        {totalDuration && (
          <p className="mt-1 text-[11px] text-white/30">
            原视频时长 {formatDuration(totalDuration)}
          </p>
        )}
      </div>

      <button
        onClick={() => onConvert(fps, width, safeStart, safeDuration)}
        className="no-drag w-full py-2.5 rounded-xl bg-accent/20 text-accent text-sm font-semibold hover:bg-accent/30 transition-colors cursor-pointer"
      >
        开始转换
      </button>
    </div>
  );
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

  useEffect(() => {
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
      } catch (e: any) {
        onError(typeof e === "string" ? e : e.message || "转换失败");
      }
    },
    [file, onConversionStart, onResult, onError],
  );

  const handleDependencyInstall = useCallback(
    async (packageName: InstallableDependency) => {
      setDependencyMessage(null);
      setDependencyError(null);
      setInstallingDependency(packageName);

      try {
        const result = await installDependency(packageName);
        const refreshedFile = await getFileInfo(file.path);
        onFileRefreshed(refreshedFile);
        setDependencyMessage(`${result.message} 当前文件的可用动作也已经刷新。`);
      } catch (e: any) {
        setDependencyError(typeof e === "string" ? e : e.message || "自动安装失败");
      } finally {
        setInstallingDependency(null);
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
      } catch (e: any) {
        onError(typeof e === "string" ? e : e.message || "GIF 转换失败");
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

      {runtime && !runtime.ffmpeg_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                先装 FFmpeg，媒体转换才会完整可用
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                GIF、音频提取，以及大多数视频 / 音频转写前处理都依赖 FFmpeg。
              </p>
              <div className="flex flex-wrap gap-2">
                {runtime.brew_available ? (
                  <button
                    disabled={installingDependency !== null}
                    onClick={() => handleDependencyInstall("ffmpeg")}
                    className={`no-drag px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                      installingDependency !== null
                        ? "cursor-not-allowed bg-white/6 text-white/28"
                        : "cursor-pointer bg-accent/15 text-accent hover:bg-accent/25"
                    }`}
                  >
                    {installingDependency === "ffmpeg"
                      ? "正在安装 FFmpeg..."
                      : "一键安装 FFmpeg"}
                  </button>
                ) : (
                  <button
                    onClick={() => openTarget(HOMEBREW_URL)}
                    className="no-drag px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                  >
                    安装 Homebrew
                  </button>
                )}
              </div>
              <code className="text-[11px] text-accent/70">
                brew install ffmpeg
              </code>
            </div>
          </div>
        </div>
      )}

      {runtime && !runtime.whisper_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                先装 whisper-cpp，才能离线转写
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                当前转写按钮已经先帮你收住了，装好之后我会立刻帮你重新检测当前文件。
              </p>
              <div className="flex flex-wrap gap-2">
                {runtime.brew_available ? (
                  <button
                    disabled={installingDependency !== null}
                    onClick={() => handleDependencyInstall("whisper-cpp")}
                    className={`no-drag px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                      installingDependency !== null
                        ? "cursor-not-allowed bg-white/6 text-white/28"
                        : "cursor-pointer bg-accent/15 text-accent hover:bg-accent/25"
                    }`}
                  >
                    {installingDependency === "whisper-cpp"
                      ? "正在安装 whisper-cpp..."
                      : "一键安装 whisper-cpp"}
                  </button>
                ) : (
                  <button
                    onClick={() => openTarget(HOMEBREW_URL)}
                    className="no-drag px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                  >
                    安装 Homebrew
                  </button>
                )}
              </div>
              <code className="text-[11px] text-accent/70">
                brew install whisper-cpp
              </code>
            </div>
          </div>
        </div>
      )}

      {(dependencyMessage || dependencyError) && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={16}
              className={`shrink-0 mt-0.5 ${
                dependencyError ? "text-warning" : "text-success"
              }`}
            />
            <div className="space-y-1">
              <p className="text-sm font-medium text-white/78">
                {dependencyError ? "安装助手遇到了一点阻塞" : "安装助手已完成当前步骤"}
              </p>
              <p
                className={`text-xs leading-relaxed ${
                  dependencyError ? "text-white/42" : "text-white/55"
                }`}
              >
                {dependencyError ?? dependencyMessage}
              </p>
            </div>
          </div>
        </div>
      )}

      {runtime?.whisper_available && !runtime.base_model_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                离线转写还差一个 `ggml-base.bin` 模型
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                下载官方 whisper.cpp 的 `base` 模型后，放进模型文件夹就能直接开始转写。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openTarget(MODEL_DOWNLOAD_URL)}
                  className="no-drag flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                >
                  <Download size={14} />
                  下载 base 模型
                </button>
                {runtime.model_directory && (
                  <button
                    onClick={() =>
                      openTarget(runtime.model_directory!, {
                        ensureDirectory: true,
                      })
                    }
                    className="no-drag flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-hover text-white/70 text-sm font-medium hover:bg-surface-active transition-colors cursor-pointer"
                  >
                    <FolderOpen size={14} />
                    打开模型文件夹
                  </button>
                )}
              </div>
              {runtime.model_directory && (
                <p className="text-[11px] text-white/28 font-mono break-all">
                  {runtime.model_directory}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {runtime && runtime.legacy_model_directories.length > 0 && (
        <div className="mt-4 px-1">
          <p className="text-[11px] text-white/30 leading-relaxed">
            旧模型目录仍会被兼容读取，你可以等确认新目录可用后再手动清理旧缓存。
          </p>
          <p className="text-[10px] text-white/18 font-mono mt-1 break-all">
            {runtime.legacy_model_directories.join("  ·  ")}
          </p>
        </div>
      )}

      {runtime && runtime.available_models.length > 0 && (
        <p className="text-[11px] text-white/22 mt-4 px-1">
          已发现模型：{runtime.available_models.join(", ")}
        </p>
      )}

      <p className="text-center text-xs text-white/20 mt-6">
        可以重新拖入别的文件，或者点右上角关闭当前文件
      </p>
    </div>
  );
}
