import { useState, useEffect, useCallback, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ShieldCheck, Zap } from "lucide-react";
import { DropZone } from "./components/DropZone";
import { FileActions } from "./components/FileActions";
import { Converting } from "./components/Converting";
import { ResultPanel } from "./components/ResultPanel";
import { getFileInfo } from "./lib/commands";
import type { AppView } from "./lib/types";

const appWindow = getCurrentWindow();

export default function App() {
  const [view, setView] = useState<AppView>({ stage: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFileDrop = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
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
    } catch (e) {
      console.error(e);
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
        console.debug("Window drag start skipped", error);
      }
    },
    [],
  );

  const reset = () => setView({ stage: "idle" });

  return (
    <div className="bg-mesh h-full p-4">
      <div className="window-frame h-full flex flex-col overflow-hidden">
        <div
          data-tauri-drag-region
          className="drag-surface flex items-center justify-between px-5 py-4 shrink-0"
          onMouseDown={handleWindowDrag}
        >
          <div data-tauri-drag-region className="flex items-center gap-3">
            <div className="brand-mark">
              <Zap size={16} className="text-accent" />
            </div>
            <div data-tauri-drag-region className="space-y-0.5">
              <span className="block text-sm font-semibold tracking-[0.28em] text-white/78 uppercase">
                Forph
              </span>
              <span className="block text-[11px] text-white/34">
                Local conversions, focused on the reliable stuff.
              </span>
            </div>
          </div>
          <div
            data-tauri-drag-region
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-success-dim ring-1 ring-white/8"
          >
            <ShieldCheck size={12} className="text-success" />
            <span className="text-[11px] font-medium text-success tracking-wide">
              100% Offline
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
