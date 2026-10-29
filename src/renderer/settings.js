import { marked } from "../../node_modules/marked/lib/marked.esm.js";

const api = window.assistant;
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let settings = null;

// ---------- tabs ----------

function showTab(tab) {
  if (!["general", "profile", "modes", "history"].includes(tab)) tab = "general";
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of document.querySelectorAll("main section")) s.hidden = s.id !== `tab-${tab}`;
  if (tab === "history") loadSessions();
}

for (const b of document.querySelectorAll("nav button")) b.onclick = () => showTab(b.dataset.tab);
api.onSettingsTab(showTab);

// ---------- general ----------

function renderGeneral(s) {
  $("key-status").textContent = s.keyFromEnv
    ? "Using the ANTHROPIC_API_KEY environment variable."
    : s.hasApiKey ? "A key is saved (encrypted on this computer)." : "No key set. Get one at console.anthropic.com.";
  $("key-clear").hidden = !s.hasApiKey || s.keyFromEnv;

  if (document.activeElement !== $("workspace")) $("workspace").value = s.workspaceId;

  $("model").replaceChildren(...s.models.map((m) => el("option", { value: m.id, textContent: m.label })));
  $("model").value = s.model;
  $("listen-mic").checked = s.listenMic;
  $("listen-system").checked = s.listenSystem;
  $("auto-answer").checked = s.autoAnswer !== false;
  $("echo-cancellation").checked = s.echoCancellation !== false;
  $("protect").checked = s.contentProtection;

  // STT engine
  $("stt-engine").replaceChildren(...s.sttEngines.map((e) => el("option", { value: e.id, textContent: e.label })));
  $("stt-engine").value = s.sttEngine;
  const hints = {
    whisper: "Runs locally on your CPU. No API key needed, works offline, but slower (~2-5s per segment).",
    deepgram: "Streams audio to Deepgram's cloud for real-time transcription (~300ms latency). Requires an API key.",
  };
  $("stt-hint").textContent = hints[s.sttEngine] || "";
  $("deepgram-key-box").hidden = s.sttEngine !== "deepgram";

  // Deepgram key status
  $("deepgram-key-status").textContent = s.deepgramKeyFromEnv
    ? "Using the DEEPGRAM_API_KEY environment variable."
    : s.hasDeepgramKey ? "A key is saved (encrypted on this computer)." : "No key set. Get one at console.deepgram.com.";
  $("deepgram-key-clear").hidden = !s.hasDeepgramKey || s.deepgramKeyFromEnv;
}

$("key-form").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  if (!key) return;
  await api.setApiKey(key);
  $("key").value = "";
};
$("key-clear").onclick = () => api.clearApiKey();
$("workspace-form").onsubmit = async (e) => {
  e.preventDefault();
  await api.updateSettings({ workspaceId: $("workspace").value });
  $("workspace").blur();
};
$("model").onchange = (e) => api.updateSettings({ model: e.target.value });
$("listen-mic").onchange = (e) => api.updateSettings({ listenMic: e.target.checked });
$("listen-system").onchange = (e) => api.updateSettings({ listenSystem: e.target.checked });
$("auto-answer").onchange = (e) => api.updateSettings({ autoAnswer: e.target.checked });
$("echo-cancellation").onchange = (e) => api.updateSettings({ echoCancellation: e.target.checked });
$("stt-engine").onchange = (e) => api.updateSettings({ sttEngine: e.target.value });
$("deepgram-key-form").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("deepgram-key").value.trim();
  if (!key) return;
  await api.setDeepgramKey(key);
  $("deepgram-key").value = "";
};
$("deepgram-key-clear").onclick = () => api.clearDeepgramKey();
$("protect").onchange = (e) => api.updateSettings({ contentProtection: e.target.checked });

// ---------- updates ----------

let appVersion = "";
let privateFeed = false;

function renderUpdateToken() {
  const has = settings?.hasUpdateToken;
  $("update-token-box").hidden = !privateFeed;
  $("update-token-status").textContent = has
    ? "A GitHub token is saved (encrypted on this computer)."
    : "Updates come from a private GitHub repo. Paste a fine-grained token with read-only Contents access to that repo.";
  $("update-token-clear").hidden = !has;
}

$("update-token-form").onsubmit = async (e) => {
  e.preventDefault();
  const token = $("update-token").value.trim();
  if (!token) return;
  await api.setUpdateToken(token);
  $("update-token").value = "";
};
$("update-token-clear").onclick = () => api.clearUpdateToken();

