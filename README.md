# Overlay Assistant

A floating AI assistant for Windows and Linux (Debian/Ubuntu): take a screenshot and ask Claude about it, with answers streamed into an always-on-top overlay. This is a clean-room rebuild of Cluely's feature set. See [SPEC.md](SPEC.md) for the feature inventory and roadmap.

## Run

```bash
npm install
npm start
```

On first use, paste your Anthropic API key into the chat window. It's stored encrypted via Electron `safeStorage`: with Windows DPAPI, or on Linux with the system keyring (GNOME Keyring or KWallet). Alternatively, set `ANTHROPIC_API_KEY` before starting.

## Hotkeys

| Keys | Action |
|---|---|
| `Ctrl+Enter` | Screenshot the screen and ask |
| `Ctrl+\` | Hide / show everything |
| `Ctrl+R` | New session (saves the current one to History) |
| `Ctrl+Shift+L` | Start / stop listening |
| `Ctrl+Arrows` | Move the overlay |
| `Ctrl+Shift+Up/Down` | Scroll the answer |

On Linux in a Wayland session, these hotkeys only work while the overlay has focus. See [Linux](#linux) for desktop shortcuts that work from any app.

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

## Building the Debian package

`npm run dist` builds the installer for the OS it runs on. On Linux it writes `dist/overlay-assistant_<version>_amd64.deb`, with the same bundled speech model. It works on Debian, Ubuntu and their derivatives (x64).

## Linux

Install the package:

```bash
sudo apt install ./overlay-assistant_<version>_amd64.deb
```

This installs the app to `/opt/Overlay Assistant`, adds it to your app menu and adds the `overlay-assistant` command. To remove it, run `sudo apt remove overlay-assistant`.

Everything works as on Windows, except:

- **Hotkeys in Wayland sessions.** GNOME and KDE use Wayland by default, and there the hotkeys only work while the overlay has focus. To use them from any app, add keyboard shortcuts in your desktop's settings that run these commands. On GNOME, go to Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts. The normal hotkeys work in X11 sessions.

  | Command | Action |
  |---|---|
  | `overlay-assistant --ask` | Screenshot the screen and ask |
  | `overlay-assistant --toggle` | Hide / show everything |
  | `overlay-assistant --listen` | Start / stop listening |
  | `overlay-assistant --new-session` | New session |

- **Screenshots in Wayland sessions.** The first time you click **Ask** on the bar, your desktop asks "Allow Overlay Assistant to take screenshots?". Choose **Allow**, and from then on screenshots are taken without asking, including from the shortcuts above. The desktop only asks while the overlay has focus, so make that first Ask a click on the bar. Until you allow it, or if you deny it, each screenshot opens the screen-sharing dialog instead. X11 sessions never ask.
- **Window placement.** The overlay runs through XWayland so that it can position itself and stay on top. Wayland ignores where apps put their own windows. The app-menu entry starts it that way. Started any other way, for example with `overlay-assistant` in a terminal, it restarts itself once.
- **Computer audio.** "Them" is recorded from the monitor of your default output device, through PipeWire or PulseAudio.
- **Screen-capture protection.** Linux can't keep a window out of a capture, so the **hidden** toggle works differently:
  - *Screen shares and recordings:* the overlay hides itself while the screen is being shared or recorded (anything that captures through PipeWire, which is every screen share in a Wayland session) and comes back when that ends. Ctrl+\ brings it back sooner, visible in the share. To use the overlay during a share without it being seen, share a single window instead of the screen, or keep the overlay on a monitor you aren't sharing. This needs `pw-dump` (package `pipewire-bin`); without it the toggle isn't shown.
  - *Screenshots (GNOME):* the app installs a small GNOME Shell extension for your user (`screenshot-hide@overlay-assistant`, in `~/.local/share/gnome-shell/extensions`) that leaves the overlay out of screenshots taken by GNOME: the Print key, the screenshot tool and the screenshot portal. GNOME only picks up new extensions at login, so after the first start **log out and back in once**; Settings → Privacy shows when it is active. On other desktops screenshots still include the overlay.
- **Key storage.** API keys are encrypted with GNOME Keyring or KWallet. If neither is running, keys are saved without encryption, and Settings says so.
- **Tray icon.** GNOME shows the tray icon only with the AppIndicator extension (`gnome-shell-extension-appindicator`). Without it, open Settings with the ⚙ button on the bar.
- **Updates.** Updates download in the background as on Windows. They install only when you choose **Restart to update**, which asks for your password, because it runs `dpkg -i` through `pkexec`.

## Releases and auto-update

Updates come from this repo's GitHub Releases. To ship a new version:

1. Bump `version` in `package.json`.
2. Commit and push.
3. Run `npm run release -- --notes "What changed"` on Windows.
4. To ship the Linux package too, run `npm run release` on Linux from the same commit.

The release script builds this OS's installer and publishes it as release `v<version>`, using your `gh` login. On Windows that's the installer with `latest.yml`; on Linux it's the `.deb` with `latest-linux.yml`. Whichever OS runs second adds its files to the existing release. The script refuses to run if you have uncommitted or unpushed changes, if the release already has this OS's installer, or if the release was made from a different commit.

The installed app checks for updates 10 seconds after it starts and every 4 hours after that. It downloads new versions in the background. When an update is ready, the tray menu shows **Restart to update**. On Windows it also installs when you next quit.

**The repo is private, so each install needs a token to download updates.** No token is built into the installer, because anyone with the file could extract it. To set one up:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → `overlay-assistant`
   - Permissions: **Contents: Read-only**
2. Paste it in the app under **Settings → General → Updates**. It's stored encrypted, like the API key.

Without a token, the app runs normally and shows "Updates need a GitHub token".

To use a plain static host instead, such as S3, build with `OVERLAY_UPDATE_URL=https://host/path/ npm run dist`. Then upload `latest.yml`, the installer and its `.blockmap` to that URL. For Linux, upload `latest-linux.yml` and the `.deb`.

