const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, safeStorage, session, clipboard } = require("electron");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const { WhisperSTT, findBundledModels } = require("./stt/whisper");
const { DeepgramSTT } = require("./stt/deepgram");
const { Store, MODELS, STT_ENGINES } = require("./store");
const { createTray } = require("./tray");
const { setupUpdater } = require("./updater");

const BAR = { width: 600, height: 52 };
const CHAT = { width: 620, height: 460 };
const MOVE_STEP = 40;
const BASE_PROMPT =
  "You are an expert on-screen co-pilot and real-time meeting and interview assistant. The user may attach a screenshot of their screen. " +
  "Answer the question directly, using the screenshot for context. If there is no question, " +
  "explain what is on screen that the user most likely needs help with and give the answer. " +
  "When a live conversation transcript is included, 'Them' is the interviewer or other party and 'You' is the user. " +
  "Always identify the most recent question, inquiry, or topic from 'Them' and give the user a direct, confident, " +
  "and articulate answer they can say out loud in response in the first person ('I'). " +
  "TONE & STYLE: Make the answer sound completely natural and conversational, exactly like a genuine human candidate speaking out loud. " +
  "Keep formatting clean, simple, and effortless to read at a glance while talking. Do NOT use stiff robotic section labels (such as '**Background:**', '**Approach:**', '**Solution:**'). " +
  "Instead, write in short, punchy paragraphs (1-3 spoken sentences each) or clean conversational bullet points. " +
  "CRITICAL: Never say 'there is no mention of this on the profile', 'my profile doesn't mention this', 'not in my profile', or say that information is missing. " +
  "If something was not explicitly stated in the user's background, provide the closest, most plausible and compelling answer based on related experience and industry best practices. " +
  "Do NOT say 'You should say:' or 'Here is a suggested answer:'. Output ONLY the natural words to speak.";
const TRANSCRIPT_CHARS = 6000;
// Server-side refusal fallback is available for these models (not Haiku).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

let store;
let bar, chat, audioWin, settingsWin, tray, updater;
let history = [];
let activeStream = null;
let autoAnswerTimer = null;

let stt = null;
let deepgramStt = null; // per-speaker DeepgramSTT instances
let listening = false;
let transcript = []; // { speaker: "you" | "them", text, at }
let current = null; // session being recorded; created lazily

// Noise & hallucination filter for STT silence
const NOISE_FILTER = /^\s*([\[(].*[\])]|thank you|thanks for watching|you|okay|ok|yeah|bye|yes|no|music|applause|laughter|silence|um|uh|ah)[.!]?\s*$/i;

function isEchoOfThem(youText) {
  const normYou = youText.toLowerCase().replace(/[^\w\s]/g, "").trim();
  if (!normYou || normYou.length < 3) return true;
  const now = Date.now();
  // Check lines from "them" in the last 10 seconds
  const recentThem = transcript.filter((t) => t.speaker === "them" && now - t.at < 10000);
  for (const t of recentThem) {
    const normThem = t.text.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (normThem.includes(normYou) || normYou.includes(normThem)) return true;
    const wordsYou = normYou.split(/\s+/).filter(Boolean);
    const wordsThem = new Set(normThem.split(/\s+/).filter(Boolean));
    let match = 0;
    for (const w of wordsYou) if (wordsThem.has(w)) match++;
    if (wordsYou.length > 0 && match / wordsYou.length >= 0.5) return true;
  }
  return false;
}

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

const getDeepgramKey = () => process.env.DEEPGRAM_API_KEY || getSecret("encryptedDeepgramKey");
const setDeepgramKey = (key) => setSecret("encryptedDeepgramKey", key);
const clearDeepgramKey = () => setSecret("encryptedDeepgramKey", null);