function renderUpdate(u) {
  const text = {
    idle: "Up to date",
    checking: "Checking for updates…",
    none: "You have the latest version",
    downloading: `Downloading v${u.version}… ${u.percent ?? 0}%`,
    ready: `v${u.version} is ready to install`,
    error: `Update check failed: ${u.message}`,
    disabled: u.message,
    "needs-token": "Updates need a GitHub token (below)",
  }[u.state] ?? u.state;
  $("update-status").textContent = `Version ${appVersion} · ${text}`;
  $("update-check").hidden = ["disabled", "ready", "needs-token"].includes(u.state);
  $("update-check").disabled = u.state === "checking" || u.state === "downloading";
  $("update-install").hidden = u.state !== "ready";
}

api.getAppInfo().then(({ version, update, privateFeed: isPrivate }) => {
  appVersion = version;
  privateFeed = isPrivate;
  renderUpdate(update);
  renderUpdateToken();
});
api.onUpdateStatus(renderUpdate);
$("update-check").onclick = () => api.checkForUpdates();
$("update-install").onclick = () => api.installUpdate();

// ---------- profile ----------

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ipcMessage = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function renderProfile(s) {
  $("doc-empty").hidden = s.profileDocs.length > 0;
  $("doc-list").replaceChildren(
    ...s.profileDocs.map((d) => {
      const toggle = el("input", { type: "checkbox", checked: d.enabled, title: "Use this document" });
      toggle.onchange = () => api.setProfileDocEnabled(d.id, toggle.checked);
      const remove = el("button", { className: "danger", textContent: "Remove" });
      remove.onclick = () => confirm(`Remove "${d.name}"?`) && api.removeProfileDoc(d.id);
      return el("li", { className: `doc${d.enabled ? "" : " off"}` },
        toggle,
        el("span", { className: "name", textContent: d.name }),
        el("span", { className: "meta", textContent: `${d.kind === "pdf" ? "PDF" : "Text"} · ${fmtSize(d.size)}` }),
        remove);
    }),
  );
  if (document.activeElement !== $("about-me")) $("about-me").value = s.aboutMe;
}

$("doc-file").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const failed = [];
  for (const f of files) {
    try {
      await api.addProfileDoc(f.name, new Uint8Array(await f.arrayBuffer()));
    } catch (err) {
      failed.push(`${f.name}: ${ipcMessage(err)}`);
    }
  }
  $("doc-msg").textContent = failed.length ? failed.join(" · ") : `Added ${files.length} document${files.length > 1 ? "s" : ""}.`;
};

$("about-save").onclick = async () => {
  await api.updateSettings({ aboutMe: $("about-me").value });
  $("about-msg").textContent = "Saved.";
  setTimeout(() => ($("about-msg").textContent = ""), 2000);
};

// ---------- modes ----------

let editingId = null;

function renderModes(s) {
  if (editingId && !s.modes.some((m) => m.id === editingId)) editingId = null;
  editingId ??= s.activeModeId;
  $("mode-list").replaceChildren(
    ...s.modes.map((m) => {
      const li = el("li", { className: m.id === editingId ? "selected" : "" },
        el("div", { className: "title" },
          el("span", { textContent: m.name }),
          m.id === s.activeModeId ? el("span", { className: "badge", textContent: "active" }) : ""),
        el("div", { className: "preview", textContent: m.prompt || "No extra instructions" }));
      li.dataset.id = m.id;
      li.onclick = () => {
        editingId = m.id;
        renderModes(settings);
      };
      return li;
    }),
  );
  const mode = s.modes.find((m) => m.id === editingId);
  if (document.activeElement?.closest?.("#mode-form") && $("mode-form").dataset.id === editingId) return;
  $("mode-form").dataset.id = editingId ?? "";
  $("mode-name").value = mode?.name ?? "";
  $("mode-prompt").value = mode?.prompt ?? "";
  $("mode-use").disabled = !mode || mode.id === s.activeModeId;
  $("mode-delete").disabled = !mode || s.modes.length <= 1;
}

function flash(msg) {
  $("mode-msg").textContent = msg;
  setTimeout(() => ($("mode-msg").textContent = ""), 2500);
}

$("mode-new").onclick = () => {
  editingId = null;
  $("mode-form").dataset.id = "";
  $("mode-name").value = "";
  $("mode-prompt").value = "";
  for (const li of document.querySelectorAll("#mode-list li")) li.classList.remove("selected");
  $("mode-use").disabled = true;
  $("mode-delete").disabled = true;
  $("mode-name").focus();
};

