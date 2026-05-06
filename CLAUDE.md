# CLAUDE.md

Guidance for Claude Code (and other AI coding assistants) working in this repo.

## What Forph is

Forph is a **macOS-only** Tauri 2 desktop app for local file conversion. It wraps system / Homebrew CLI tools (`ffmpeg`, `ffprobe`, `whisper-cli`/`whisper-cpp`, `pdftotext`, `sips`, `open`) behind a React 19 + Tailwind 4 UI. Files are processed entirely on-device; the app only reaches the network for first-time dependency or Whisper-model downloads.

The product is intentionally narrow: image conversion (JPG/PNG/WebP, HEIC via `sips`), Markdown→HTML, text-PDF→TXT/MD, video compress / GIF / audio extraction, audio transcription (TXT/SRT/VTT, with optional mixed-language mode), and batch processing with drag-out of result files. Anything outside that (Windows/Linux, OCR, complex PDF reflow, image→PDF) is **out of scope**.

## Architecture map

```
src/                          React + TS frontend
  App.tsx                     Top-level state machine: idle | actions | converting | done | batch | error
  components/
    BatchPanel.tsx            batch container; preferences, dependency recovery, and view wiring
    FileActions.tsx           (large, ~630 lines) single-file action surface
    DependencySection.tsx     ffmpeg / poppler / whisper-cpp install & model UX
    DropZone, Converting, ResultPanel, *Options
    batch/                    BatchSelectionView, BatchProgressView, BatchResultView, batchState, useBatchRunner
  lib/
    actionIds.ts              Single source of truth for action IDs (ACTION_IDS as const)
    actions.ts                Per-action eligibility / batch behaviour
    commands.ts               Typed wrappers around `invoke()` and the progress event
    transcription.ts          Model + language preferences, model-availability polling
    types.ts, format.ts, errors.ts

src-tauri/
  src/lib.rs                  ~3400 lines — ALL Rust logic lives here today
  src/main.rs                 thin entry, calls app_lib::run()
  capabilities/default.json   Tauri ACL: core, window:start-dragging, dialog, drag
  tauri.conf.json             macOSPrivateApi: true, transparent window with sidebar effect

.github/workflows/
  ci.yml                      lint + build (Ubuntu) + cargo test + clippy (macOS), on push/PR to main
  macos-bundle.yml            workflow_dispatch only — builds debug .app artifact
  release.yml                 on tag v* — version-cross-check, builds release .app, zips, attaches to GH Release
```

## Frontend ↔ backend contract

- All backend calls go through `src/lib/commands.ts`. Don't call `invoke()` directly from components.
- Action IDs are the contract between Rust (`build_actions` in `lib.rs`) and TS (`ACTION_IDS` in `actionIds.ts`). When you add an action, update **both** sides; `getFileInfo()` validates incoming IDs via `isActionId()` and throws on mismatch.
- Long-running operations emit progress on the `forph://conversion-progress` Tauri event. Each call passes a `jobId` so the listener can filter to its own job. See `REALTIME_ACTION_IDS` for which actions emit progress.
- Long-running ffmpeg / whisper jobs are registered in `JobRegistry` by `jobId`. Use `cancel_job(jobId)` for UI cancellation instead of inventing a second cancellation path.
- All Rust commands return `Result<T, String>` — error messages are user-facing Chinese strings; the frontend forwards them via `getErrorMessage()` without translation.

## External tool discovery

`command_search_paths()` in `lib.rs` prepends `/opt/homebrew/bin` and `/usr/local/bin` to `$PATH` before resolving any of the optional CLIs. This is on purpose: when launched from Finder, the GUI process inherits a stripped `PATH` that won't see Homebrew. Always use `command_with_augmented_path()` to spawn Homebrew-installed tools. **Do not** call `StdCommand::new("ffmpeg")` etc. directly. (`sips` and `open` are system binaries at `/usr/bin/`, but for consistency prefer the augmented helper.)

