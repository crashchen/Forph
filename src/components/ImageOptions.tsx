import { useState } from "react";

interface ImageOptionsProps {
  outputFormat: string;
  onConvert: (quality?: number) => void;
}

export function ImageOptions({ outputFormat, onConvert }: ImageOptionsProps) {
  const [quality, setQuality] = useState(85);
  const isLossless = outputFormat === "png";
  const formatLabel = outputFormat.toUpperCase();

  return (
    <div className="animate-fade-up mt-4 glass p-4 rounded-xl space-y-4">
      {!isLossless ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/45">
              {formatLabel} 质量
            </span>
            <span className="text-xs font-mono text-white/50">{quality}</span>
          </div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="no-drag w-full accent-accent"
          />
          <div className="flex justify-between text-[10px] text-white/25">
            <span>小体积</span>
            <span>高画质</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-white/35">
          PNG 是无损格式，不支持质量调节。
        </p>
      )}

      <button
        onClick={() => onConvert(isLossless ? undefined : quality)}
        className="no-drag w-full py-2.5 rounded-xl bg-accent/20 text-accent text-sm font-semibold hover:bg-accent/30 transition-colors cursor-pointer"
      >
        转为 {formatLabel}
      </button>
    </div>
  );
}
