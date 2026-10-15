const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, safeStorage, session } = require("electron");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const { WhisperSTT } = require("./stt/whisper");
const { Store, MODELS } = require("./store");
const { createTray } = require("./tray");
const { setupUpdater } = require("./updater");

const BAR = { width: 600, height: 52 };
const CHAT = { width: 620, height: 460 };
const MOVE_STEP = 40;
const BASE_PROMPT =
  "You are a concise on-screen assistant. The user may attach a screenshot of their screen. " +
  "Answer the question directly, using the screenshot for context. If there is no question, " +
  "explain what is on screen that the user most likely needs help with and give the answer. " +
  "Prefer short answers with code blocks or bullet points where useful. " +
  "When a live conversation transcript is included, 'Them' is the other party and 'You' is the user; " +
  "if the latest thing they said is a question, give the user a strong answer they can say out loud.";
const TRANSCRIPT_CHARS = 6000;
// Server-side refusal fallback is available for these models (not Haiku).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

let store;
let bar, chat, audioWin, settingsWin, tray, updater;
let history = [];
let activeStream = null;

let stt = null;
let listening = false;
let transcript = []; // { speaker: "you" | "them", text, at }
let current = null; // session being recorded; created lazily

// ---------- settings / API key ----------

// Secrets are stored encrypted with the OS keystore (DPAPI on Windows) via safeStorage.
function getSecret(field) {
  const enc = store.settings[field];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.decryptString(Buffer.from(enc, "base64"));
}

function setSecret(field, value) {
  if (value) store.settings[field] = safeStorage.encryptString(value.trim()).toString("base64");
  else delete store.settings[field];
  store.save();
  settingsChanged();
}

const getApiKey = () => process.env.ANTHROPIC_API_KEY || getSecret("encryptedKey");
const setApiKey = (key) => setSecret("encryptedKey", key);
const clearApiKey = () => setSecret("encryptedKey", null);

// Read-only GitHub token for update downloads from the private release repo.
const getUpdateToken = () => getSecret("encryptedUpdateToken");
function setUpdateToken(token) {
  setSecret("encryptedUpdateToken", token);
  updater?.refresh();
}

function publicSettings() {
  const s = store.settings;
  return {
    contentProtection: s.contentProtection,
    listenMic: s.listenMic,
    listenSystem: s.listenSystem,
    model: s.model,
    models: MODELS,
    modes: s.modes,
    activeModeId: store.activeMode.id,
    hasApiKey: Boolean(getApiKey()),
    keyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
    hasUpdateToken: Boolean(store.settings.encryptedUpdateToken),
  };
}

function settingsChanged() {
  const s = publicSettings();
  for (const w of [bar, chat, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send("settings-changed", s);
  for (const w of [bar, chat, settingsWin]) if (w && !w.isDestroyed()) w.setContentProtection(s.contentProtection);
  tray?.refresh();
}

// ---------- windows ----------

const webPreferences = () => ({
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
});

function overlayWindow(opts) {
  const win = new BrowserWindow({
    ...opts,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(store.settings.contentProtection);
  return win;
}

function defaultBarPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: Math.round(workArea.x + (workArea.width - BAR.width) / 2), y: workArea.y + 12 };
}

// A saved position is only reused if the bar would still be fully on some display.
function isOnScreen({ x, y }) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x && y >= a.y && x + BAR.width <= a.x + a.width && y + BAR.height <= a.y + a.height);
}

function ensureBarOnScreen() {
  if (!isOnScreen(bar.getBounds())) {
    const { x, y } = defaultBarPosition();
    bar.setPosition(x, y);
  }
  if (chat.isVisible()) positionChatUnderBar();
}

