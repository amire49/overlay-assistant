# Overlay Assistant — clean-room rebuild spec

Goal: a desktop AI assistant with the same feature set as Cluely, written from scratch.
No Cluely code, prompts, assets, endpoints or credentials are reused. The inventory below
comes from REA static analysis of the installed Cluely 2.0.198 package
(`%LOCALAPPDATA%\Programs\cluely-v2\resources\app.asar`, sha256 `e123556c…f6bc5`,
REA evidence `ev_96868e01…faa6`). Everything listed is an *observation of what exists*,
not proof of runtime behavior.

## What Cluely is made of (observed)

| Area | Observation |
|---|---|
| Shell | Electron, Vite-built. Local `dist-electron/main.js` (~540 KB) + a 314-byte preload exposing 3 members over 2 `contextBridge` APIs. |
| UI | Renderer is loaded remotely from `renderer.v2.cluely.com`; backend is `api.v2.cluely.com`. AI, transcription post-processing and accounts live server-side. |
| Windows | 7 `BrowserWindow` constructions. Routes seen: `/control`, `/chat`, `/dashboard`, `/onboarding`, `/notification`. Frameless, transparent, `type: "panel"`, `hiddenInMissionControl`, `skipTaskbar`, `focusable` toggled at runtime, opacity changes. |
| Stealth | `setContentProtection` (4 call sites) — windows excluded from screen capture/sharing. |
| Hotkeys | `Ctrl+\` (toggle), `Ctrl+Shift+\`, `Ctrl+Enter` (ask), `Ctrl+R` (reset), `Ctrl+Up/Down/Left/Right` (move), `Ctrl+Shift+Up/Down` (scroll). |
| Screen | `desktopCapturer` + `setDisplayMediaRequestHandler`; IPC `capture-screenshot`; display add/remove/metrics listeners. |
| Audio | Mic via bundled SoX (`sox-14.4.1-win32`), system audio via `audiotee` (macOS), Silero VAD (`@ricky0123/vad`). |
| IPC (main) | `capture-screenshot`, `control-window-drag(-end)`, `control-window-toggle-chat`, `control-window-reset-position`, `chat-window-resize/reset-size`, `get-shared-state`/`patch-shared-state`, `permissions-check/ask-for-access`, `open-dashboard-*` (billing, modes, session, shortcuts), `check-for-updates`/`restart-to-update`, `quit-app`, `reset-all-state`. |
| Other | Tray icon, `electron-updater`, custom protocol deep-link auth (Clerk), session history, "modes" (custom system prompts), billing. |

## What we build

### Phase 1 — MVP (this scaffold)
- [x] Floating control bar (frameless, transparent, always-on-top, no taskbar entry)
- [x] Chat/answer window under the bar with streamed responses
- [x] Hidden from screen capture (toggleable)
- [x] Screenshot of the current display → Claude (vision) + optional question
- [x] Global hotkeys: `Ctrl+\` toggle, `Ctrl+Enter` capture & ask, `Ctrl+R` reset, `Ctrl+Arrows` move, `Ctrl+Shift+Up/Down` scroll
- [x] Conversation memory within a session; reset clears it
- [x] API key from `ANTHROPIC_API_KEY` or stored encrypted (Electron `safeStorage`)

### Phase 2 — Listening
- [x] Mic capture (`getUserMedia`, "You") + system audio (Windows loopback via `setDisplayMediaRequestHandler` → `audio: "loopback"`, "Them"; on Linux the same request reads the default output's PulseAudio/PipeWire monitor) in a hidden audio window
- [x] Adaptive energy VAD in an AudioWorklet at 16 kHz (pre-roll, 700 ms hangover, 20 s max segment)
- [x] Local speech-to-text: Whisper base.en (q8) via transformers.js in a worker thread; model cached in userData on first use
- [x] Live transcript panel with level meters; `Ctrl+Shift+L` toggles listening
- [x] Asking while a transcript exists sends it to Claude; the default question becomes "What should I say next?"
- [x] Optional cloud streaming STT (Deepgram) for lower latency
- [x] Echo handling when using speakers (mic picks up "Them")

### Phase 3 — Product
- [x] Modes: saved instructions appended to the system prompt; 5 built-in (General, Meeting, Sales call, Coding, Writing) plus custom; switch from the bar's mode pill, the tray, or Settings
- [x] Session history: each session (transcript + Q&A, no screenshots) saved as JSON under `userData/sessions`; a session ends on Reset (`Ctrl+R`) or quit; view, copy as Markdown, delete
- [x] Settings window: API key, model (Opus 5.5 / Sonnet 5.5 / Haiku 5.5), listening sources, capture protection, hotkey reference
- [x] Tray icon + menu: show/hide, ask, listen, new session, mode radio list, settings, history, quit
- [x] Auto-update (electron-updater, generic feed set at build time; tray + Settings show status)
- [x] Drag-to-move bar with chat following, saved position, return to main display when a monitor disappears
- [x] Packaging: per-user NSIS installer via `npm run dist`
- [x] Linux: `.deb` via `npm run dist` (runs under XWayland; `overlay-assistant --ask` etc. for desktop shortcuts where Wayland blocks global hotkeys; no capture protection)
- [ ] Onboarding/permissions screen
- [ ] Code signing

Not planned: accounts, billing, remote renderer.
