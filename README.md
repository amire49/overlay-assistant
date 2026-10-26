# Overlay Assistant

A floating AI assistant for Windows: take a screenshot and ask Claude about it, with answers streamed into an always-on-top overlay. This is a clean-room rebuild of Cluely's feature set. See [SPEC.md](SPEC.md) for the feature inventory and roadmap.

## Run

```bash
npm install
npm start
```

On first use, paste your Anthropic API key into the chat window. It's stored encrypted with Windows DPAPI via Electron `safeStorage`. Alternatively, set `ANTHROPIC_API_KEY` before starting.

## Hotkeys

| Keys | Action |
|---|---|
| `Ctrl+Enter` | Screenshot the screen and ask |
| `Ctrl+\` | Hide / show everything |
| `Ctrl+R` | New session (saves the current one to History) |
| `Ctrl+Shift+L` | Start / stop listening |
| `Ctrl+Arrows` | Move the overlay |
| `Ctrl+Shift+Up/Down` | Scroll the answer |

## Listening

**Listen** transcribes your microphone ("You") and your computer's audio ("Them") on your own machine with Whisper. The speech model ships inside the installer, so Listen works offline right away and never downloads anything. While a transcript exists, **Ask** sends it to Claude along with the screenshot and asks what you should say next. Use headphones, or the mic will also pick up the other side.

Before you record other people, check the consent laws where you and they are.

## Profile (your CV and notes)

Under **Settings → Profile**, add your CV (PDF) and any notes about yourself (`.txt` or `.md`), and fill in the **About me** box. These go to Claude with every question. When you're asked about your background, Claude answers in the first person from the facts in your documents. It's told never to invent employers, dates, skills or numbers, and to say when your profile doesn't cover something.

- PDFs go to Claude as documents, so layout and tables survive.
- The whole profile is prompt-cached, so repeat questions don't pay for it again in full.
- Untick a document to leave it out without deleting it.
- Files are stored only on this computer, under the app's data folder.

## Modes, history and settings

- **Modes** add instructions to every question, for example Meeting, Coding or Writing, or your own. Click the mode button on the bar to cycle through them. Right-click it, or use the tray menu, to edit them.
- **History** keeps each session's transcript and answers. Screenshots aren't saved. Press `Ctrl+R` to start a new session; the previous one is saved and appears under Settings → History.
- **Settings** opens from the ⚙ button or the tray icon. It covers your API key, model (Opus 5.5, Sonnet 5.5 or Haiku 5.5), listening sources and screen-capture protection.
- **Tray icon:** closing the settings window doesn't quit the app. Use the tray icon's **Quit** item or the ✕ on the bar.

## Moving the overlay

Drag the bar by its ⠿ grip or any empty part of it, or press `Ctrl+Arrows`. The answer window follows. The position is remembered, and if a monitor is unplugged the bar returns to the main screen.

## Building the Windows installer

```bash
npm run dist
```

The first build downloads the Whisper speech model (about 77 MB) into `build/models/` with `scripts/fetch-model.js`. That download resumes if interrupted, and every file's size is checked. Later builds reuse it. The installer bundles it into `resources/models`.

This writes `dist/OverlayAssistant-Setup-<version>.exe`, a per-user installer that doesn't need admin rights. The installer is unsigned, so Windows SmartScreen will warn until you sign it with a code-signing certificate.

## Releases and auto-update

Updates come from this repo's GitHub Releases. To ship a new version:

1. Bump `version` in `package.json`.
2. Commit and push.
3. Run `npm run release -- --notes "What changed"`.

The release script builds the installer and publishes it as release `v<version>` with `latest.yml`, using your `gh` login. It refuses to run if you have uncommitted or unpushed changes, or if that release already exists.

The installed app checks for updates 10 seconds after it starts and every 4 hours after that. It downloads new versions in the background. When an update is ready, the tray menu shows **Restart to update**, or it installs when you next quit.

**The repo is private, so each install needs a token to download updates.** No token is built into the installer, because anyone with the file could extract it. To set one up:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → `overlay-assistant`
   - Permissions: **Contents: Read-only**
2. Paste it in the app under **Settings → General → Updates**. It's stored encrypted, like the API key.

Without a token, the app runs normally and shows "Updates need a GitHub token".

To use a plain static host instead, such as S3, build with `OVERLAY_UPDATE_URL=https://host/path/ npm run dist`. Then upload `latest.yml`, the installer and its `.blockmap` to that URL.

**If the build fails with "Cannot create symbolic link":** electron-builder's winCodeSign archive contains macOS symlinks that Windows can't create without admin rights or Developer Mode. Turn on Developer Mode, or extract the archive into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` and ignore the two `darwin` errors.

## Tests

```bash
node tests/e2e-phase1.js   # overlay, screenshot, ask, history (mock Claude API)
node tests/stt-unit.js     # local Whisper on a spoken fixture (downloads the model)
node tests/stt-bundled.js  # same, offline from build/models: nothing downloaded
node tests/e2e-phase2.js   # fake mic -> VAD -> Whisper -> transcript -> Claude request
node tests/e2e-phase3.js   # modes, model choice, history, settings, tray, drag-to-move
node tests/e2e-profile.js   # CV/notes upload, About me, what reaches Claude, caching
node tests/e2e-installer.js  # silent install, packaged app, auto-update 0.1.0 -> 0.1.1, uninstall
                             # (needs dist/ and dist-update/ built with OVERLAY_UPDATE_URL=http://127.0.0.1:8765/)
```

## Screen-capture protection

The **hidden** checkbox turns screen-capture protection on and off. When it's on, the overlay doesn't appear in screen shares, recordings or screenshots.
