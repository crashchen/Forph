# Contributing to Forph

感谢你愿意帮助改进 Forph。

## Before You Start

- 先查看现有的 [README](./README.md)，确认项目当前范围仍然以 macOS 桌面版为主
- 如果你准备改动较大，建议先开 issue 或 discussion，避免和正在进行的方向冲突
- 请尽量把提交聚焦在单一主题，便于 review 和回滚

## Development Setup

1. 安装依赖

```bash
npm install
```

2. 启动前端开发环境

```bash
npm run dev
```

3. 启动 Tauri 开发版

```bash
npx tauri dev
```

## Validation

提交前请至少跑以下检查：

```bash
npm run build
npm run lint
cd src-tauri && cargo test
```

如果改动涉及桌面打包或 Tauri 配置，建议额外验证：

```bash
npx tauri build --debug --bundles app
```

## Pull Requests

- 清楚描述改动动机、影响范围和验证方式
- UI 改动尽量附截图或录屏
- 如果是依赖、打包、权限或模型目录相关修改，请在 PR 描述里明确说明迁移或兼容策略
- 不要顺手重构无关代码，除非它直接阻塞当前修复

## Scope Notes

- 当前主线优先保证“本地处理、轻量分发、稳定高频功能”
- Markdown 的复杂 PDF / Word 导出和图片转 PDF 目前不在主线维护范围
- 媒体功能依赖 `ffmpeg` / `ffprobe` / `whisper-cpp` 时，请同时考虑 GUI 环境下的 PATH 与 Homebrew 安装差异
