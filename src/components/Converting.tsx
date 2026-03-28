import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { FileInfo } from "../lib/types";
import { listenConversionProgress } from "../lib/commands";

interface ConvertingProps {
  file: FileInfo;
  actionId: string;
  jobId?: string;
}

const actionLabels: Record<string, string> = {
  img_jpg: "转换为 JPG",
  img_png: "转换为 PNG",
  img_webp: "转换为 WebP",
  md_html: "导出 HTML",
  vid_gif: "转换为 GIF",
  vid_compress: "压缩视频",
  vid_mp3: "提取音频 (MP3)",
  vid_wav: "提取音频 (WAV)",
  vid_transcribe: "转写文字",
  vid_transcribe_srt: "转写字幕 (SRT)",
  vid_transcribe_vtt: "转写字幕 (VTT)",
  aud_mp3: "转换为 MP3",
  aud_wav: "转换为 WAV",
  aud_transcribe: "转写文字",
  aud_transcribe_srt: "转写字幕 (SRT)",
  aud_transcribe_vtt: "转写字幕 (VTT)",
};

function formatPercent(percent?: number | null): string | null {
  if (percent == null || Number.isNaN(percent)) {
    return null;
  }

  return `${Math.round(percent)}%`;
}

export function Converting({ file, actionId, jobId }: ConvertingProps) {
  const label = actionLabels[actionId] || "处理中";
  const [percent, setPercent] = useState<number | null>(null);
  const [indeterminate, setIndeterminate] = useState(true);
  const [message, setMessage] = useState<string>("请稍候，正在本地处理...");

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenConversionProgress((event) => {
      if (disposed || event.jobId !== jobId || event.filePath !== file.path) {
        return;
      }

      setIndeterminate(event.indeterminate);
      setPercent(event.percent ?? null);
      if (event.message) {
        setMessage(event.message);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [file.path, jobId]);

  const displayPercent = formatPercent(percent);
  const progressWidth = percent != null ? `${Math.max(0, Math.min(100, percent))}%` : "100%";

  return (
    <div className="animate-fade-up text-center max-w-md">
      <div className="glass p-10 rounded-2xl">
        <Loader2 size={40} className="spin-slow text-accent mx-auto mb-5" />
        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {label}...
        </h2>
        <p className="text-sm text-white/40">{file.name}</p>

        <div className="mt-6 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className={`h-full rounded-full ${indeterminate ? "w-full progress-shimmer" : "bg-accent transition-all duration-300"}`}
            style={indeterminate ? undefined : { width: progressWidth }}
          />
        </div>

        <p className="text-xs text-white/25 mt-4">
          {message}
        </p>
        {displayPercent && (
          <p className="text-xs text-white/35 mt-1 font-mono">{displayPercent}</p>
        )}
      </div>
    </div>
  );
}
