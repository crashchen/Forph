import { useState } from "react";
import type { FileInfo } from "../lib/types";

const QUALITY_PRESETS = [
  { value: "high", label: "高画质", crf: "CRF 18" },
  { value: "balanced", label: "均衡", crf: "CRF 23" },
  { value: "small", label: "小体积", crf: "CRF 28" },
  { value: "tiny", label: "极限压缩", crf: "CRF 35" },
] as const;

const RESOLUTION_PRESETS = [
  { value: null, label: "原始" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
] as const;

interface CompressOptionsProps {
  file: FileInfo;
  onCompress: (quality: string, maxResolution?: string) => void;
}

export function CompressOptions({ file, onCompress }: CompressOptionsProps) {
  const [quality, setQuality] = useState("balanced");
  const [resolution, setResolution] = useState<string | null>(null);
  const media = file.media;

  return (
    <div className="animate-fade-up mt-4 glass p-4 rounded-xl space-y-4">
      {media?.video_width && media?.video_height && (
        <p className="text-xs text-white/35">
          当前分辨率 {media.video_width}×{media.video_height}
        </p>
      )}

      <div className="space-y-1.5">
        <span className="text-xs text-white/45">画质</span>
        <div className="flex gap-1.5">
          {QUALITY_PRESETS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => setQuality(preset.value)}
              className={`no-drag px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                quality === preset.value
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-white/45">最大分辨率</span>
        <div className="flex gap-1.5">
          {RESOLUTION_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => setResolution(preset.value)}
              className={`no-drag px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                resolution === preset.value
                  ? "bg-accent-dim text-accent"
                  : "bg-surface-hover text-white/50 hover:text-white/70"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => onCompress(quality, resolution ?? undefined)}
        className="no-drag w-full py-2.5 rounded-xl bg-accent/20 text-accent text-sm font-semibold hover:bg-accent/30 transition-colors cursor-pointer"
      >
        开始压缩
      </button>
    </div>
  );
}
