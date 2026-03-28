import { useState, useEffect, useCallback, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ShieldCheck, Zap } from "lucide-react";
import { DropZone } from "./components/DropZone";
import { FileActions } from "./components/FileActions";
import { Converting } from "./components/Converting";
import { ResultPanel } from "./components/ResultPanel";
import { BatchPanel } from "./components/BatchPanel";
import { getFileInfo } from "./lib/commands";
import { getErrorMessage } from "./lib/errors";
import type { AppView, FileInfo } from "./lib/types";

const appWindow = getCurrentWindow();

const FILE_READ_ERROR_FALLBACK = "读取文件时出了点问题，请换一个文件重试。";

function buildFallbackFileInfo(path: string): FileInfo {
  const name = path.split("/").pop() || "unknown";
  const dotIndex = name.lastIndexOf(".");
  const extension = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : "";

  return {
    name,
    path,
    extension,
    size: 0,
    file_type: "unknown",
    actions: [],
    media: null,
    runtime: null,
  };
}

export default function App() {
  const [view, setView] = useState<AppView>({ stage: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFileDrop = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;

    if (paths.length === 1) {
      try {
        const info = await getFileInfo(paths[0]);
        if (info.file_type === "unknown") {
          setView({
            stage: "error",
            file: info,
            error: `不支持的文件格式: .${info.extension}`,
          });
        } else {
          setView({ stage: "actions", file: info });
        }
      } catch (error) {
        console.error(error);
        setView({
          stage: "error",
          file: buildFallbackFileInfo(paths[0]),
          error: getErrorMessage(error, FILE_READ_ERROR_FALLBACK),
        });
      }
      return;
    }

    // Batch mode
    try {
      const infos = await Promise.all(paths.map((p) => getFileInfo(p)));
      const supported = infos.filter((f) => f.file_type !== "unknown");

      if (supported.length === 0) {
        setView({
          stage: "error",
          file: buildFallbackFileInfo(paths[0]),
          error: "所有文件格式都不支持",
        });
        return;
      }

      // Group by dominant type
      const typeCounts: Record<string, number> = {};
      for (const f of supported) {
        typeCounts[f.file_type] = (typeCounts[f.file_type] || 0) + 1;
      }
      const dominantType = Object.entries(typeCounts).sort(
        (a, b) => b[1] - a[1],
      )[0][0];
      const batchFiles = supported.filter(
        (f) => f.file_type === dominantType,
      );

      if (batchFiles.length === 1) {
        setView({ stage: "actions", file: batchFiles[0] });
      } else {
        setView({ stage: "batch", files: batchFiles });
      }
    } catch (error) {
      console.error(error);
      setView({
        stage: "error",
        file: buildFallbackFileInfo(paths[0]),
        error: getErrorMessage(error, FILE_READ_ERROR_FALLBACK),
      });
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    appWindow
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragOver(true);
        } else if (event.payload.type === "leave") {
          setIsDragOver(false);
        } else if (event.payload.type === "drop") {
          setIsDragOver(false);
          handleFileDrop(event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => unlisten?.();
  }, [handleFileDrop]);

  const handleWindowDrag = useCallback(
    async (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.closest(".no-drag")) {
        return;
      }

      try {
        await appWindow.startDragging();
      } catch (error) {
        console.error("Window dragging failed", error);
      }
    },
    [],
  );

  const reset = () => setView({ stage: "idle" });

  return (
    <div className="bg-mesh h-full p-4">
      <div className="window-frame h-full flex flex-col overflow-hidden">
        <div
          className="drag-surface flex items-center justify-between px-5 py-4 shrink-0"
          onMouseDownCapture={(event) => {
            void handleWindowDrag(event);
          }}
        >
          <div className="flex items-center gap-3">
            <div className="brand-mark">
              <Zap size={16} className="text-accent" />
            </div>
            <div className="space-y-0.5">
              <span className="block text-sm font-semibold tracking-[0.28em] text-white/78 uppercase">
                Forph
              </span>
              <span className="block text-[11px] text-white/34">
                Local conversions, focused on the reliable stuff.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-success-dim ring-1 ring-white/8">
            <ShieldCheck size={12} className="text-success" />
            <span className="text-[11px] font-medium text-success tracking-wide">
              Files Stay Local
            </span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
          {view.stage === "idle" && (
            <DropZone isDragOver={isDragOver} onFileDrop={handleFileDrop} />
          )}
          {view.stage === "actions" && (
            <FileActions
              file={view.file}
              isDragOver={isDragOver}
              onConversionStart={(actionId) =>
                setView({ stage: "converting", file: view.file, actionId })
              }
              onFileRefreshed={(sourcePath, file) =>
                setView((currentView) => {
                  if (
                    currentView.stage !== "actions" ||
                    currentView.file.path !== sourcePath
                  ) {
                    return currentView;
                  }

                  return { stage: "actions", file };
                })
              }
              onResult={(result) =>
                setView({ stage: "done", file: view.file, result })
              }
              onError={(error) =>
                setView({ stage: "error", file: view.file, error })
              }
              onReset={reset}
            />
          )}
          {view.stage === "converting" && (
            <Converting file={view.file} actionId={view.actionId} />
          )}
          {view.stage === "done" && (
            <ResultPanel
              file={view.file}
              result={view.result}
              onReset={reset}
            />
          )}
          {view.stage === "batch" && (
            <BatchPanel
              files={view.files}
              isDragOver={isDragOver}
              onFilesRefreshed={(files) =>
                setView((v) =>
                  v.stage === "batch" ? { stage: "batch", files } : v,
                )
              }
              onReset={reset}
            />
          )}
          {view.stage === "error" && (
            <div className="animate-fade-up text-center max-w-md">
              <div className="glass p-8">
                <div className="w-14 h-14 rounded-full bg-danger-dim flex items-center justify-center mx-auto mb-4">
                  <span className="text-2xl">!</span>
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">
                  出错了
                </h2>
                <p className="text-sm text-white/50 mb-6 whitespace-pre-wrap">
                  {view.error}
                </p>
                <button
                  onClick={reset}
                  className="no-drag px-5 py-2.5 rounded-xl bg-surface-hover text-white/80 text-sm font-medium hover:bg-surface-active transition-colors cursor-pointer"
                >
                  重新开始
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
