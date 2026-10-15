import { marked } from "../../node_modules/marked/lib/marked.esm.js";

const api = window.assistant;
const $ = (id) => document.getElementById(id);
const log = $("log");

let current = null; // { el, text }

function addQuestion(text, withScreenshot) {
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = (withScreenshot ? "📷 " : "") + (text || "What's on my screen?");
  log.append(q);

  const a = document.createElement("div");
  a.className = "a";
  a.textContent = "…";
  log.append(a);
  current = { el: a, text: "" };
  log.scrollTop = log.scrollHeight;
}

api.onQuestion(({ text, withScreenshot }) => addQuestion(text, withScreenshot));

api.onDelta((delta) => {
  if (!current) return;
  current.text += delta;
  current.el.innerHTML = marked.parse(current.text);
  log.scrollTop = log.scrollHeight;
});

api.onDone(() => {
  current = null;
});

api.onError((message) => {
  const el = current?.el ?? log.appendChild(document.createElement("div"));
  el.className = "a err";
  el.textContent = message;
  current = null;
});

api.onReset(() => {
  log.replaceChildren();
  $("transcript").replaceChildren();
  current = null;
});

api.onListenStatus(({ listening, message }) => {
  $("live").hidden = false;
  $("status").textContent = message;
  if (!listening) for (const m of document.querySelectorAll(".meter")) m.style.setProperty("--lvl", "0%");
});

api.onTranscript(({ speaker, text }) => {
  const line = document.createElement("div");
  line.className = `line ${speaker}`;
  const who = document.createElement("b");
  who.textContent = speaker === "you" ? "You" : "Them";
  line.append(who, text);
  const box = $("transcript");
  box.append(line);
  box.scrollTop = box.scrollHeight;
});

api.onAudioLevel((speaker, rms) => {
  const pct = Math.min(100, Math.round(Math.sqrt(rms) * 250));
  $(`meter-${speaker}`)?.style.setProperty("--lvl", `${pct}%`);
});

api.onScroll((dy) => log.scrollBy({ top: dy, behavior: "smooth" }));

api.onNeedApiKey(() => {
  $("key-form").hidden = false;
  $("key").focus();
});

$("key-form").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  if (!key) return;
  await api.setApiKey(key);
  $("key").value = "";
  $("key-form").hidden = true;
};

$("ask-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("input").value;
  $("input").value = "";
  api.ask(text, $("shot").checked);
};

$("reset").onclick = () => api.reset();
$("protect").onchange = (e) => api.setContentProtection(e.target.checked);

function applySettings({ contentProtection, hasApiKey }) {
  $("protect").checked = contentProtection;
  $("key-form").hidden = hasApiKey;
}
api.getSettings().then(applySettings);
api.onSettingsChanged(applySettings);
