import { CheckCircle2, FolderOpen, FileOutput, RotateCcw } from "lucide-react";
import type { FileInfo, ConversionResult } from "../lib/types";
import { revealInFinder, openTarget } from "../lib/commands";
import { formatSize } from "../lib/format";

interface ResultPanelProps {
  file: FileInfo;
  result: ConversionResult;
  onReset: () => void;
}

function shortenPath(path: string): string {
  const home = path.indexOf("/Users/");
  if (home >= 0) {
    const parts = path.substring(home).split("/");
    if (parts.length > 3) {
      return `~/${parts.slice(3).join("/")}`;
    }
  }
  return path;
}

export function ResultPanel({ file, result, onReset }: ResultPanelProps) {
  const outputExt = result.output_path.split(".").pop()?.toUpperCase() || "";

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div className="glass p-8 rounded-2xl text-center">
        {/* Success icon */}
        <div className="w-16 h-16 rounded-full bg-success-dim flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 size={32} className="text-success" />
        </div>

        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {result.message}
        </h2>

        {/* File info */}
        <div className="mt-4 glass p-4 rounded-xl text-left">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-dim flex items-center justify-center shrink-0">
              <FileOutput size={18} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/80 truncate">
                {result.output_path.split("/").pop()}
              </p>
              <p className="text-xs text-white/35 mt-0.5">
                {outputExt} &middot; {formatSize(result.output_size)}
              </p>
            </div>
          </div>
          <p className="text-[11px] text-white/25 mt-2 font-mono truncate">
            {shortenPath(result.output_path)}
          </p>
        </div>

        {/* Size comparison */}
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-white/35">
          <span>{formatSize(file.size)}</span>
          <span>&rarr;</span>
          <span
            className={
              result.output_size < file.size ? "text-success" : "text-white/50"
            }
          >
            {formatSize(result.output_size)}
          </span>
          {result.output_size < file.size && (
            <span className="text-success">
              (-
              {Math.round(
                ((file.size - result.output_size) / file.size) * 100,
              )}
              %)
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex gap-3 justify-center">
          <button
            onClick={() => openTarget(result.output_path)}
            className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
          >
            <FileOutput size={15} />
            打开文件
          </button>
          <button
            onClick={() => revealInFinder(result.output_path)}
            className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-surface-hover text-white/60 text-sm font-medium hover:bg-surface-active hover:text-white/80 transition-colors cursor-pointer"
          >
            <FolderOpen size={15} />
            在 Finder 中显示
          </button>
        </div>

        {/* Reset */}
        <button
          onClick={onReset}
          className="no-drag mt-4 flex items-center gap-1.5 mx-auto text-xs text-white/30 hover:text-white/50 transition-colors cursor-pointer"
        >
          <RotateCcw size={12} />
          处理新文件
        </button>
      </div>
    </div>
  );
}
