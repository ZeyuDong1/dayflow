# Dayflow for Windows

The automatic work journal / time tracker, ported from [JerryZLiu/Dayflow](https://github.com/JerryZLiu/Dayflow) (macOS) to Windows.

Dayflow runs quietly on your PC, captures lightweight screenshots of your screen, and turns them into a clear timeline of what you actually did — privately, local-first, and with your choice of AI provider (fully local with Ollama / LM Studio, or cloud: Gemini, ChatGPT, Claude, 智谱 GLM, 小米 MiMo).

## Features (full parity with the macOS original)

| Feature | How it works |
| --- | --- |
| **Automatic timeline** | Captures a screenshot every 1–60 s (default 10 s), analyzes 15-minute batches with a vision model, and emits activity cards (10–60 min each) with concrete titles, summaries, per-minute detail logs and distractions. |
| **Context-aware summaries** | Understands what you were doing on screen (Cursor vs Chrome vs YouTube vs Slack), not just which app was active. The full Dayflow timeline prompt is ported verbatim. |
| **Daily standup** | GitHub-style activity grid of your day + AI-generated yesterday's highlights, blockers, and an editable today's-priorities checklist. |
| **Chat with your work journal** | Streaming chat grounded in your timeline; understands "yesterday", "last week", explicit dates. |
| **Weekly review** | Focus stats, category donut, app/site usage, workflow grid (day × 30-min slots), focus heatmap, and an app-interaction (switching) graph. |
| **Distraction tracking** | Distractions inside cards + a Distraction category; surfaced in day summary, heatmap and weekly stats. |
| **Timeline export** | Export any date range as Markdown. |
| **Local-first storage** | Screenshots + SQLite DB live in `%APPDATA%\Dayflow`. Nothing leaves your PC unless you pick a cloud provider. |
| **AI provider choice** | Gemini / ChatGPT / Claude / **智谱 GLM（API 或 GLM Coding Plan）** / **小米 MiMo（API 或 Token Plan）** / Ollama / LM Studio / any OpenAI-compatible endpoint. |
| **Automatic cleanup** | Configurable disk cap (default 10 GB), 30-day screenshot retention, orphan purge, DB pruning. |
| **Privacy controls** | Private-app list (password managers are default) replaced with gray placeholders, idle detection, quick pause (tray or settings), delete day / delete everything. |

Extras: system tray with pause presets, launch-at-Windows, editable categories with role presets (Software Engineer / Founder / Designer / PM / Data Scientist / Student), 4 AM day boundary, reprocess-a-day, connection tester.

## Tech stack

- **Electron + React + TypeScript (electron-vite)** — screen capture via `desktopCapturer`, tray, login item
- **sql.js (WASM SQLite)** — zero native compilation, `npm install` always works; whole-DB flush on write batches
- **active-win** — foreground window/process detection (prebuilt NAPI binary, no VS Build Tools needed)
- No other runtime dependencies; charts are hand-rolled SVG

## Run from source

```bash
npm install
npm run dev        # development with HMR
npm start          # run the production build
```

Requirements: Node 20+, Windows 10/11. No screen-recording permission is needed on Windows.

## Package the installer

```bash
npm run dist       # → release/Dayflow-Setup-1.0.0.exe (NSIS, x64)
```

## Set up an AI provider

Settings → AI Provider:

| Provider | What you need |
| --- | --- |
| Gemini | API key from Google AI Studio (`gemini-2.5-flash` default) |
| ChatGPT | OpenAI API key (`gpt-4o-mini`+) |
| Claude | Anthropic API key (`claude-sonnet-4-5`) |
| 智谱 GLM | **两种方式**（设置里切换）：① API 按量计费 — [bigmodel.cn](https://bigmodel.cn) Key，默认 `glm-4.6v`（`glm-4v-flash` 免费视觉档）；② **GLM Coding Plan 订阅** — Anthropic 兼容网关 `https://open.bigmodel.cn/api/anthropic`，同一个 Key，模型 `glm-4.6` / `glm-4.7` / `glm-5` 等 |
| MiMo | **两种方式**（设置里切换）：① API 按量计费 — `https://api.xiaomimimo.com/v1`，默认 `mimo-v2.5-pro`；② **Token Plan 订阅** — Anthropic 兼容网关 `https://api.xiaomimimo.com/anthropic`，同一个 Key |
| Ollama (local) | `ollama pull qwen2.5vl:7b` — analysis never leaves your PC |
| LM Studio (local) | Start the local server, load a vision model |
| OpenAI-compatible | Any endpoint (vLLM, OpenRouter, …) |

The model must support **images** (vision) for timeline analysis. Use "Test connection" to verify.

## How it works

1. **Capture** — every interval, **all monitors** are captured, scaled to 720/1080p each, and stitched into one panorama JPEG (quality 72); toggle to primary-only in Settings → Recording alongside the foreground window title and system idle time. Locked screen / idle > threshold / paused → no capture. Private apps → gray placeholder.
2. **Batching** — pending frames close into a batch after 15 minutes (or 90 frames, or when capture goes quiet for 3 min); frames split at gaps > 2 min. Frames are downsampled to one per minute for the model, each labelled with its clock time.
3. **Idle classification** — if the user was idle for more than half the window, an Idle card is emitted without calling any model.
4. **Analysis** — the one-step timeline prompt + previous cards (45-min lookback, treated as a draft) + labeled frames go to your provider. The returned cards replace the draft and are anchored to epoch timestamps by parsing the clock times against the batch window.
5. **Failure handling** — analysis failures back off exponentially (60 s → 10 min); screenshots stay pending and are retried. "Reprocess day" rebuilds any day from stored screenshots.

## Data layout

```
%APPDATA%\Dayflow\
  data\dayflow.db          # SQLite: screenshots, cards, standups, plans, chats, settings
  recordings\YYYY-MM-DD\   # one JPEG per capture
```

## Differences from the macOS original

- ChatGPT/Claude providers use their cloud APIs directly (the Mac app shells out to Codex/Claude CLIs).
- Video timelapses, the "Daily Brief" agent with external connectors, hosted Dayflow backend, analytics/telemetry, and referral features are not ported — the local feature set above is.
- Screen Recording permission is not required on Windows.

## License

MIT, same as the original Dayflow.
