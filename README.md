# Forph

Forph 是一个 macOS 本地文件转换器，主打拖拽即处理、文件本地处理和轻量分发。当前版本把稳定高频的媒体处理链路打磨成第一优先级：短视频转 GIF、提取音频，以及本地离线转写。

## Current Features

- 图片转换：输入支持 `JPG / PNG / WEBP / HEIC / HEIF / BMP / TIFF`，输出支持 `JPG / PNG / WEBP`
- Markdown 导出：`HTML`
- 视频处理：转 GIF、提取音频（MP3 / WAV）、离线转写
- 音频处理：转 MP3 / WAV、离线转写

## Platform Scope

当前仓库明确以 macOS 桌面版为目标。

- HEIC 转换依赖 `sips`
- Finder 定位与文件打开依赖 `open`
- 玻璃质感窗口依赖 Tauri 的 `macOSPrivateApi` 透明窗口能力
- 顶部毛玻璃标题条是窗口拖拽区
- 当前 bundle identifier：`com.crashchen.forph`

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

以下能力依赖系统工具，未安装时会在对应操作里提示或禁用对应动作：

- `ffmpeg` + `ffprobe`：视频转 GIF、提取音频、媒体信息读取，以及所有音视频转写前处理
- `whisper-cpp`：本地音视频转写
- 在 Homebrew 环境里，`whisper-cpp` 常见的实际可执行名是 `whisper-cli`
- 如果系统里已经有 Homebrew，Forph 会在动作页直接给 `一键安装 FFmpeg` / `一键安装 whisper-cpp`
- 如果还没有 Homebrew，动作页会给官网入口，先装好 Homebrew 再回来点一次即可

示例：

```bash
brew install ffmpeg whisper-cpp
```

## Notes

- GIF 更适合短视频片段。应用会对大于 15 秒、超过 50MB 或高于 1080p 的视频给出醒目提示，但不会强拦截。
- GIF 面板支持自定义开始时间和持续时长，更适合从视频中间截一小段出来做动图。
- 文件转换和转写都在本机完成，但首次安装依赖、下载模型这些恢复路径仍然需要联网。
- Whisper 默认使用 `ggml-base.bin`。如果缺模型，界面里会直接给“下载模型”和“打开模型文件夹”的入口。
- 当前主模型目录会跟随 bundle identifier 走到应用数据目录，也就是类似 `~/Library/Application Support/com.crashchen.forph/models/`。
- 旧目录 `~/Library/Application Support/Forph/models/` 和 `~/Library/Application Support/com.forph.app/models/` 仍会被兼容读取，但不会自动清理。
- 为了兼容从 Finder 直接启动的 GUI 环境，应用会优先尝试 Homebrew 常见路径，而不是只依赖终端里的 `PATH`。
- Markdown 的复杂 PDF / Word 分享建议继续使用 Obsidian 自带导出或你的 Pandoc 插件。
- 图片排版成 PDF 这类需求更适合直接交给 Word / Pages / Keynote 这类成熟工具。
- 由于开启了 macOS private API 来做透明窗口，这个版本默认不以 Mac App Store 分发为目标。

## Contributing

欢迎提交 issue 和 PR。

- 问题反馈：<https://github.com/crashchen/Forph/issues>
- 开发与提交流程：见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

Forph 使用 [MIT License](./LICENSE) 开源。
