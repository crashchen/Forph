import { useState, useCallback, useEffect, useRef } from "react";
import {
  Image,
  FileText,
  Video,
  Music,
  X,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  RotateCcw,
  GripVertical,
} from "lucide-react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type {
  FileInfo,
  FileAction,
  ConversionResult,
  BatchFileResult,
} from "../lib/types";
import {
  compressVideo,
  convertImage,
  exportMarkdown,
  extractAudio,
  getDragIcon,
  getFileInfo,
  installDependency,
  revealInFinder,
  transcribeAudio,
  videoToGif,
} from "../lib/commands";
import { formatSize } from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import { getActionDisabledReason } from "../lib/actions";
import { GifOptions } from "./GifOptions";
import { CompressOptions } from "./CompressOptions";
import { ImageOptions } from "./ImageOptions";
import { DependencySection, type InstallableDependency } from "./DependencySection";

interface BatchPanelProps {
  files: FileInfo[];
  isDragOver: boolean;
  onFilesRefreshed: (files: FileInfo[]) => void;
  onReset: () => void;
}

const typeIcons: Record<string, typeof Image> = {
  image: Image,
  markdown: FileText,
  video: Video,
  audio: Music,
};

const typeLabels: Record<string, string> = {
  image: "张图片",
  video: "个视频",
  audio: "个音频",
  markdown: "个文档",
};

async function runAction(
  file: FileInfo,
  actionId: string,
  opts?: {
    gifFps?: number;
    gifWidth?: number;
    gifStartTime?: number;
    gifDuration?: number;
    compressQuality?: string;
    compressMaxResolution?: string;
    imageQuality?: number;
  },
): Promise<ConversionResult> {
  if (actionId.startsWith("img_"))
    return convertImage(file.path, actionId.replace("img_", ""), opts?.imageQuality);
  if (actionId === "md_html") return exportMarkdown(file.path);
  if (actionId === "vid_gif")
    return videoToGif(
      file.path,
      opts?.gifFps ?? 15,
      opts?.gifWidth ?? 480,
      opts?.gifStartTime,
      opts?.gifDuration,
    );
  if (actionId === "vid_compress")
    return compressVideo(
      file.path,
      opts?.compressQuality ?? "balanced",
      opts?.compressMaxResolution,
    );
  if (actionId === "vid_mp3" || actionId === "aud_mp3")
    return extractAudio(file.path, "mp3");
  if (actionId === "vid_wav" || actionId === "aud_wav")
    return extractAudio(file.path, "wav");
  if (actionId === "vid_transcribe" || actionId === "aud_transcribe")
    return transcribeAudio(file.path, "base");
  if (actionId === "vid_transcribe_srt" || actionId === "aud_transcribe_srt")
    return transcribeAudio(file.path, "base", undefined, "srt");
  if (actionId === "vid_transcribe_vtt" || actionId === "aud_transcribe_vtt")
    return transcribeAudio(file.path, "base", undefined, "vtt");
  throw new Error(`未知操作: ${actionId}`);
}

