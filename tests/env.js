// Helpers for things on the test machine that the tests don't control.
const { execFileSync } = require("node:child_process");

/** True when an installed copy of the app is running (it holds the global hotkeys). */
function installedAppRunning() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Overlay Assistant.exe", "/NH"], { encoding: "utf8" });
      return out.includes("Overlay Assistant.exe");
    }
    // the .deb installs to /opt; pgrep exits non-zero (throws) when nothing matches
    execFileSync("pgrep", ["-f", "^/opt/Overlay Assistant/overlay-assistant"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Why the app can't register global hotkeys on this machine, or null if it should. */
function hotkeyBlocker() {
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") return "Wayland session";
  if (installedAppRunning()) return "the installed app is running and holds the hotkeys";
  return null;
}

module.exports = { installedAppRunning, hotkeyBlocker };
