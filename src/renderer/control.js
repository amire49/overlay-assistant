const $ = (id) => document.getElementById(id);

$("ask").onclick = () => window.assistant.ask("", true);
$("type").onclick = () => window.assistant.focusChat();
$("chat").onclick = () => window.assistant.toggleChat();
$("quit").onclick = () => window.assistant.quit();
$("hide").onclick = () => window.assistant.hide();
$("listen").onclick = () => window.assistant.toggleListen();

$("settings").onclick = () => window.assistant.openSettings("general");

// Clicking the mode pill cycles through modes; the full list lives in Settings.
let modeState = null;
function renderMode(s) {
  modeState = s;
  const mode = s.modes.find((m) => m.id === s.activeModeId);
  $("mode").textContent = mode?.name ?? "Mode";
}
$("mode").onclick = () => {
  if (!modeState) return;
  const i = modeState.modes.findIndex((m) => m.id === modeState.activeModeId);
  window.assistant.setMode(modeState.modes[(i + 1) % modeState.modes.length].id);
};
$("mode").oncontextmenu = () => window.assistant.openSettings("modes");
window.assistant.getSettings().then(renderMode);
window.assistant.onSettingsChanged(renderMode);

window.assistant.onListenStatus(({ listening }) => {
  $("listen").textContent = listening ? "■ Stop" : "🎙 Listen";
  $("listen").classList.toggle("live", listening);
});

window.assistant.onChatVisibility((visible) => {
  $("chat").textContent = visible ? "Collapse" : "Show";
});
