// End-to-end check that GNOME screenshots leave the overlay out, in a headless nested GNOME Shell so the
// user's session is untouched: the shell gets its own session bus, in-memory settings and extension dir.
// The app runs inside it, enables the bundled extension, and shell screenshots are compared with and
// without it. Skips where gnome-shell isn't installed.
// Usage: node tests/e2e-gnome-screenshot.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { installFiles, UUID } = require("../src/gnome-extension");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tests", "output");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function have(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Private session bus; resolves with its address. */
function startBus() {
  const bus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let out = "";
    bus.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve({ proc: bus, address: out.trim().split("\n")[0] });
    });
    bus.on("exit", () => reject(new Error("dbus-daemon exited")));
  });
}

/** Headless nested shell; resolves with its X display and Xauthority once it's up. */
function startShell(env, log) {
  const started = Date.now();
  const shell = spawn("gnome-shell", ["--headless", "--wayland", "--virtual-monitor", "1920x1080"], { env, stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let display = null;
    shell.stderr.on("data", (d) => {
      log.write(d);
      const m = String(d).match(/Using public X11 display (:\d+)/);
      if (m) display = m[1];
      if (display && !resolve.done) {
        resolve.done = true;
        // Mutter writes an Xauthority for its XWayland; the newest one is this shell's.
        const auth = fs.readdirSync(env.XDG_RUNTIME_DIR)
          .filter((f) => f.startsWith(".mutter-Xwaylandauth."))
          .map((f) => path.join(env.XDG_RUNTIME_DIR, f))
          .filter((f) => fs.statSync(f).mtimeMs >= started - 1000)
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        resolve({ proc: shell, display, xauthority: auth });
      }
    });
    shell.on("exit", (code) => !resolve.done && reject(new Error(`gnome-shell exited (${code})`)));
    setTimeout(() => !resolve.done && reject(new Error("gnome-shell didn't come up")), 60_000);
  });
}

(async () => {
  if (process.platform !== "linux") return console.log("skip: GNOME only");
  for (const cmd of ["gnome-shell", "dbus-daemon"]) if (!have(cmd)) return console.log(`skip: ${cmd} not installed`);
  if (!process.env.XDG_RUNTIME_DIR) return console.log("skip: no XDG_RUNTIME_DIR");

  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-gnome-"));
  const dataHome = path.join(work, "data");
  // As if the app had installed it at an earlier run and the user logged in again
  installFiles(path.join(root, "gnome-extension"), path.join(dataHome, "gnome-shell", "extensions", UUID), null);
  const shellLog = fs.createWriteStream(path.join(outDir, "nested-shell.log"));

  const bus = await startBus();
  const procs = [bus.proc];
  let app;
  try {
    const shellEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus.address, XDG_DATA_HOME: dataHome, GSETTINGS_BACKEND: "memory" };
    delete shellEnv.DISPLAY;
    delete shellEnv.WAYLAND_DISPLAY;
    const shell = await startShell(shellEnv, shellLog);
    procs.push(shell.proc);
    console.log(`nested shell on ${shell.display}`);
    await sleep(4000);

    const appEnv = {
      ...shellEnv,
      DISPLAY: shell.display,
      XAUTHORITY: shell.xauthority,
      OVERLAY_USER_DATA: path.join(work, "userdata"),
      OVERLAY_TEST: "1",
    };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    // the nested bus has no keyring, so safeStorage waits a while before giving up
    app = await electron.launch({ args: [root, "--ozone-platform=x11"], env: appEnv, timeout: 120_000 });
    const bar = await (async () => {
      for (let i = 0; i < 600; i++) {
        const page = app.windows().find((w) => w.url().includes("control.html"));
        if (page) return page;
        await sleep(100);
      }
      throw new Error("bar never opened");
    })();
    await bar.waitForLoadState();

    // The app installs and enables the extension in the nested shell
    for (let i = 0; i < 100; i++) {
      if ((await app.evaluate(() => global.__overlayTest.screenshotHide.status)) === "active") break;
      await sleep(100);
    }
    const status = await app.evaluate(() => ({ status: global.__overlayTest.screenshotHide.status, detail: global.__overlayTest.screenshotHide.detail }));
    assert.equal(status.status, "active", `extension active: ${JSON.stringify(status)}`);
    console.log("ok: app enabled its GNOME extension");

    // Shell screenshots: callers must own one of a few names; MediaKeys is free on this private bus
    const dbus = require("dbus-next");
    process.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    const conn = dbus.sessionBus();
    assert.equal(await conn.requestName("org.gnome.SettingsDaemon.MediaKeys", 0), 1);
    await sleep(1000);
    const shooter = (await conn.getProxyObject("org.gnome.Shell", "/org/gnome/Shell/Screenshot")).getInterface("org.gnome.Shell.Screenshot");
    const shot = async (name) => {
      const file = path.join(outDir, `nested-${name}.png`);
      const [ok] = await shooter.Screenshot(false, false, file);
      assert.ok(ok, `screenshot ${name}`);
      return file;
    };
    // Compares the bar's area of two screenshots, through Electron's image code
    const barBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("control.html")).getBounds());
    const sameBarArea = (a, b) => app.evaluate(({ nativeImage }, [fileA, fileB, bounds]) => {
      const crop = (f) => nativeImage.createFromPath(f).crop(bounds).toBitmap();
      const [x, y] = [crop(fileA), crop(fileB)];
      let diff = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 8) diff++;
      return { same: diff / x.length < 0.005, diffRatio: diff / x.length };
    }, [a, b, barBounds]);

    await sleep(1500);
    const withExtension = await shot("with-extension");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
    await sleep(1500);
    const noWindows = await shot("no-windows");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("control.html")).forEach((w) => w.showInactive()));
    await sleep(1500);
    assert.ok((await sameBarArea(withExtension, noWindows)).same, "with the extension the screenshot looks as if the overlay weren't there");
    console.log("ok: GNOME screenshot leaves the overlay out");

    // Protection off: extension disabled, the overlay is in the picture again
    await app.evaluate(() => global.__overlayTest.store.update({ contentProtection: false }));
    await app.evaluate(() => global.__overlayTest.screenshotHide.apply(false));
    for (let i = 0; i < 50; i++) {
      if ((await app.evaluate(() => global.__overlayTest.screenshotHide.status)) === "off") break;
      await sleep(100);
    }
    assert.equal(await app.evaluate(() => global.__overlayTest.screenshotHide.status), "off");
    await sleep(1000);
    const without = await shot("without-extension");
    const cmp = await sameBarArea(without, noWindows);
    assert.ok(!cmp.same, `with protection off the overlay shows (diff ${cmp.diffRatio})`);
    console.log("ok: with protection off the overlay is in the screenshot");

    conn.disconnect();
    console.log("ALL OK");
  } finally {
    await app?.close().catch(() => {});
    for (const p of procs.reverse()) p.kill();
    shellLog.end();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