export function BatchPanel({
  files,
  isDragOver,
  onFilesRefreshed,
  onReset,
}: BatchPanelProps) {
  const [phase, setPhase] = useState<"selecting" | "converting" | "done">(
    "selecting",
  );
  const [results, setResults] = useState<BatchFileResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showGifOptions, setShowGifOptions] = useState(false);
  const [showCompressOptions, setShowCompressOptions] = useState(false);
  const [imageOutputFormat, setImageOutputFormat] = useState<string | null>(null);
  const [installingDependency, setInstallingDependency] =
    useState<InstallableDependency | null>(null);
  const [dependencyMessage, setDependencyMessage] = useState<string | null>(
    null,
  );
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fileType = files[0].file_type;
  const actions = files[0].actions;
  const runtime = files[0].runtime;
  const Icon = typeIcons[fileType] || FileText;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  const startBatch = useCallback(
    async (
      actionId: string,
      opts?: {
        gifFps?: number;
        gifWidth?: number;
        gifStartTime?: number;
        gifDuration?: number;
        compressQuality?: string;
        compressMaxResolution?: string;
        imageQuality?: number;
      },
    ) => {
      setPhase("converting");
      setResults([]);
      setCurrentIndex(0);
      cancelledRef.current = false;

      const batchResults: BatchFileResult[] = [];

      for (let i = 0; i < files.length; i++) {
        if (cancelledRef.current) break;
        setCurrentIndex(i);

        try {
          const result = await runAction(files[i], actionId, opts);
          batchResults.push({ file: files[i], result });
        } catch (error) {
          batchResults.push({
            file: files[i],
            error: getErrorMessage(error, "转换失败"),
          });
        }
        setResults([...batchResults]);
      }

      if (isMountedRef.current) {
        setPhase("done");
      }
    },
    [files],
  );

  const handleDependencyInstall = useCallback(
    async (packageName: InstallableDependency) => {
      setDependencyMessage(null);
      setDependencyError(null);
      setInstallingDependency(packageName);

      try {
        const result = await installDependency(packageName);
        if (!isMountedRef.current) return;

        const refreshed = await Promise.all(
          files.map((f) => getFileInfo(f.path)),
        );
        if (!isMountedRef.current) return;

        onFilesRefreshed(refreshed);
        setDependencyMessage(`${result.message} 文件列表已刷新。`);
      } catch (error) {
        if (!isMountedRef.current) return;
        setDependencyError(getErrorMessage(error, "自动安装失败"));
      } finally {
        if (isMountedRef.current) {
          setInstallingDependency(null);
        }
      }
    },
    [files, onFilesRefreshed],
  );

  const handleDragAllOut = useCallback(async () => {
    const paths = results
      .filter((r) => r.result)
      .map((r) => r.result!.output_path);
    if (paths.length === 0) return;
    try {
      const icon = await getDragIcon();
      await startDrag({ item: paths, icon });
    } catch {
      // Drag cancelled or not supported
    }
  }, [results]);

  const successResults = results.filter((r) => r.result);
  const failedResults = results.filter((r) => r.error);
  const totalOutputSize = successResults.reduce(
    (sum, r) => sum + (r.result?.output_size ?? 0),
    0,
  );

  // ─── Selecting ────────────────────────────────

  if (phase === "selecting") {
    const groups = actions.reduce(
      (acc, action) => {
        if (!acc[action.group]) acc[action.group] = [];
        acc[action.group].push(action);
        return acc;
      },
      {} as Record<string, FileAction[]>,
    );

    return (
      <div
        className={`animate-fade-up w-full max-w-xl transition-opacity ${isDragOver ? "opacity-30" : ""}`}
      >
        {/* File summary */}
        <div className="glass p-5 rounded-2xl mb-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent-dim flex items-center justify-center shrink-0">
              <Icon size={22} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0 text-left">
              <h3 className="text-sm font-semibold text-white/90">
                {files.length} {typeLabels[fileType] || "个文件"}
              </h3>
              <p className="text-xs text-white/40 mt-0.5">
                共 {formatSize(totalSize)}
              </p>
            </div>
            <button
              onClick={onReset}
              className="no-drag p-2 rounded-lg hover:bg-surface-hover text-white/30 hover:text-white/60 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          {/* File list */}
          <div className="mt-3 max-h-32 overflow-y-auto space-y-1">
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between text-xs text-white/40 px-1"
              >
                <span className="truncate flex-1 min-w-0">{file.name}</span>
                <span className="shrink-0 ml-2 text-white/25">
                  {formatSize(file.size)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        {Object.entries(groups).map(([group, groupActions]) => (
          <div key={group} className="mb-3">
            <p className="text-[11px] font-medium text-white/30 uppercase tracking-widest mb-2 px-1">
              {group}
            </p>
            <div className="flex flex-wrap gap-2">
              {groupActions.map((action) => {
                const disabledReason = getActionDisabledReason(
                  files[0],
                  action,
                );
                const disabled = Boolean(disabledReason);

                const hasOptionsPanel =
                  action.id === "vid_gif" ||
                  action.id === "vid_compress" ||
                  action.id.startsWith("img_");

                if (hasOptionsPanel) {
                  const togglePanel = () => {
                    if (action.id === "vid_gif") {
                      setShowGifOptions((v) => !v);
                      setShowCompressOptions(false);
                      setImageOutputFormat(null);
                    } else if (action.id === "vid_compress") {
                      setShowCompressOptions((v) => !v);
                      setShowGifOptions(false);
                      setImageOutputFormat(null);
                    } else {
                      const fmt = action.id.replace("img_", "");
                      setImageOutputFormat((v) => (v === fmt ? null : fmt));
                      setShowGifOptions(false);
                      setShowCompressOptions(false);
                    }
                  };
                  return (
                    <button
                      key={action.id}
                      title={disabledReason ?? action.label}
                      disabled={disabled}
                      onClick={togglePanel}
                      className={`no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                        disabled
                          ? "cursor-not-allowed text-white/28 border-white/6 hover:bg-transparent"
                          : "cursor-pointer text-white/70 hover:text-white/90"
                      }`}
                    >
                      {action.label}
                    </button>
                  );
                }

                return (
                  <button
                    key={action.id}
                    title={disabledReason ?? action.label}
                    disabled={disabled}
                    onClick={() => startBatch(action.id)}
                    className={`no-drag glass glass-hover px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                      disabled
                        ? "cursor-not-allowed text-white/28 border-white/6 hover:bg-transparent"
                        : "cursor-pointer text-white/70 hover:text-white/90"
                    }`}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {showGifOptions && (
          <GifOptions
            file={files[0]}
            onConvert={(fps, width, startTime, duration) =>
              startBatch("vid_gif", {
                gifFps: fps,
                gifWidth: width,
                gifStartTime: startTime,
                gifDuration: duration,
              })
            }
          />
        )}
        {showCompressOptions && (
          <CompressOptions
            file={files[0]}
            onCompress={(quality, maxResolution) =>
              startBatch("vid_compress", {
                compressQuality: quality,
                compressMaxResolution: maxResolution,
              })
            }
          />
        )}
        {imageOutputFormat && (
          <ImageOptions
            outputFormat={imageOutputFormat}
            onConvert={(quality) =>
              startBatch(`img_${imageOutputFormat}`, {
                imageQuality: quality,
              })
            }
          />
        )}

        {runtime && (
          <DependencySection
            runtime={runtime}
            installingDependency={installingDependency}
            dependencyMessage={dependencyMessage}
            dependencyError={dependencyError}
            onInstallDependency={handleDependencyInstall}
          />
        )}

        <p className="text-center text-xs text-white/20 mt-6">
          选择操作后将批量处理全部 {files.length} 个文件
        </p>
      </div>
    );
  }

  // ─── Converting ───────────────────────────────

  if (phase === "converting") {
    const progress =
      files.length > 0 ? (results.length / files.length) * 100 : 0;
    const currentFile =
      currentIndex < files.length ? files[currentIndex] : null;

    return (
      <div className="animate-fade-up w-full max-w-lg">
        <div className="glass p-8 rounded-2xl text-center">
          <Loader2 size={40} className="spin-slow text-accent mx-auto mb-5" />
          <h2 className="text-lg font-semibold text-white/90 mb-1">
            批量处理中...
          </h2>
          <p className="text-sm text-white/50">
            {results.length} / {files.length}
            {currentFile && (
              <span className="text-white/30 ml-2">· {currentFile.name}</span>
            )}
          </p>

          <div className="mt-5 h-2 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Live results */}
          {results.length > 0 && (
            <div className="mt-4 max-h-40 overflow-y-auto space-y-1 text-left">
              {results.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs px-1">
                  {r.result ? (
                    <CheckCircle2
                      size={12}
                      className="text-success shrink-0"
                    />
                  ) : (
                    <XCircle size={12} className="text-danger shrink-0" />
                  )}
                  <span className="truncate text-white/40">
                    {r.file.name}
                  </span>
                  {r.result && (
                    <span className="shrink-0 text-white/25 ml-auto">
                      {formatSize(r.result.output_size)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => {
              cancelledRef.current = true;
            }}
            className="no-drag mt-5 px-5 py-2 rounded-xl text-sm text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors cursor-pointer"
          >
            停止处理
          </button>
        </div>
      </div>
    );
  }

  // ─── Done ─────────────────────────────────────

  const firstOutputDir = successResults[0]?.result?.output_path
    .split("/")
    .slice(0, -1)
    .join("/");

  return (
    <div className="animate-fade-up w-full max-w-lg">
      <div className="glass p-8 rounded-2xl text-center">
        <div className="w-16 h-16 rounded-full bg-success-dim flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 size={32} className="text-success" />
        </div>

        <h2 className="text-lg font-semibold text-white/90 mb-1">
          批量处理完成
        </h2>
        <p className="text-sm text-white/50">
          {successResults.length > 0 && (
            <span className="text-success">
              {successResults.length} 成功
            </span>
          )}
          {failedResults.length > 0 && (
            <span className="text-danger ml-2">
              {failedResults.length} 失败
            </span>
          )}
        </p>

        {/* Size comparison */}
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
                (-{Math.round(((totalSize - totalOutputSize) / totalSize) * 100)}
                %)
              </span>
            )}
          </div>
        )}

        {/* Results list – draggable */}
        <div
          className="mt-4 glass p-3 rounded-xl text-left max-h-48 overflow-y-auto cursor-grab active:cursor-grabbing select-none transition-colors hover:ring-1 hover:ring-accent/20"
          onMouseDown={() => {
            void handleDragAllOut();
          }}
        >
          <div className="space-y-1.5">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {r.result ? (
                  <CheckCircle2
                    size={12}
                    className="text-success shrink-0"
                  />
                ) : (
                  <XCircle size={12} className="text-danger shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0 text-white/50">
                  {r.file.name}
                </span>
                {r.result ? (
                  <span className="shrink-0 text-white/25">
                    {formatSize(r.result.output_size)}
                  </span>
                ) : (
                  <span className="shrink-0 text-danger/60 truncate max-w-[120px]">
                    {r.error}
                  </span>
                )}
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

        {/* Actions */}
        <div className="mt-6 flex gap-3 justify-center">
          {firstOutputDir && (
            <button
              onClick={() => revealInFinder(firstOutputDir)}
              className="no-drag flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors cursor-pointer"
            >
              <FolderOpen size={15} />
              在 Finder 中显示
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