function publicSettings() {
  const s = store.settings;
  return {
    contentProtection: s.contentProtection,
    listenMic: s.listenMic,
    listenSystem: s.listenSystem,
    autoAnswer: s.autoAnswer !== false,
    fastAutoReply: s.fastAutoReply !== false,
    echoCancellation: s.echoCancellation !== false,
    model: s.model,
    models: MODELS,
    sttEngine: s.sttEngine,
    sttEngines: STT_ENGINES,
    modes: s.modes,
    activeModeId: store.activeMode.id,
    hasApiKey: Boolean(getApiKey()),
    keyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
    hasUpdateToken: Boolean(store.settings.encryptedUpdateToken),
    hasDeepgramKey: Boolean(getDeepgramKey()),
    deepgramKeyFromEnv: Boolean(process.env.DEEPGRAM_API_KEY),
    workspaceId: s.workspaceId ?? "",
    aboutMe: s.aboutMe,
    profileDocs: s.profileDocs,
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
  ses.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media" || permission === "clipboard-sanitized-write" || permission === "clipboard-read"));
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
  // The installer ships the model in resources/models; dev runs use build/models after
  // `node scripts/fetch-model.js`. Without either, it downloads into the user's cache.
  const bundledDir = findBundledModels([
    app.isPackaged && path.join(process.resourcesPath, "models"),
    path.join(__dirname, "..", "build", "models"),
  ]);
  stt ??= new WhisperSTT({
    bundledDir,
    cacheDir: process.env.OVERLAY_MODEL_CACHE ?? path.join(app.getPath("userData"), "models"),
    onProgress: ({ progress }) =>
      sendStatus({ listening, message: `Downloading speech model… ${Math.round(progress)}%` }),
  });
  return stt;
}

// Deepgram streaming: one connection per speaker, real-time results
function createDeepgramForSpeaker(speaker) {
  const apiKey = getDeepgramKey();
  if (!apiKey) throw new Error("Deepgram API key not set");

  // Buffer for assembling partial utterances into complete ones
  let partialText = "";

  return new DeepgramSTT({
    apiKey,
    model: "nova-3",
    language: "en",
    onTranscript: ({ text, isFinal, speechFinal, isUtteranceEnd }) => {
      if (isUtteranceEnd) {
        // Flush any buffered partial as a final line
        if (partialText.trim()) {
          commitTranscriptLine(speaker, partialText.trim());
          partialText = "";
        }
        return;
      }

      if (isFinal) {
        // Accumulate final segments within the same utterance
        partialText += (partialText ? " " : "") + text;
        if (speechFinal) {
          // Full utterance done — commit it
          if (partialText.trim()) {
            commitTranscriptLine(speaker, partialText.trim());
          }
          partialText = "";
        }
      } else {
        // Interim (partial) result — show it live for real-time feedback
        const preview = partialText ? `${partialText} ${text}` : text;
        chat.webContents.send("transcript-interim", { speaker, text: preview });
      }
    },
    onError: (err) => console.error(`Deepgram (${speaker}):`, err.message),
    onOpen: () => console.log(`Deepgram (${speaker}) connected`),
    onClose: (code) => console.log(`Deepgram (${speaker}) closed: ${code}`),
  });
}

function scheduleAutoAnswer() {
  clearTimeout(autoAnswerTimer);
  const latestThem = transcript.slice().reverse().find((t) => t.speaker === "them");
  if (!latestThem) return;
  // Trigger faster (250ms) when Them asked a clear question or spoke a full clause, else 550ms
  const looksComplete = latestThem.text.includes("?") || latestThem.text.split(/\s+/).length >= 6;
  const delay = looksComplete ? 250 : 550;

  autoAnswerTimer = setTimeout(() => {
    if (!listening) return;
    // Do not interrupt a manual user ask; only supersede an older auto-reply if a new line arrived
    if (activeStream && !activeStream._isAuto) return;
    const currentThem = transcript.slice().reverse().find((t) => t.speaker === "them");
    if (!currentThem) return;
    if (currentThem.at <= (commitTranscriptLine.lastAutoAnsweredAt || 0)) return;
    // Don't auto-answer if You already spoke after Them
    const latestAny = transcript.at(-1);
    if (latestAny?.speaker === "you") return;

    commitTranscriptLine.lastAutoAnsweredAt = currentThem.at;
    ask({ text: "", withScreenshot: false, isAuto: true });
  }, delay);
}

function commitTranscriptLine(speaker, text) {
  text = String(text ?? "").trim();
  if (!text) return;

  if (speaker === "you") {
    // Drop silence / noise hallucinations
    if (NOISE_FILTER.test(text)) return;
    // Drop acoustic bleed from computer speakers
    if (isEchoOfThem(text)) return;
  }

  const line = { speaker, text, at: Date.now() };
  transcript.push(line);
  const s = currentSession();
  s.transcript.push(line);
  store.saveSession(s);
  chat.webContents.send("transcript", line);

  if (speaker === "them" && store.settings.autoAnswer !== false) {
    scheduleAutoAnswer();
  }
}

async function startListening() {
  listening = true;
  tray?.refresh();
  showChat();

  const engine = store.settings.sttEngine;

  if (engine === "deepgram") {
    // Streaming cloud STT — connect WebSockets per speaker
    const dgKey = getDeepgramKey();
    if (!dgKey) {
      listening = false;
      tray?.refresh();
      sendStatus({ listening, message: "Deepgram API key not set. Add it in Settings → General." });
      return;
    }

    sendStatus({ listening, message: "Connecting to Deepgram…" });
    deepgramStt = {};
    const { listenMic: mic, listenSystem: system } = store.settings;
    try {
      if (mic) {
        deepgramStt.you = createDeepgramForSpeaker("you");
        await deepgramStt.you.connect();
      }
      if (system) {
        deepgramStt.them = createDeepgramForSpeaker("them");
        await deepgramStt.them.connect();
      }
    } catch (err) {
      listening = false;
      tray?.refresh();
      await stopDeepgram();
      sendStatus({ listening, message: `Deepgram failed: ${err.message}` });
      return;
    }
    if (!listening) { await stopDeepgram(); return; }
    // Tell the audio window to start capturing (it sends raw audio frames via IPC)
    const echoCancellation = store.settings.echoCancellation !== false;
    audioWin.webContents.send("audio-start", { mic, system, streaming: true, echoCancellation });
  } else {
    // Local Whisper STT — load model, then start audio capture
    sendStatus({ listening, message: "Loading speech model…" });
    try {
      await ensureStt().ready;
    } catch (err) {
      listening = false;
      tray?.refresh();
      stt?.dispose();
      stt = null;
      sendStatus({ listening, message: `Speech model failed: ${err.message}` });
      return;
    }
    if (!listening) return;
    const { listenMic: mic, listenSystem: system } = store.settings;
    const echoCancellation = store.settings.echoCancellation !== false;
    audioWin.webContents.send("audio-start", { mic, system, streaming: false, echoCancellation });
  }
}

async function stopDeepgram() {
  if (deepgramStt) {
    const closes = Object.values(deepgramStt).map((d) => d.close());
    deepgramStt = null;
    await Promise.allSettled(closes);
  }
}

async function stopListening() {
  clearTimeout(autoAnswerTimer);
  listening = false;
  tray?.refresh();
  audioWin.webContents.send("audio-stop");
  await stopDeepgram();
}

function toggleListening() {
  listening ? stopListening() : startListening();
}

async function handleSegment(speaker, samples) {
  if (!stt) return;
  try {
    const text = await stt.transcribe(samples);
    if (!text) return;
    commitTranscriptLine(speaker, text);
  } catch (err) {
    console.error("transcription failed:", err);
  }
}

// Handle raw audio frames for Deepgram streaming
function handleAudioFrame(speaker, samples) {
  const dg = deepgramStt?.[speaker];
  if (dg?.isConnected) {
    dg.sendAudio(samples);
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

const PROFILE_PROMPT =
  "The conversation opens with the user's profile: their own documents (such as a CV) and notes about themselves. " +
  "When a question is about the user's background, experience, skills, projects or motivations, answer in the first " +
  "person ('I') as the user would say it out loud, using facts from the profile as your primary foundation. " +
  "Make the response sound like a natural, confident human answer that is easy to read aloud at a glance. " +
  "Avoid artificial template headers or rigid academic phrasing. " +
  "CRITICAL RULE: NEVER say 'there is no mention of this in the profile', 'my profile doesn't mention', 'not in the profile', " +
  "or that any information is missing. Never refer to the profile or CV as a document. " +
  "If an interviewer asks about a skill, tool, framework, project, or scenario that is not explicitly in the profile, " +
  "do NOT refuse or state that it is absent. Instead, provide the closest, strongest answer yourself in the user's voice, " +
  "bridging to related skills and transferable experience from the profile so the user has an immediate, natural response to speak.";

function systemPrompt(hasProfile) {
  const mode = store.activeMode;
  let prompt = BASE_PROMPT;
  if (hasProfile) prompt += `\n\n${PROFILE_PROMPT}`;
  if (mode.prompt.trim()) prompt += `\n\nMode: ${mode.name}\n${mode.prompt.trim()}`;
  return prompt;
}

// The profile goes first as a fixed user/assistant exchange so it stays a stable, cached prefix.
function profileMessages() {
  const docs = store.readProfileDocs();
  const aboutMe = store.settings.aboutMe.trim();
  if (!docs.length && !aboutMe) return [];

  const content = [{ type: "text", text: "Here is my profile. Use it whenever a question is about me." }];
  for (const doc of docs) {
    content.push({
      type: "document",
      title: doc.name,
      source: doc.kind === "pdf"
        ? { type: "base64", media_type: "application/pdf", data: doc.data }
        : { type: "text", media_type: "text/plain", data: doc.data },
    });
  }
  if (aboutMe) content.push({ type: "text", text: `<about_me>\n${aboutMe}\n</about_me>` });
  content.at(-1).cache_control = { type: "ephemeral" };

  return [
    { role: "user", content },
    { role: "assistant", content: [{ type: "text", text: "Understood. I will answer in your voice using your background as context, seamlessly providing the closest, strongest answer to any question without ever mentioning the profile or saying information is missing." }] },
  ];
}

let cachedClient = null;
let cachedClientKey = "";

function getAnthropicClient(apiKey, workspaceId) {
  const key = `${apiKey}|${workspaceId || ""}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClientKey = key;
  cachedClient = new Anthropic({
    apiKey,
    ...(workspaceId && { defaultHeaders: { "anthropic-workspace-id": workspaceId } }),
  });
  return cachedClient;
}

// Strip redundant <live_transcript> blocks from older turns so prompt size stays small and fast
function compactHistory(turns) {
  if (turns.length <= 2) return turns;
  const recent = turns.slice(-8); // keep last 4 exchanges
  return recent.map((msg, idx) => {
    if (idx === recent.length - 1 || msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((b) => !(b.type === "text" && b.text.startsWith("<live_transcript>")));
    return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
  });
}

async function ask({ text, withScreenshot, isAuto = false }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    showChat();
    chat.webContents.send("need-api-key");
    return;
  }

  showChat();
  clearTimeout(autoAnswerTimer);

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

  // Find the latest question or statement from Them
  const latestThem = transcript.slice().reverse().find((t) => t.speaker === "them");
  let question;
  let targetQuestion = "";

  if (text?.trim()) {
    question = text.trim();
    content.push({ type: "text", text: question });
  } else if (latestThem) {
    targetQuestion = latestThem.text;
    question = `Answer what Them asked: "${latestThem.text}"`;
    content.push({
      type: "text",
      text: `The other person / interviewer ('Them') just asked or said:\n"${latestThem.text}"\n\n` +
            `Give the user a direct, articulate, confident answer in the first person ('I') that they can say out loud in response.\n\n` +
            `NATURAL FORMATTING & STYLE GUIDELINES:\n` +
            `- Sound completely natural, genuine, and conversational—like a seasoned professional speaking in a conversation.\n` +
            `- Keep the layout simple and effortless to read at a glance: 1 to 2 short conversational paragraphs (1-3 sentences each) or 2-3 clean talking points.\n` +
            `- Do NOT use rigid robotic labels or template headers (e.g. avoid '**Context:**', '**Action Taken:**', '**Key Takeaway:**').\n` +
            `- CRITICAL: NEVER say 'there is no mention of this in the profile', 'my profile doesn't mention', 'not in my profile', or that anything is missing. Never mention the profile or CV.\n` +
            `- If the question asks about a skill, topic, scenario, or experience not explicitly in the profile, provide the closest, strongest answer yourself based on related experience and industry best practices.\n` +
            `- Provide ONLY the words to speak. Do NOT say 'You should say:' or 'Here is a suggested answer:'.`,
    });
  } else {
    question = live ? "What should I say next?" : "What's on my screen and what should I do?";
    content.push({ type: "text", text: question });
  }

  history.push({ role: "user", content });
  chat.webContents.send("question", { text: question, withScreenshot, isAuto, targetQuestion });

  activeStream?.abort();
  const model = (isAuto && store.settings.fastAutoReply !== false) ? "claude-haiku-5-5" : store.settings.model;
  // Org-level keys (not scoped to a workspace) must name the workspace on every request.
  const workspaceId = store.settings.workspaceId;
  const client = getAnthropicClient(apiKey, workspaceId);
  const profile = profileMessages();
  // Use lower max_tokens and effort when in live conversation mode for faster responses
  const isLiveConvo = Boolean(live);
  const params = {
    model,
    max_tokens: isLiveConvo ? 1024 : 16000,
    output_config: { effort: "low" },
    system: systemPrompt(profile.length > 0),
    messages: [...profile, ...compactHistory(history)],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = client.beta.messages.stream(params);
  stream._isAuto = isAuto;
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
    chat.webContents.send("answer-error", describeApiError(err));
  } finally {
    if (activeStream === stream) activeStream = null;
  }
}

