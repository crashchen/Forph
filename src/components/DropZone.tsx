import { Upload, Sparkles } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

interface DropZoneProps {
  isDragOver: boolean;
  onFileDrop: (paths: string[]) => void;
}

export function DropZone({ isDragOver, onFileDrop }: DropZoneProps) {
  const handleBrowse = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Supported Files",
          extensions: [
            "jpg", "jpeg", "png", "webp", "heic", "heif", "bmp", "tiff", "tif",
            "md", "markdown", "mdown",
            "mp4", "mov", "avi", "mkv", "webm", "m4v",
            "mp3", "wav", "m4a", "aac", "ogg", "flac", "wma",
          ],
        },
      ],
    });
    if (typeof selected === "string") {
      onFileDrop([selected]);
    } else if (Array.isArray(selected) && selected.length > 0) {
      onFileDrop(selected);
    }
  };

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div
        className={`
          no-drag glass relative flex flex-col items-center justify-center
          py-16 px-8 rounded-2xl cursor-pointer
          border-2 border-dashed transition-all duration-300
          ${
            isDragOver
              ? "drop-active border-accent bg-accent-dim"
              : "border-white/12 hover:border-white/25 hover:bg-surface-hover"
          }
        `}
        onClick={handleBrowse}
      >
        <div
          className={`
            w-16 h-16 rounded-2xl flex items-center justify-center mb-5
            transition-all duration-300
            ${isDragOver ? "bg-accent-dim scale-110" : "bg-surface-hover"}
          `}
        >
          {isDragOver ? (
            <Sparkles size={28} className="text-accent" />
          ) : (
            <Upload size={28} className="text-white/40" />
          )}
        </div>

        <h2
          className={`text-lg font-semibold mb-2 transition-colors ${
            isDragOver ? "text-accent" : "text-white/80"
          }`}
        >
          {isDragOver ? "松手即可处理" : "拖入文件，剩下的交给我"}
        </h2>
        <p className="text-sm text-white/40 mb-6">
          支持图片 / Markdown / 视频 / 音频
        </p>

        <button
          className="no-drag px-5 py-2.5 rounded-xl bg-surface-hover text-white/60 text-sm font-medium hover:bg-surface-active hover:text-white/80 transition-all cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            handleBrowse();
          }}
        >
          浏览文件
        </button>
      </div>

      {/* Supported formats hint */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {["JPG", "PNG", "WEBP", "HEIC", "MD", "MP4", "MP3", "WAV"].map(
          (fmt) => (
            <span
              key={fmt}
              className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-surface text-white/30 tracking-wider"
            >
              {fmt}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