function createWindows() {
  const saved = store.settings.barPosition;
  const { x, y } = saved && isOnScreen(saved) ? saved : defaultBarPosition();

  bar = overlayWindow({ ...BAR, x, y });
  bar.loadFile(path.join(__dirname, "renderer", "control.html"));
  bar.once("ready-to-show", () => bar.showInactive());
  // Dragging the bar (it is an app-region: drag surface) carries the chat window along.
  bar.on("move", () => chat?.isVisible() && positionChatUnderBar());
  bar.on("moved", saveBarPosition);
  screen.on("display-removed", ensureBarOnScreen);
  screen.on("display-metrics-changed", ensureBarOnScreen);

  chat = overlayWindow({
    ...CHAT,
    x: Math.round(x + (BAR.width - CHAT.width) / 2),
    y: y + BAR.height + 8,
  });
  chat.loadFile(path.join(__dirname, "renderer", "chat.html"));

  audioWin = new BrowserWindow({
    show: false,
    webPreferences: { ...webPreferences(), backgroundThrottling: false },
  });
  audioWin.loadFile(path.join(__dirname, "renderer", "audio.html"));
}

function openSettings(tab = "general") {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("settings-tab", tab);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    title: "Overlay Assistant — Settings",
    backgroundColor: "#16161a",
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(),
  });
  settingsWin.setContentProtection(store.settings.contentProtection);
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"), { hash: tab });
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => (settingsWin = null));
}

function setupMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  // getDisplayMedia from the audio window gets the primary screen plus Windows loopback audio.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const [source] = await desktopCapturer.getSources({ types: ["screen"] });
    cb({ video: source, audio: "loopback" });
  });
}

function positionChatUnderBar() {
  const b = bar.getBounds();
  chat.setBounds({
    x: Math.round(b.x + (b.width - CHAT.width) / 2),
    y: b.y + b.height + 8,
    width: CHAT.width,
    height: CHAT.height,
  });
}

function showChat() {
  positionChatUnderBar();
  if (!chat.isVisible()) chat.showInactive();
  bar.webContents.send("chat-visibility", true);
}

function toggleChat() {
  if (chat.isVisible()) {
    chat.hide();
    bar.webContents.send("chat-visibility", false);
  } else {
    showChat();
  }
}

let hidden = false;
function toggleAll() {
  hidden = !hidden;
  if (hidden) {
    bar.hide();
    chat.hide();
  } else {
    bar.showInactive();
  }
  tray?.refresh();
}

function saveBarPosition() {
  const { x, y } = bar.getBounds();
  store.settings.barPosition = { x, y };
  store.save();
}

function moveBy(dx, dy) {
  const b = bar.getBounds();
  bar.setPosition(b.x + dx, b.y + dy);
  if (chat.isVisible()) positionChatUnderBar();
  saveBarPosition();
}

// ---------- screenshot ----------

async function captureScreen() {
  const display = screen.getDisplayNearestPoint(bar.getBounds());
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  return source.thumbnail.toPNG().toString("base64");
}

// ---------- sessions ----------

function currentSession() {
  current ??= store.newSession(store.activeMode);
  return current;
}

function endSession() {
  if (current) store.saveSession(current);
  current = null;
}

// ---------- listening ----------

function sendStatus(status) {
  chat.webContents.send("listen-status", status);
  bar.webContents.send("listen-status", status);
}

function ensureStt() {
  stt ??= new WhisperSTT({
    cacheDir: process.env.OVERLAY_MODEL_CACHE ?? path.join(app.getPath("userData"), "models"),
    onProgress: ({ progress }) =>
      sendStatus({ listening, message: `Downloading speech model… ${Math.round(progress)}%` }),
  });
  return stt;
}

async function startListening() {
  listening = true;
  tray?.refresh();
  showChat();
  sendStatus({ listening, message: "Loading speech model…" });
  try {
    await ensureStt().ready;
  } catch (err) {
    listening = false;
    tray?.refresh();
    stt?.dispose();
    stt = null; // next Listen click starts a fresh load
    sendStatus({ listening, message: `Speech model failed: ${err.message}` });
    return;
  }
  if (!listening) return;
  const { listenMic: mic, listenSystem: system } = store.settings;
  audioWin.webContents.send("audio-start", { mic, system });
}

function stopListening() {
  listening = false;
  tray?.refresh();
  audioWin.webContents.send("audio-stop");
}