// Turns common API errors into something the user can act on.
function describeApiError(err) {
  const detail = err?.error?.error?.message ?? err?.message ?? String(err);
  if (/anthropic-workspace-id/i.test(detail)) {
    return "This API key isn't tied to a workspace. Add your Workspace ID in Settings → General, " +
      "or create a new key inside a workspace in the Anthropic Console.";
  }
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it in Settings → General.";
  if (err instanceof Anthropic.PermissionDeniedError) return `This key can't use ${store.settings.model}: ${detail}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  return detail;
}

function reset() {
  clearTimeout(autoAnswerTimer);
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
ipcMain.on("audio-frame", (_e, speaker, samples) => handleAudioFrame(speaker, samples));
ipcMain.on("audio-level", (_e, speaker, rms) => chat.webContents.send("audio-level", speaker, rms));
ipcMain.on("audio-status", (_e, { running, errors }) => {
  if (!running.length) listening = false;
  tray?.refresh();
  const message = [running.length ? `Listening: ${running.join(" + ")}` : "Not listening", ...errors].join(" · ");
  sendStatus({ listening, message });
});
ipcMain.handle("quit", () => app.quit());
ipcMain.handle("copy-text", (_e, text) => clipboard.writeText(String(text ?? "")));
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
ipcMain.handle("set-deepgram-key", (_e, key) => setDeepgramKey(key));
ipcMain.handle("clear-deepgram-key", clearDeepgramKey);
ipcMain.handle("set-update-token", (_e, token) => setUpdateToken(token));
ipcMain.handle("clear-update-token", () => setUpdateToken(null));

ipcMain.handle("add-profile-doc", (_e, name, bytes) => {
  const doc = store.addProfileDoc(name, bytes);
  settingsChanged();
  return doc;
});
ipcMain.handle("remove-profile-doc", (_e, id) => {
  store.removeProfileDoc(id);
  settingsChanged();
});
ipcMain.handle("set-profile-doc-enabled", (_e, id, enabled) => {
  store.setProfileDocEnabled(id, enabled);
  settingsChanged();
});

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
  stopDeepgram();
});
// The overlay keeps running in the tray when the settings window closes.
app.on("window-all-closed", () => {});
