# Forph

Forph 是一个 macOS 本地文件转换器，主打拖拽即处理、100% 离线和轻量分发。当前版本刻意只保留稳定高频的本地转换，不再深挖那些已经有更成熟替代方案的导出链路。

## Current Features

- 图片转换：`JPG / PNG / WEBP / HEIC / HEIF / BMP / TIFF`
- Markdown 导出：`HTML`
- 视频处理：转 GIF、提取音频、离线转写
- 音频处理：转 MP3 / WAV、离线转写

## Platform Scope

当前仓库明确以 macOS 桌面版为目标。

- HEIC 转换依赖 `sips`
- Finder 定位与文件打开依赖 `open`
- 玻璃质感窗口依赖 Tauri 的 `macOSPrivateApi` 透明窗口能力

如果后续要支持 Windows 或 Linux，需要为这些能力补独立实现，而不是复用当前链路。

## Development

前置条件：

- macOS
- Node.js / npm
- Rust toolchain

安装依赖并启动前端：

```bash
npm install
npm run dev
```

运行 Tauri 开发版：

```bash
npx tauri dev
```

## Optional Runtime Dependencies

以下能力依赖系统工具，未安装时会在对应操作里提示：

- `ffmpeg`：视频转 GIF、提取音频、部分转写预处理
- `whisper-cpp` 或 `whisper`：本地音视频转写

示例：

```bash
brew install ffmpeg whisper-cpp
```

## Notes

- Markdown 的复杂 PDF / Word 分享建议继续使用 Obsidian 自带导出或你的 Pandoc 插件。
- 图片排版成 PDF 这类需求更适合直接交给 Word / Pages / Keynote 这类成熟工具。
- 由于开启了 macOS private API 来做透明窗口，这个版本默认不以 Mac App Store 分发为目标。