function toggleListening() {
  listening ? stopListening() : startListening();
}

async function handleSegment(speaker, samples) {
  if (!stt) return;
  try {
    const text = await stt.transcribe(samples);
    if (!text) return;
    const line = { speaker, text, at: Date.now() };
    transcript.push(line);
    const s = currentSession();
    s.transcript.push(line);
    store.saveSession(s);
    chat.webContents.send("transcript", line);
  } catch (err) {
    console.error("transcription failed:", err);
  }
}

function transcriptText() {
  let out = "";
  for (let i = transcript.length - 1; i >= 0 && out.length < TRANSCRIPT_CHARS; i--) {
    const { speaker, text } = transcript[i];
    out = `${speaker === "you" ? "You" : "Them"}: ${text}\n` + out;
  }
  return out.trim();
}

// ---------- Claude ----------

function systemPrompt() {
  const mode = store.activeMode;
  return mode.prompt.trim() ? `${BASE_PROMPT}\n\nMode: ${mode.name}\n${mode.prompt.trim()}` : BASE_PROMPT;
}

async function ask({ text, withScreenshot }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    showChat();
    chat.webContents.send("need-api-key");
    return;
  }

  showChat();
  const content = [];
  if (withScreenshot) {
    try {
      const png = await captureScreen();
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: png } });
    } catch (err) {
      chat.webContents.send("answer-error", `Screenshot failed: ${err.message}`);
      return;
    }
  }
  const live = transcriptText();
  if (live) {
    content.push({ type: "text", text: `<live_transcript>\n${live}\n</live_transcript>` });
  }
  const question = text?.trim() || (live ? "What should I say next?" : "What's on my screen and what should I do?");
  content.push({ type: "text", text: question });

  history.push({ role: "user", content });
  chat.webContents.send("question", { text: question, withScreenshot });

  activeStream?.abort();
  const model = store.settings.model;
  const client = new Anthropic({ apiKey });
  const params = {
    model,
    max_tokens: 16000,
    output_config: { effort: "low" },
    system: systemPrompt(),
    messages: history,
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = client.beta.messages.stream(params);
  activeStream = stream;

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        chat.webContents.send("answer-delta", event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      history.pop();
      chat.webContents.send("answer-error", "Claude declined to answer this request.");
      return;
    }
    history.push({ role: "assistant", content: final.content });
    chat.webContents.send("answer-done");

    const s = currentSession();
    s.exchanges.push({
      at: Date.now(),
      question,
      withScreenshot,
      model: final.model,
      answer: final.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    });
    store.saveSession(s);
  } catch (err) {
    history.pop();
    if (stream.aborted) return;
    chat.webContents.send("answer-error", err.message);
  } finally {
    if (activeStream === stream) activeStream = null;
  }
}

function reset() {
  activeStream?.abort();
  activeStream = null;
  history = [];
  transcript = [];
  endSession();
  chat.webContents.send("reset");
  settingsWin?.webContents.send("sessions-changed");
}

function setMode(id) {
  store.setActiveMode(id);
  if (current && !current.exchanges.length && !current.transcript.length) current = null;
  settingsChanged();
}

// ---------- hotkeys / IPC ----------

function registerShortcuts() {
  const keys = {
    "CommandOrControl+\\": toggleAll,
    "CommandOrControl+Enter": () => ask({ text: "", withScreenshot: true }),
    "CommandOrControl+R": reset,
    "CommandOrControl+Shift+L": toggleListening,
    "CommandOrControl+Up": () => moveBy(0, -MOVE_STEP),
    "CommandOrControl+Down": () => moveBy(0, MOVE_STEP),
    "CommandOrControl+Left": () => moveBy(-MOVE_STEP, 0),
    "CommandOrControl+Right": () => moveBy(MOVE_STEP, 0),
    "CommandOrControl+Shift+Up": () => chat.webContents.send("scroll", -120),
    "CommandOrControl+Shift+Down": () => chat.webContents.send("scroll", 120),
  };
  for (const [accel, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(accel, fn)) console.warn(`Hotkey unavailable: ${accel}`);
  }
}

