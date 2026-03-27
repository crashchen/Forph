import { useState, useCallback } from "react";
import {
  Image,
  FileText,
  Video,
  Music,
  X,
  AlertTriangle,
} from "lucide-react";
import type { FileInfo, FileAction, ConversionResult } from "../lib/types";
import {
  convertImage,
  exportMarkdown,
  videoToGif,
  extractAudio,
  transcribeAudio,
} from "../lib/commands";

interface FileActionsProps {
  file: FileInfo;
  isDragOver: boolean;
  onConversionStart: (actionId: string) => void;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// GIF options panel
function GifOptions({
  onConvert,
}: {
  onConvert: (fps: number, width: number, duration: number) => void;
}) {
  const [fps, setFps] = useState(15);
  const [width, setWidth] = useState(480);
  const [duration, setDuration] = useState(5);

  return (
    <div className="animate-fade-up mt-4 glass p-4 rounded-xl space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">帧率</span>
        <div className="flex gap-1.5">
          {[10, 15, 24].map((v) => (
            <button
              key={v}
              onClick={() => setFps(v)}
              className={`no-drag px-2.5 py-1 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                fps === v
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {v}fps
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">宽度</span>
        <div className="flex gap-1.5">
          {[320, 480, 720].map((v) => (
            <button
              key={v}
              onClick={() => setWidth(v)}
              className={`no-drag px-2.5 py-1 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                width === v
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {v}p
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">时长</span>
        <div className="flex gap-1.5">
          {[3, 5, 10, 15].map((v) => (
            <button
              key={v}
              onClick={() => setDuration(v)}
              className={`no-drag px-2.5 py-1 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                duration === v
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {v}s
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={() => onConvert(fps, width, duration)}
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
  onResult,
  onError,
  onReset,
}: FileActionsProps) {
  const [showGifOptions, setShowGifOptions] = useState(false);
  const Icon = typeIcons[file.file_type] || FileText;

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
        } else if (action.id === "vid_mp3") {
          result = await extractAudio(file.path, "mp3");
        } else if (action.id === "vid_transcribe" || action.id === "aud_transcribe") {
          result = await transcribeAudio(file.path, "base");
        } else if (action.id === "aud_mp3") {
          result = await extractAudio(file.path, "mp3");
        } else if (action.id === "aud_wav") {
          result = await extractAudio(file.path, "wav");
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

  const handleGifConvert = useCallback(
    async (fps: number, width: number, duration: number) => {
      onConversionStart("vid_gif");
      try {
        const result = await videoToGif(file.path, fps, width, 0, duration);
        onResult(result);
      } catch (e: any) {
        onError(typeof e === "string" ? e : e.message || "GIF 转换失败");
      }
    },
    [file, onConversionStart, onResult, onError],
  );

  // Group actions
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
      className={`animate-fade-up w-full max-w-lg transition-opacity ${isDragOver ? "opacity-30" : ""}`}
    >
      {/* File info card */}
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
          </div>
          <button
            onClick={onReset}
            className="no-drag p-2 rounded-lg hover:bg-surface-hover text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Action groups */}
      {Object.entries(groups).map(([group, actions]) => (
        <div key={group} className="mb-3">
          <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2 px-1">
            {group}
          </p>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => {
              if (action.id === "vid_gif") {
                return (
                  <button
                    key={action.id}
                    onClick={() => setShowGifOptions(!showGifOptions)}
                    className="no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium text-white/70 hover:text-white/90 transition-all cursor-pointer"
                  >
                    {action.label}
                  </button>
                );
              }
              return (
                <button
                  key={action.id}
                  onClick={() => executeAction(action)}
                  className="no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium text-white/70 hover:text-white/90 transition-all cursor-pointer"
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* GIF options */}
      {showGifOptions && <GifOptions onConvert={handleGifConvert} />}

      {/* Dependency warning for certain file types */}
      {(file.file_type === "video" || file.file_type === "audio") && (
        <div className="mt-4 flex items-start gap-2.5 px-1">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <p className="text-[11px] text-white/35 leading-relaxed">
            视频/音频功能需要 FFmpeg。转写文字需要 whisper-cpp。
            <br />
            安装：
            <code className="text-accent/60 text-[10px]">
              brew install ffmpeg whisper-cpp
            </code>
          </p>
        </div>
      )}

      {/* Drop hint */}
      <p className="text-center text-xs text-white/20 mt-6">
        拖入新文件可重新开始
      </p>
    </div>
  );
}
