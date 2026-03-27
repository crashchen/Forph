import { AlertTriangle, Download, FolderOpen } from "lucide-react";
import type { RuntimeInfo } from "../lib/types";
import { openTarget } from "../lib/commands";

export type InstallableDependency = "ffmpeg" | "whisper-cpp";

const MODEL_DOWNLOAD_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true";
const HOMEBREW_URL = "https://brew.sh";

interface DependencySectionProps {
  runtime: RuntimeInfo;
  installingDependency: InstallableDependency | null;
  dependencyMessage: string | null;
  dependencyError: string | null;
  onInstallDependency: (pkg: InstallableDependency) => void;
}

export function DependencySection({
  runtime,
  installingDependency,
  dependencyMessage,
  dependencyError,
  onInstallDependency,
}: DependencySectionProps) {
  return (
    <>
      {!runtime.ffmpeg_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                先装 FFmpeg，媒体转换才会完整可用
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                GIF、音频提取，以及大多数视频 / 音频转写前处理都依赖 FFmpeg。
              </p>
              <div className="flex flex-wrap gap-2">
                {runtime.brew_available ? (
                  <button
                    disabled={installingDependency !== null}
                    onClick={() => onInstallDependency("ffmpeg")}
                    className={`no-drag px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                      installingDependency !== null
                        ? "cursor-not-allowed bg-white/6 text-white/28"
                        : "cursor-pointer bg-accent/15 text-accent hover:bg-accent/25"
                    }`}
                  >
                    {installingDependency === "ffmpeg"
                      ? "正在安装 FFmpeg..."
                      : "一键安装 FFmpeg"}
                  </button>
                ) : (
                  <button
                    onClick={() => openTarget(HOMEBREW_URL)}
                    className="no-drag px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                  >
                    安装 Homebrew
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!runtime.whisper_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                先装 whisper-cpp，才能离线转写
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                当前转写按钮已经先帮你收住了，装好之后我会立刻帮你重新检测当前文件。
              </p>
              <div className="flex flex-wrap gap-2">
                {runtime.brew_available ? (
                  <button
                    disabled={installingDependency !== null}
                    onClick={() => onInstallDependency("whisper-cpp")}
                    className={`no-drag px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                      installingDependency !== null
                        ? "cursor-not-allowed bg-white/6 text-white/28"
                        : "cursor-pointer bg-accent/15 text-accent hover:bg-accent/25"
                    }`}
                  >
                    {installingDependency === "whisper-cpp"
                      ? "正在安装 whisper-cpp..."
                      : "一键安装 whisper-cpp"}
                  </button>
                ) : (
                  <button
                    onClick={() => openTarget(HOMEBREW_URL)}
                    className="no-drag px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                  >
                    安装 Homebrew
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {(dependencyMessage || dependencyError) && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={16}
              className={`shrink-0 mt-0.5 ${dependencyError ? "text-warning" : "text-success"}`}
            />
            <div className="space-y-1">
              <p className="text-sm font-medium text-white/78">
                {dependencyError ? "安装助手遇到了一点阻塞" : "安装助手已完成当前步骤"}
              </p>
              <p className={`text-xs leading-relaxed ${dependencyError ? "text-white/42" : "text-white/55"}`}>
                {dependencyError ?? dependencyMessage}
              </p>
            </div>
          </div>
        </div>
      )}

      {runtime.whisper_available && !runtime.base_model_available && (
        <div className="mt-4 glass p-4 rounded-2xl text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-2 w-full">
              <p className="text-sm font-medium text-white/78">
                离线转写还差一个 `ggml-base.bin` 模型
              </p>
              <p className="text-xs text-white/42 leading-relaxed">
                下载官方 whisper.cpp 的 `base` 模型后，放进模型文件夹就能直接开始转写。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openTarget(MODEL_DOWNLOAD_URL)}
                  className="no-drag flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
                >
                  <Download size={14} />
                  下载 base 模型
                </button>
                {runtime.model_directory && (
                  <button
                    onClick={() => openTarget(runtime.model_directory!, { ensureDirectory: true })}
                    className="no-drag flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-hover text-white/70 text-sm font-medium hover:bg-surface-active transition-colors cursor-pointer"
                  >
                    <FolderOpen size={14} />
                    打开模型文件夹
                  </button>
                )}
              </div>
              {runtime.model_directory && (
                <p className="text-[11px] text-white/28 font-mono break-all">
                  {runtime.model_directory}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {runtime.legacy_model_directories.length > 0 && (
        <div className="mt-4 px-1">
          <p className="text-[11px] text-white/30 leading-relaxed">
            旧模型目录仍会被兼容读取，你可以等确认新目录可用后再手动清理旧缓存。
          </p>
          <p className="text-[10px] text-white/18 font-mono mt-1 break-all">
            {runtime.legacy_model_directories.join("  ·  ")}
          </p>
        </div>
      )}

      {runtime.available_models.length > 0 && (
        <p className="text-[11px] text-white/22 mt-4 px-1">
          已发现模型：{runtime.available_models.join(", ")}
        </p>
      )}
    </>
  );
}