ipcMain.handle("ask", (_e, payload) => ask(payload));
ipcMain.handle("reset", reset);
ipcMain.handle("toggle-chat", toggleChat);
ipcMain.handle("hide", toggleAll);
ipcMain.handle("toggle-listen", toggleListening);
ipcMain.on("audio-segment", (_e, speaker, samples) => handleSegment(speaker, samples));
ipcMain.on("audio-level", (_e, speaker, rms) => chat.webContents.send("audio-level", speaker, rms));
ipcMain.on("audio-status", (_e, { running, errors }) => {
  if (!running.length) listening = false;
  tray?.refresh();
  const message = [running.length ? `Listening: ${running.join(" + ")}` : "Not listening", ...errors].join(" · ");
  sendStatus({ listening, message });
});
ipcMain.handle("quit", () => app.quit());
ipcMain.handle("focus-chat", () => {
  showChat();
  chat.focus();
});
ipcMain.handle("open-settings", (_e, tab) => openSettings(tab));

ipcMain.handle("get-settings", publicSettings);
ipcMain.handle("update-settings", (_e, patch) => {
  store.update(patch);
  settingsChanged();
});
ipcMain.handle("set-content-protection", (_e, on) => {
  store.update({ contentProtection: on });
  settingsChanged();
});
ipcMain.handle("set-api-key", (_e, key) => setApiKey(key));
ipcMain.handle("clear-api-key", clearApiKey);
ipcMain.handle("set-update-token", (_e, token) => setUpdateToken(token));
ipcMain.handle("clear-update-token", () => setUpdateToken(null));

ipcMain.handle("set-mode", (_e, id) => setMode(id));
ipcMain.handle("save-mode", (_e, mode) => {
  const id = store.saveMode(mode);
  settingsChanged();
  return id;
});
ipcMain.handle("delete-mode", (_e, id) => {
  store.deleteMode(id);
  settingsChanged();
});

ipcMain.handle("get-app-info", () => ({
  version: app.getVersion(),
  update: updater.getStatus(),
  privateFeed: Boolean(updater.privateFeed),
}));
ipcMain.handle("check-for-updates", () => updater.check());
ipcMain.handle("install-update", () => updater.install());

ipcMain.handle("list-sessions", () => {
  if (current) store.saveSession(current);
  return store.listSessions();
});
ipcMain.handle("get-session", (_e, id) => store.getSession(id));
ipcMain.handle("delete-session", (_e, id) => {
  if (current?.id === id) current = null;
  store.deleteSession(id);
});
ipcMain.handle("clear-sessions", () => {
  current = null;
  store.clearSessions();
});

// ---------- lifecycle ----------

// Lets tests run against an isolated profile.
if (process.env.OVERLAY_USER_DATA) app.setPath("userData", process.env.OVERLAY_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  store = new Store(app.getPath("userData"));
  setupMediaPermissions();
  createWindows();
  registerShortcuts();
  tray = createTray({
    getState: () => ({
      visible: !hidden,
      listening,
      modes: store.settings.modes,
      activeModeId: store.activeMode.id,
      update: updater?.getStatus(),
    }),
    actions: {
      installUpdate: () => updater.install(),
      toggleAll,
      askScreen: () => ask({ text: "", withScreenshot: true }),
      toggleListening,
      reset,
      setMode,
      openSettings,
      quit: () => app.quit(),
    },
  });
  updater = setupUpdater({
    onStatus: (status) => {
      tray?.refresh();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("update-status", status);
    },
    getToken: getUpdateToken,
  });
  tray.refresh();
  if (process.env.OVERLAY_TEST) global.__overlayTest = { tray, store, updater };
});

app.on("second-instance", () => {
  if (hidden) toggleAll();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  endSession();
  stt?.dispose();
});
// The overlay keeps running in the tray when the settings window closes.
app.on("window-all-closed", () => {});
