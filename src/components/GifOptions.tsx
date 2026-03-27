import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { FileInfo } from "../lib/types";
import { formatDuration } from "../lib/format";

const GIF_FILE_SIZE_WARNING_BYTES = 50 * 1024 * 1024;

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

interface GifOptionsProps {
  file: FileInfo;
  onConvert: (
    fps: number,
    width: number,
    startTime: number,
    duration: number,
  ) => void;
}

export function GifOptions({ file, onConvert }: GifOptionsProps) {
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
