// Persistence: settings.json (incl. modes) and one JSON file per session under sessions/.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
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

const DEFAULT_SETTINGS = {
  contentProtection: true,
  listenMic: true,
  listenSystem: true,
  model: MODELS[0].id,
  modes: DEFAULT_MODES,
  activeModeId: "general",
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.sessionsDir = path.join(dir, "sessions");
    this.settingsFile = path.join(dir, "settings.json");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS };
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, "utf8")));
    } catch {}
    if (!MODELS.some((m) => m.id === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model;
  }

  save() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  update(patch) {
    const allowed = ["contentProtection", "listenMic", "listenSystem", "model"];
    for (const key of allowed) if (key in patch) this.settings[key] = patch[key];
    if (!MODELS.some((m) => m.id === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model;
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

module.exports = { Store, MODELS };
