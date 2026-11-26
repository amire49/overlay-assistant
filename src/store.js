// Persistence: settings.json (incl. modes) and one JSON file per session under sessions/.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
];

const STT_ENGINES = [
  { id: "whisper", label: "Whisper (local, offline)" },
  { id: "deepgram", label: "Deepgram (cloud, faster)" },
];

const DEFAULT_MODES = [
  { id: "general", name: "General", prompt: "" },
  {
    id: "meeting",
    name: "Meeting",
    prompt:
      "The user is in a meeting. Track decisions, open questions and action items. When asked, " +
      "summarize what was said and suggest a short, relevant contribution the user could make.",
  },
  {
    id: "interview",
    name: "Interview",
    prompt:
      "The user is in a job interview. Answer every question directly in the first person ('I') as the candidate with confidence and poise. " +
      "Make answers sound completely natural, authentic, and conversational—never robotic or filled with artificial headers. " +
      "Keep formatting clean, simple, and effortless to read aloud at a glance (short punchy paragraphs of 1-3 spoken sentences each). " +
      "If asked about something not in your profile, provide the closest, strongest answer based on related skills and standard practices. " +
      "Never say something is missing or refer to the profile.",
  },
  {
    id: "interview",
    name: "Interview",
    prompt:
      "The user is in a job interview. Answer every question directly in the first person ('I') as the candidate with confidence and poise. " +
      "Make answers sound completely natural, authentic, and conversational—never robotic or filled with artificial headers. " +
      "Keep formatting clean, simple, and effortless to read aloud at a glance (short punchy paragraphs of 1-3 spoken sentences each). " +
      "If asked about something not in your profile, provide the closest, strongest answer based on related skills and standard practices. " +
      "Never say something is missing or refer to the profile.",
  },
  {
    id: "sales",
    name: "Sales call",
    prompt:
      "The user is on a sales call. Identify the prospect's needs and objections from the transcript " +
      "and suggest concise, honest responses and good discovery questions.",
  },
  {
    id: "coding",
    name: "Coding",
    prompt:
      "Focus on code and errors visible on screen. Identify the bug or task, explain the fix briefly, " +
      "and give corrected code.",
  },
  {
    id: "writing",
    name: "Writing",
    prompt:
      "Help with the text visible on screen: improve clarity and tone, or draft a reply. " +
      "Return ready-to-paste text.",
  },
];

// Profile documents (CV, about-me notes) sent to Claude as context with every question.
const PROFILE_TYPES = { ".pdf": "pdf", ".txt": "text", ".md": "text" };
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_DOCS = 8;
const MAX_ABOUT_ME_CHARS = 20000;

