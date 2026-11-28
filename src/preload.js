const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("assistant", {
  ask: (text, withScreenshot) => ipcRenderer.invoke("ask", { text, withScreenshot }),
  reset: () => ipcRenderer.invoke("reset"),
  toggleChat: () => ipcRenderer.invoke("toggle-chat"),
  hide: () => ipcRenderer.invoke("hide"),
  toggleListen: () => ipcRenderer.invoke("toggle-listen"),

  // audio window -> main
  sendSegment: (speaker, samples) => ipcRenderer.send("audio-segment", speaker, samples),
  sendAudioFrame: (speaker, samples) => ipcRenderer.send("audio-frame", speaker, samples),
  sendLevel: (speaker, rms) => ipcRenderer.send("audio-level", speaker, rms),
  audioStatus: (status) => ipcRenderer.send("audio-status", status),
  onAudioStart: listen("audio-start"),
  onAudioStop: listen("audio-stop"),
  focusChat: () => ipcRenderer.invoke("focus-chat"),
  quit: () => ipcRenderer.invoke("quit"),
  setApiKey: (key) => ipcRenderer.invoke("set-api-key", key),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setContentProtection: (on) => ipcRenderer.invoke("set-content-protection", on),
  openSettings: (tab) => ipcRenderer.invoke("open-settings", tab),
  updateSettings: (patch) => ipcRenderer.invoke("update-settings", patch),
  clearApiKey: () => ipcRenderer.invoke("clear-api-key"),
  setDeepgramKey: (key) => ipcRenderer.invoke("set-deepgram-key", key),
  clearDeepgramKey: () => ipcRenderer.invoke("clear-deepgram-key"),
  setUpdateToken: (token) => ipcRenderer.invoke("set-update-token", token),
  clearUpdateToken: () => ipcRenderer.invoke("clear-update-token"),

  addProfileDoc: (name, bytes) => ipcRenderer.invoke("add-profile-doc", name, bytes),
  removeProfileDoc: (id) => ipcRenderer.invoke("remove-profile-doc", id),
  setProfileDocEnabled: (id, enabled) => ipcRenderer.invoke("set-profile-doc-enabled", id, enabled),

  setMode: (id) => ipcRenderer.invoke("set-mode", id),
  saveMode: (mode) => ipcRenderer.invoke("save-mode", mode),
  deleteMode: (id) => ipcRenderer.invoke("delete-mode", id),

  listSessions: () => ipcRenderer.invoke("list-sessions"),
  getSession: (id) => ipcRenderer.invoke("get-session", id),
  deleteSession: (id) => ipcRenderer.invoke("delete-session", id),
  clearSessions: () => ipcRenderer.invoke("clear-sessions"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),

  getLicenseInfo: () => ipcRenderer.invoke("get-license-info"),
  requestLicense: (name) => ipcRenderer.invoke("request-license", name),
  checkLicense: () => ipcRenderer.invoke("check-license"),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateStatus: listen("update-status"),
  onSettingsChanged: listen("settings-changed"),
  onSettingsTab: listen("settings-tab"),
  onSessionsChanged: listen("sessions-changed"),

  onQuestion: listen("question"),
  onDelta: listen("answer-delta"),
  onDone: listen("answer-done"),
  onError: listen("answer-error"),
  onReset: listen("reset"),
  onScroll: listen("scroll"),
  onNeedApiKey: listen("need-api-key"),
  onChatVisibility: listen("chat-visibility"),
  onListenStatus: listen("listen-status"),
  onTranscript: listen("transcript"),
  onTranscriptInterim: listen("transcript-interim"),
  onAudioLevel: listen("audio-level"),
});
