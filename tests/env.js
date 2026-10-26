// Helpers for things on the test machine that the tests don't control.
const { execFileSync } = require("node:child_process");

/** True when an installed copy of the app is running (it holds the global hotkeys). */
function installedAppRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Overlay Assistant.exe", "/NH"], { encoding: "utf8" });
    return out.includes("Overlay Assistant.exe");
  } catch {
    return false;
  }
}

module.exports = { installedAppRunning };
