// Keeps the overlay out of GNOME screenshots (Print key, screenshot portal, gnome-screenshot).
//
// Linux can't exclude a window from a capture, but GNOME Shell paints every screenshot itself, so the
// bundled extension (gnome-extension/) makes the overlay's windows transparent for the moment the shell
// paints one. This installs that extension for the current user, lists the running shell's version in
// its metadata, and enables it while capture protection is on. GNOME only discovers extensions at
// login, so a fresh install is reported as "needs-relogin" until then.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const UUID = "screenshot-hide@overlay-assistant";
const SHELL = { destination: "org.gnome.Shell", path: "/org/gnome/Shell" };
const EXTENSIONS = "org.gnome.Shell.Extensions";
const SETTINGS_SCHEMA = "org.gnome.shell";
// GNOME Shell's ExtensionState
const STATE = { ENABLED: 1, DISABLED: 2, ERROR: 3, OUT_OF_DATE: 4, INITIALIZED: 6 };

const run = promisify(execFile);

function userExtensionDir() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "gnome-shell", "extensions", UUID);
}

/**
 * Copies the extension from sourceDir to targetDir, adding the running shell's major version to the
 * versions it declares. Only files that differ are written.
 * @returns {{ changed: boolean, version: number }}
 */
function installFiles(sourceDir, targetDir, shellMajor) {
  const metadata = JSON.parse(fs.readFileSync(path.join(sourceDir, "metadata.json"), "utf8"));
  if (shellMajor && !metadata["shell-version"].includes(shellMajor)) metadata["shell-version"].push(shellMajor);
  const files = {
    "extension.js": fs.readFileSync(path.join(sourceDir, "extension.js")),
    "metadata.json": Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
  };
  fs.mkdirSync(targetDir, { recursive: true });
  let changed = false;
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(targetDir, name);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(content)) continue;
    fs.writeFileSync(file, content);
    changed = true;
  }
  return { changed, version: metadata.version };
}

/** Parses a GVariant string array as `gsettings get` prints it: ['a', 'b'] or @as []. */
const parseStrv = (text) => [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
const formatStrv = (items) => (items.length ? `[${items.map((s) => `'${s}'`).join(", ")}]` : "@as []");

/** Puts the extension in GNOME's enabled list so the shell enables it at the next login. */
async function enableInSettings(uuid = UUID) {
  const { stdout: enabled } = await run("gsettings", ["get", SETTINGS_SCHEMA, "enabled-extensions"]);
  const list = parseStrv(enabled);
  if (!list.includes(uuid)) await run("gsettings", ["set", SETTINGS_SCHEMA, "enabled-extensions", formatStrv([...list, uuid])]);
  const { stdout: disabled } = await run("gsettings", ["get", SETTINGS_SCHEMA, "disabled-extensions"]);
  const blocked = parseStrv(disabled);
  if (blocked.includes(uuid)) await run("gsettings", ["set", SETTINGS_SCHEMA, "disabled-extensions", formatStrv(blocked.filter((u) => u !== uuid))]);
}

/**
 * status: "active" (extension enabled in the running shell), "off" (capture protection is off),
 * "needs-relogin" (installed, shell hasn't loaded it yet), "blocked" (see detail), "unavailable" (not GNOME).
 */
class ScreenshotHide {
  constructor({ sourceDir, targetDir = userExtensionDir(), onStatus = () => {}, log = console }) {
    this.sourceDir = sourceDir;
    this.targetDir = targetDir;
    this.onStatus = onStatus;
    this.log = log;
    this.status = "unavailable";
    this.detail = "";
    this.wanted = null;
    this.bus = null;
    this.ext = null;
  }

  set(status, detail = "") {
    if (status === this.status && detail === this.detail) return;
    this.status = status;
    this.detail = detail;
    this.onStatus();
  }

  /** Connects to the shell, installs the extension and applies `wanted`. Resolves once the status is known. */
  async start(wanted) {
    this.wanted = wanted;
    try {
      const dbus = require("dbus-next");
      this.bus = dbus.sessionBus();
      this.bus.on("error", () => {});
      const shell = await this.bus.getProxyObject(SHELL.destination, SHELL.path);
      this.ext = shell.getInterface(EXTENSIONS);
      const props = shell.getInterface("org.freedesktop.DBus.Properties");
      const shellVersion = (await props.Get(EXTENSIONS, "ShellVersion")).value;
      this.userExtensionsEnabled = (await props.Get(EXTENSIONS, "UserExtensionsEnabled")).value;
      const { changed } = installFiles(this.sourceDir, this.targetDir, String(shellVersion).split(".")[0]);
      if (changed) this.log.log(`GNOME extension ${UUID} installed in ${this.targetDir}`);
      this.ext.on("ExtensionStateChanged", (uuid) => uuid === UUID && this.refresh().catch(() => {}));
      props.on("PropertiesChanged", (_iface, changedProps) => {
        if ("UserExtensionsEnabled" in changedProps) {
          this.userExtensionsEnabled = changedProps.UserExtensionsEnabled.value;
          this.refresh().catch(() => {});
        }
      });
    } catch (err) {
      this.log.warn(`GNOME screenshot hiding unavailable: ${err.message}`);
      this.dispose();
      this.set("unavailable", err.message);
      return;
    }
    await this.refresh();
  }

  /** Turns the extension on or off with the capture-protection setting. */
  async apply(wanted) {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    if (this.ext) await this.refresh();
  }

  async info() {
    const dict = await this.ext.GetExtensionInfo(UUID);
    if (!("state" in dict)) return null;
    return { state: dict.state.value, error: dict.error?.value ?? "", version: dict.version?.value };
  }

  async refresh() {
    if (!this.ext) return;
    try {
      let info = await this.info();
      if (!info) {
        if (this.wanted) await enableInSettings().catch((err) => this.log.warn(`gsettings: ${err.message}`));
        this.set("needs-relogin");
        return;
      }
      if (!this.wanted) {
        if (info.state === STATE.ENABLED) await this.ext.DisableExtension(UUID);
        this.set("off");
        return;
      }
      if (info.state !== STATE.ENABLED && [STATE.DISABLED, STATE.INITIALIZED].includes(info.state)) {
        await this.ext.EnableExtension(UUID);
        info = await this.info();
      }
      if (info.state === STATE.ENABLED) this.set("active");
      else if (info.state === STATE.OUT_OF_DATE) this.set("needs-relogin");
      else if (info.state === STATE.ERROR) this.set("blocked", `the extension failed to load: ${info.error}`);
      else if (!this.userExtensionsEnabled) this.set("blocked", "extensions are turned off in GNOME (Extensions app)");
      else this.set("blocked", `the extension could not be enabled (state ${info.state})`);
    } catch (err) {
      this.set("blocked", err.message);
    }
  }

  dispose() {
    this.bus?.disconnect();
    this.bus = null;
    this.ext = null;
  }
}

module.exports = { ScreenshotHide, installFiles, userExtensionDir, enableInSettings, parseStrv, formatStrv, UUID };
