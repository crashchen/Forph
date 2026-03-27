import { Loader2 } from "lucide-react";
import type { FileInfo } from "../lib/types";

interface ConvertingProps {
  file: FileInfo;
  actionId: string;
}

const actionLabels: Record<string, string> = {
  img_jpg: "转换为 JPG",
  img_png: "转换为 PNG",
  img_webp: "转换为 WebP",
  md_html: "导出 HTML",
  vid_gif: "转换为 GIF",
  vid_mp3: "提取音频",
  vid_transcribe: "转写文字",
  aud_mp3: "转换为 MP3",
  aud_wav: "转换为 WAV",
  aud_transcribe: "转写文字",
};

export function Converting({ file, actionId }: ConvertingProps) {
  const label = actionLabels[actionId] || "处理中";

  return (
    <div className="animate-fade-up text-center max-w-md">
      <div className="glass p-10 rounded-2xl">
        <Loader2 size={40} className="spin-slow text-accent mx-auto mb-5" />
        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {label}...
        </h2>
        <p className="text-sm text-white/40">{file.name}</p>

        {/* Progress bar */}
        <div className="mt-6 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full w-full progress-shimmer rounded-full" />
        </div>

        <p className="text-xs text-white/25 mt-4">
          请稍候，正在本地处理...
        </p>
      </div>
    </div>
  );
}
