// Auto-update via electron-updater. The feed comes from the build's publish config
// (resources/app-update.yml, written by scripts/build.js). For a private GitHub repo the
// app needs a read-only token, which the user supplies in Settings (never baked into the build).
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// app-update.yml is flat `key: value` lines; no YAML library needed.
function readFeedConfig() {
  const file = path.join(process.resourcesPath, "app-update.yml");
  if (!fs.existsSync(file)) return null;
  const config = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*?)\s*$/);
    if (m) config[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return config;
}

/**
 * @param {{ onStatus: (s: { state: string, version?: string, percent?: number, message?: string }) => void,
 *           getToken: () => string | null }} opts
 */
function setupUpdater({ onStatus, getToken }) {
  let status = { state: "idle" };
  const set = (s) => {
    status = s;
    onStatus(s);
  };
  const inert = { getStatus: () => status, check: async () => status, install: () => {}, refresh: () => {} };

  const feed = app.isPackaged ? readFeedConfig() : null;
  if (!feed) {
    set({ state: "disabled", message: app.isPackaged ? "No update feed in this build" : "Updates run in the installed app only" });
    return inert;
  }
  const needsToken = feed.provider === "github" && feed.private === "true";

  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-not-available", () => set({ state: "none", version: app.getVersion() }));
  autoUpdater.on("update-available", (info) => set({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => set({ ...status, state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => set({ state: "ready", version: info.version }));
  autoUpdater.on("error", (err) => set({ state: "error", message: err.message.split("\n")[0] }));

  /** Points the updater at the feed; false when a private feed has no token yet. */
  function applyFeed() {
    if (!needsToken) return true;
    const token = getToken();
    if (!token) {
      set({ state: "needs-token", message: `Add a GitHub token in Settings to receive updates from ${feed.owner}/${feed.repo}` });
      return false;
    }
    autoUpdater.setFeedURL({ provider: "github", owner: feed.owner, repo: feed.repo, private: true, token });
    return true;
  }

  let ready = applyFeed();

  const check = async () => {
    if (!ready) return status;
    if (status.state === "downloading" || status.state === "ready") return status;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // reported through the "error" event
    }
    return status;
  };
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);

  return {
    getStatus: () => status,
    check,
    install: () => autoUpdater.quitAndInstall(true, true),
    /** Call after the token changes. */
    refresh: () => {
      ready = applyFeed();
      if (ready) {
        set({ state: "idle" });
        check();
      }
    },
    privateFeed: needsToken,
  };
}

module.exports = { setupUpdater };