$("mode-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    editingId = await api.saveMode({
      id: $("mode-form").dataset.id || undefined,
      name: $("mode-name").value,
      prompt: $("mode-prompt").value,
    });
    document.activeElement?.blur();
    renderModes(settings);
    flash("Saved.");
  } catch (err) {
    flash(err.message.replace(/^.*Error: /, ""));
  }
};
$("mode-use").onclick = () => editingId && api.setMode(editingId);
$("mode-delete").onclick = async () => {
  const id = $("mode-form").dataset.id;
  if (!id || !confirm(`Delete mode "${$("mode-name").value}"?`)) return;
  await api.deleteMode(id);
  editingId = null;
};

// ---------- history ----------

const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
let selectedSession = null;

async function loadSessions() {
  const sessions = await api.listSessions();
  $("session-empty").hidden = sessions.length > 0;
  $("sessions-clear").hidden = sessions.length === 0;
  $("session-list").replaceChildren(
    ...sessions.map((s) => {
      const li = el("li", { className: s.id === selectedSession ? "selected" : "" },
        el("div", { className: "title" },
          el("span", { textContent: fmtDate(s.startedAt) }),
          el("span", { className: "badge", textContent: s.mode })),
        el("div", { className: "meta", textContent: `${s.exchanges} answers · ${s.transcriptLines} transcript lines` }),
        el("div", { className: "preview", textContent: s.preview }));
      li.dataset.id = s.id;
      li.onclick = () => showSession(s.id);
      return li;
    }),
  );
  if (selectedSession && !sessions.some((s) => s.id === selectedSession)) {
    selectedSession = null;
    $("session-detail").replaceChildren(el("p", { className: "hint", textContent: "Select a session." }));
  }
}

function sessionMarkdown(s) {
  const lines = [`# Session — ${fmtDate(s.startedAt)} (${s.mode.name})`, ""];
  if (s.transcript.length) {
    lines.push("## Transcript", "");
    for (const t of s.transcript) lines.push(`**${t.speaker === "you" ? "You" : "Them"}:** ${t.text}  `);
    lines.push("");
  }
  for (const x of s.exchanges) lines.push(`## ${x.question}`, "", x.answer, "");
  return lines.join("\n");
}

async function showSession(id) {
  selectedSession = id;
  for (const li of document.querySelectorAll("#session-list li")) li.classList.toggle("selected", li.dataset.id === id);
  const s = await api.getSession(id);

  const copy = el("button", { textContent: "Copy as Markdown" });
  copy.onclick = async () => {
    await navigator.clipboard.writeText(sessionMarkdown(s));
    copy.textContent = "Copied";
  };
  const del = el("button", { className: "danger", textContent: "Delete" });
  del.onclick = async () => {
    if (!confirm("Delete this session?")) return;
    await api.deleteSession(id);
    loadSessions();
  };

  const parts = [
    el("div", { className: "head" },
      el("strong", { textContent: `${fmtDate(s.startedAt)} · ${s.mode.name}` }),
      el("span", {}, copy, del)),
  ];
  if (s.transcript.length) {
    parts.push(el("h3", { textContent: "Transcript" }));
    for (const t of s.transcript) {
      parts.push(el("div", { className: `line ${t.speaker}` },
        el("b", { textContent: t.speaker === "you" ? "You" : "Them" }), t.text));
    }
  }
  if (s.exchanges.length) {
    parts.push(el("h3", { textContent: "Answers" }));
    for (const x of s.exchanges) {
      parts.push(el("div", { className: "q", textContent: (x.withScreenshot ? "📷 " : "") + x.question }));
      parts.push(el("div", { className: "a", innerHTML: marked.parse(x.answer) }));
    }
  }
  $("session-detail").replaceChildren(...parts);
}

$("sessions-clear").onclick = async () => {
  if (!confirm("Delete all saved sessions?")) return;
  await api.clearSessions();
  loadSessions();
};
api.onSessionsChanged(() => !$("tab-history").hidden && loadSessions());

// ---------- init ----------

function render(s) {
  settings = s;
  renderGeneral(s);
  renderProfile(s);
  renderModes(s);
  renderUpdateToken();
}

api.getSettings().then(render);
api.onSettingsChanged(render);
showTab(location.hash.slice(1));