const DEFAULT_SETTINGS = {
  contentProtection: true,
  listenMic: true,
  listenSystem: true,
  autoAnswer: true, // Automatically answer when "Them" asks a question
  fastAutoReply: true, // Use Haiku for instant real-time auto-replies
  echoCancellation: true, // Suppress speaker audio bleeding into mic ("You")
  model: MODELS[0].id,
  sttEngine: "deepgram", // "deepgram" (cloud streaming) or "whisper" (local)
  modes: DEFAULT_MODES,
  activeModeId: "general",
  aboutMe: "",
  profileDocs: [], // { id, name, kind: "pdf" | "text", size, addedAt, enabled }
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.sessionsDir = path.join(dir, "sessions");
    this.profileDir = path.join(dir, "profile");
    this.settingsFile = path.join(dir, "settings.json");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.settings = structuredClone(DEFAULT_SETTINGS);
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, "utf8")));
    } catch {}
    if (!this.settings.modes.some((m) => m.id === "interview")) {
      const interviewMode = DEFAULT_MODES.find((m) => m.id === "interview");
      if (interviewMode) this.settings.modes.splice(2, 0, interviewMode);
    }
    if (!MODELS.some((m) => m.id === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model;
  }

  save() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  update(patch) {
    const allowed = ["contentProtection", "listenMic", "listenSystem", "autoAnswer", "fastAutoReply", "echoCancellation", "model", "sttEngine", "workspaceId", "aboutMe"];
    for (const key of allowed) if (key in patch) this.settings[key] = patch[key];
    this.settings.workspaceId = String(this.settings.workspaceId ?? "").trim();
    this.settings.aboutMe = String(this.settings.aboutMe ?? "").slice(0, MAX_ABOUT_ME_CHARS);
    if (!MODELS.some((m) => m.id === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model;
    if (!STT_ENGINES.some((e) => e.id === this.settings.sttEngine)) this.settings.sttEngine = DEFAULT_SETTINGS.sttEngine;
    this.save();
  }

  // ---------- modes ----------

  get activeMode() {
    return this.settings.modes.find((m) => m.id === this.settings.activeModeId) ?? this.settings.modes[0];
  }

  setActiveMode(id) {
    if (!this.settings.modes.some((m) => m.id === id)) throw new Error(`unknown mode ${id}`);
    this.settings.activeModeId = id;
    this.save();
  }

  saveMode({ id, name, prompt }) {
    name = String(name ?? "").trim();
    if (!name) throw new Error("Mode name is required");
    const existing = id && this.settings.modes.find((m) => m.id === id);
    if (existing) Object.assign(existing, { name, prompt: String(prompt ?? "") });
    else this.settings.modes.push({ id: crypto.randomUUID(), name, prompt: String(prompt ?? "") });
    this.save();
    return existing?.id ?? this.settings.modes.at(-1).id;
  }

  deleteMode(id) {
    if (this.settings.modes.length <= 1) throw new Error("At least one mode is required");
    this.settings.modes = this.settings.modes.filter((m) => m.id !== id);
    if (this.settings.activeModeId === id) this.settings.activeModeId = this.settings.modes[0].id;
    this.save();
  }

  // ---------- profile ----------

  profileFile(doc) {
    if (!/^[\w-]+$/.test(doc.id)) throw new Error("bad profile id");
    return path.join(this.profileDir, `${doc.id}${doc.kind === "pdf" ? ".pdf" : ".txt"}`);
  }

  addProfileDoc(name, bytes) {
    name = path.basename(String(name ?? "")).slice(0, 120);
    const kind = PROFILE_TYPES[path.extname(name).toLowerCase()];
    if (!kind) throw new Error("Use a PDF, .txt or .md file (save Word documents as PDF first)");
    const buf = Buffer.from(bytes);
    if (!buf.length) throw new Error("The file is empty");
    if (buf.length > MAX_PROFILE_BYTES) throw new Error("Files must be 10 MB or smaller");
    if (kind === "pdf" && buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file isn't a valid PDF");
    if (kind === "text" && buf.includes(0)) throw new Error("That file doesn't look like plain text");
    if (this.settings.profileDocs.length >= MAX_PROFILE_DOCS) throw new Error(`You can add up to ${MAX_PROFILE_DOCS} documents`);

    const doc = { id: crypto.randomUUID(), name, kind, size: buf.length, addedAt: Date.now(), enabled: true };
    fs.writeFileSync(this.profileFile(doc), buf);
    this.settings.profileDocs.push(doc);
    this.save();
    return doc;
  }

  removeProfileDoc(id) {
    const doc = this.settings.profileDocs.find((d) => d.id === id);
    if (!doc) return;
    fs.rmSync(this.profileFile(doc), { force: true });
    this.settings.profileDocs = this.settings.profileDocs.filter((d) => d.id !== id);
    this.save();
  }

  setProfileDocEnabled(id, enabled) {
    const doc = this.settings.profileDocs.find((d) => d.id === id);
    if (!doc) return;
    doc.enabled = Boolean(enabled);
    this.save();
  }

  /** Enabled documents with their contents, in the order they were added. */
  readProfileDocs() {
    const out = [];
    for (const doc of this.settings.profileDocs) {
      if (!doc.enabled) continue;
      try {
        const buf = fs.readFileSync(this.profileFile(doc));
        out.push({ ...doc, data: doc.kind === "pdf" ? buf.toString("base64") : buf.toString("utf8") });
      } catch {} // file removed outside the app
    }
    return out;
  }

  // ---------- sessions ----------

  newSession(mode) {
    return {
      id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: { id: mode.id, name: mode.name },
      transcript: [],
      exchanges: [],
    };
  }

  saveSession(s) {
    if (!s.exchanges.length && !s.transcript.length) return;
    s.updatedAt = Date.now();
    fs.writeFileSync(this.sessionFile(s.id), JSON.stringify(s, null, 2));
  }

  sessionFile(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error("bad session id");
    return path.join(this.sessionsDir, `${id}.json`);
  }

  listSessions() {
    const out = [];
    for (const f of fs.readdirSync(this.sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), "utf8"));
        out.push({
          id: s.id,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          mode: s.mode?.name ?? "",
          exchanges: s.exchanges.length,
          transcriptLines: s.transcript.length,
          preview: s.exchanges[0]?.question ?? s.transcript[0]?.text ?? "",
        });
      } catch {}
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  getSession(id) {
    return JSON.parse(fs.readFileSync(this.sessionFile(id), "utf8"));
  }

  deleteSession(id) {
    fs.rmSync(this.sessionFile(id), { force: true });
  }

  clearSessions() {
    for (const f of fs.readdirSync(this.sessionsDir)) {
      if (f.endsWith(".json")) fs.rmSync(path.join(this.sessionsDir, f), { force: true });
    }
  }
}

module.exports = { Store, MODELS, STT_ENGINES };