Whisper model directory follows `app.path().app_data_dir()` (i.e. `~/Library/Application Support/com.crashchen.forph/models/`). Two legacy directories are read but not migrated: `~/Library/Application Support/Forph/models/` and `~/.../com.forph.app/models/`.

## Conventions

- TypeScript is strict (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`). Don't loosen.
- All UI text is **Chinese**. There is no i18n layer — match existing tone; don't introduce English strings unless intentional.
- Tailwind v4 with `@tailwindcss/vite`; design tokens (`bg-mesh`, `glass`, `surface-hover`, `success-dim`, etc.) are defined in `src/index.css`. Reuse them rather than inventing one-off class soup.
- Lucide icons are imported by name. The pinned `lucide-react@^1.7.0` is suspicious — verify before bumping (see Known Issues).
- Drag-out of result cards uses `@crabnebula/tauri-plugin-drag` plus `get_drag_icon` (a generated 64×64 PNG cached in `app_data_dir`).
- Window is borderless / transparent / `macOSPrivateApi: true`. As a result the title bar doubles as a custom drag region (`drag-surface` + `onMouseDownCapture` → `appWindow.startDragging()`); elements inside that region must opt out with `.no-drag` or stop propagation.

## Validate before submitting

Per `CONTRIBUTING.md`, run all three before every PR:

```bash
npm run build      # tsc -b && vite build
npm run lint       # eslint .
cd src-tauri && cargo test
cd src-tauri && cargo clippy -- -D warnings
```

`cargo test` is the meaningful safety net — there's no frontend test suite. Don't skip it. The Rust tests cover the parsing helpers (ffmpeg progress, whisper progress, subtitle merge, language detection, path validation). When adding logic to those areas, add a unit test in the bottom `mod tests` block of `lib.rs`.

Bundling is verified manually via the `Manual macOS Bundle` workflow (`workflow_dispatch`); don't rely on it triggering automatically.

## Releasing

Versions in **`package.json`**, **`src-tauri/tauri.conf.json`**, and **`src-tauri/Cargo.toml`** must match the git tag exactly (the release workflow fails the build otherwise). Procedure:

1. Bump all three files to the new version, commit to `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the `Release` workflow builds, zips `Forph.app`, and publishes the GitHub Release.

Because the app uses `macOSPrivateApi`, **Mac App Store distribution is not a goal**. Don't add MAS-targeted bundle config.

## Known issues / pitfalls

- **`lib.rs` is monolithic (~3400 lines).** Splitting into modules (`commands/`, `ffmpeg`, `whisper`, `pdf`, `paths`, `validation`, `progress`) is a known refactor target — keep new code organized so the eventual split is mechanical, not semantic.
- **New file commands should validate at the boundary.** Existing conversion commands canonicalize through `validate_input_file_path`, and output files should be created through `make_output_path_for_input`. Keep that pattern when adding commands that accept paths from the frontend.
- **`lucide-react@^1.7.0` is unusual.** Modern lucide-react versions are 0.x. Confirm the pinned major matches what's actually on npm before upgrading; the icon set in this version is small.
- **Progress listener pattern** in `BatchPanel` and `Converting` uses `let disposed = false; ...then(fn => disposed ? fn() : unlisten = fn)`. This is the deliberate idiom — don't "fix" it without confirming a real leak.

## Style for changes

- Match the existing Rust style: `Result<_, String>` for command returns, `format!("中文消息: {}", err)` error strings, `?` propagation, `unwrap_or` only on values that genuinely have a sensible default.
- Frontend state for non-trivial flows uses `useReducer` (see `batchState.ts`). Don't reach for Redux / Zustand / etc.
- Don't introduce backwards-compat shims for the legacy model directories beyond what's already there — they're read-only fallbacks.
- Don't add features outside the Platform Scope listed in `README.md` without first opening an issue.
