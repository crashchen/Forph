import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  GripVertical,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { BatchFileResult } from "../../lib/types";
import { formatSize } from "../../lib/format";

interface BatchResultViewProps {
  results: BatchFileResult[];
  totalSize: number;
  completionState: "completed" | "stopped";
  buildStatusLabel: (result: BatchFileResult) => string;
  onRevealOutputDir: (path: string) => void;
  onRetryFailedItems: () => void;
  onContinueRemainingItems: () => void;
  onDragAllOut: () => void;
  onReset: () => void;
  hasLastRunContext: boolean;
}

export function BatchResultView({
  results,
  totalSize,
  completionState,
  buildStatusLabel,
  onRevealOutputDir,
  onRetryFailedItems,
  onContinueRemainingItems,
  onDragAllOut,
  onReset,
  hasLastRunContext,
}: BatchResultViewProps) {
  const successResults = results.filter((result) => result.status === "success");
  const failedResults = results.filter((result) => result.status === "error");
  const skippedResults = results.filter((result) => result.status === "skipped");
  const cancelledResults = results.filter((result) => result.status === "cancelled");
  const totalOutputSize = successResults.reduce(
    (sum, result) => sum + (result.result?.output_size ?? 0),
    0,
  );
  const firstOutputDir = successResults[0]?.result?.output_path
    .split("/")
    .slice(0, -1)
    .join("/");

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div className="glass p-8 rounded-2xl text-center">
        <div
          className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5 ${
            completionState === "stopped" ? "bg-warning-dim" : "bg-success-dim"
          }`}
        >
          {completionState === "stopped" ? (
            <AlertTriangle size={28} className="text-warning" />
          ) : (
            <CheckCircle2 size={32} className="text-success" />
          )}
        </div>

        <h2 className="text-lg font-semibold text-white/90 mb-1">
          {completionState === "stopped" ? "批量处理已停止" : "批量处理完成"}
        </h2>
        <p className="text-sm text-white/50">
          {successResults.length > 0 && (
            <span className="text-success">{successResults.length} 成功</span>
          )}
          {failedResults.length > 0 && (
            <span className="text-danger ml-2">{failedResults.length} 失败</span>
          )}
          {skippedResults.length > 0 && (
            <span className="text-white/35 ml-2">{skippedResults.length} 跳过</span>
          )}
          {cancelledResults.length > 0 && (
            <span className="text-warning ml-2">{cancelledResults.length} 未执行</span>
          )}
        </p>

        {successResults.length > 0 && (
          <div className="mt-2 flex items-center justify-center gap-2 text-xs text-white/35">
            <span>{formatSize(totalSize)}</span>
            <span>&rarr;</span>
            <span
              className={
                totalOutputSize < totalSize ? "text-success" : "text-white/50"
              }
            >
              {formatSize(totalOutputSize)}
            </span>
            {totalOutputSize < totalSize && (
              <span className="text-success">
                (-{Math.round(((totalSize - totalOutputSize) / totalSize) * 100)}%)
              </span>
            )}
          </div>
        )}

        <div
          className="mt-4 glass p-3 rounded-xl text-left max-h-48 overflow-y-auto cursor-grab active:cursor-grabbing select-none transition-colors hover:ring-1 hover:ring-accent/20"
          onMouseDown={() => {
            void onDragAllOut();
          }}
        >
          <div className="space-y-1.5">
            {results.map((result) => (
              <div key={result.file.path} className="flex items-center gap-2 text-xs">
                {result.status === "success" || result.status === "skipped" ? (
                  <CheckCircle2 size={12} className="text-success shrink-0" />
                ) : result.status === "cancelled" ? (
                  <AlertTriangle size={12} className="text-warning shrink-0" />
                ) : (
                  <XCircle size={12} className="text-danger shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0 text-white/50">
                  {result.file.name}
                </span>
                <span
                  className={`shrink-0 truncate max-w-[140px] ${
                    result.status === "error"
                      ? "text-danger/60"
                      : result.status === "cancelled"
                        ? "text-warning/70"
                        : "text-white/25"
                  }`}
                >
                  {buildStatusLabel(result)}
                </span>
              </div>
            ))}
          </div>
          {successResults.length > 0 && (
            <div className="flex items-center justify-center gap-1 mt-2 text-[10px] text-white/15">
              <GripVertical size={10} />
              <span>拖拽到其他应用</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          {firstOutputDir && (
            <button
              onClick={() => onRevealOutputDir(firstOutputDir)}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
            >
              <FolderOpen size={15} />
              在 Finder 中显示
            </button>
          )}
          {failedResults.length > 0 && hasLastRunContext && (
            <button
              onClick={onRetryFailedItems}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-danger/10 text-danger text-sm font-medium hover:bg-danger/20 transition-colors cursor-pointer"
            >
              <RotateCcw size={15} />
              重试失败项
            </button>
          )}
          {cancelledResults.length > 0 && hasLastRunContext && (
            <button
              onClick={onContinueRemainingItems}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-warning/10 text-warning text-sm font-medium hover:bg-warning/20 transition-colors cursor-pointer"
            >
              <RotateCcw size={15} />
              继续剩余项
            </button>
          )}
        </div>

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