**If the build fails with "Cannot create symbolic link":** electron-builder's winCodeSign archive contains macOS symlinks that Windows can't create without admin rights or Developer Mode. Turn on Developer Mode, or extract the archive into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` and ignore the two `darwin` errors.

## Tests

```bash
node tests/e2e-phase1.js   # overlay, screenshot, ask, history (mock Claude API)
node tests/stt-unit.js     # local Whisper on a spoken fixture (downloads the model)
node tests/stt-bundled.js  # same, offline from build/models: nothing downloaded
node tests/e2e-phase2.js   # fake mic -> VAD -> Whisper -> transcript -> Claude request
node tests/e2e-phase3.js   # modes, model choice, history, settings, tray, drag-to-move
node tests/e2e-profile.js   # CV/notes upload, About me, what reaches Claude, caching
node tests/e2e-conversation.js  # history stays valid for Claude's thinking: mode/profile changes, errors,
                                # refusals, interrupted answers; --toggle/--ask/--new-session/--listen
node tests/e2e-installer.js  # silent install, packaged app, auto-update 0.1.0 -> 0.1.1, uninstall
                             # (needs dist/ and dist-update/ built with OVERLAY_UPDATE_URL=http://127.0.0.1:8765/)
node tests/e2e-deb.js        # Linux: .deb layout, packaged app, --ask, update download (install needs root)
                             # (needs dist/ and a newer dist-update/, both built with that OVERLAY_UPDATE_URL)
```

On Linux, run the window tests in a virtual X display. That way the hotkeys can register and no windows open on your desktop:

```bash
env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a -s "-screen 0 1920x1080x24" npm test
```

## Screen-capture protection

The **hidden** checkbox turns screen-capture protection on and off. When it's on, the overlay doesn't appear in screen shares, recordings or screenshots. On Linux it works differently: the overlay hides itself while a screen share or recording is running (see the Linux notes above).
