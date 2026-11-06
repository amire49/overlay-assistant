// End-to-end check of the Linux auto-hide while the screen is captured: the overlay hides when a capture
// starts and comes back when it stops. The logic runs against a simulated capture everywhere; on a GNOME
// desktop it is also exercised with a real Mutter screen cast seen through PipeWire.
// Usage: node tests/e2e-capture-hide.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const MUTTER = "org.gnome.Mutter.ScreenCast";

async function windowByFile(app, file) {
  for (let i = 0; i < 80; i++) {
    const page = app.windows().find((w) => w.url().includes(file));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`window ${file} never opened`);
}

const visibility = (app) =>
  app.evaluate(({ BrowserWindow }) =>
    Object.fromEntries(BrowserWindow.getAllWindows().map((w) => [w.webContents.getURL().split("/").pop(), w.isVisible()])));

async function waitForBar(app, visible, what) {
  for (let i = 0; i < 100; i++) {
    if ((await visibility(app))["control.html"] === visible) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out: ${what}`);
}

const showLabel = (app) =>
  app.evaluate(() => global.__overlayTest.tray.buildMenu().items.find((i) => /overlay/.test(i.label)).label);

function haveTool(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A real screen cast of the first monitor through Mutter's own D-Bus API (what the portal uses too). */
async function mutterScreenCast() {
  const dbus = require("dbus-next");
  const bus = dbus.sessionBus();
  const display = await bus.getProxyObject("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig");
  const [, monitors] = await display.getInterface("org.gnome.Mutter.DisplayConfig").GetCurrentState();
  const connector = monitors[0][0][0];
  const root = await bus.getProxyObject(MUTTER, "/org/gnome/Mutter/ScreenCast");
  const sessionPath = await root.getInterface(MUTTER).CreateSession({});
  const session = (await bus.getProxyObject(MUTTER, sessionPath)).getInterface(`${MUTTER}.Session`);
  await session.RecordMonitor(connector, {});
  await session.Start();
  return {
    stop: async () => {
      await session.Stop().catch(() => {});
      bus.disconnect();
    },
  };
}

(async () => {
  if (process.platform !== "linux") return console.log("skip: auto-hide while captured is Linux-only");
  const mock = await startMockAnthropic();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, OVERLAY_USER_DATA: userData, OVERLAY_TEST: "1" };
  const app = await electron.launch({ args: [root], env });
  const errors = [];
  app.on("window", (w) => w.on("pageerror", (e) => errors.push(e.message)));
  try {
    const bar = await windowByFile(app, "control.html");
    await bar.waitForLoadState();
    await waitForBar(app, true, "bar shown at start");

    // Simulated capture: bar hides, tray says why, bar returns when the capture ends
    await app.evaluate(() => global.__overlayTest.setCaptureActive(true));
    await waitForBar(app, false, "bar hidden while captured");
    assert.equal(await showLabel(app), "Show overlay (hidden while the screen is shared)");
    await app.evaluate(() => global.__overlayTest.setCaptureActive(false));
    await waitForBar(app, true, "bar back after the capture");
    assert.equal(await showLabel(app), "Hide overlay");
    console.log("ok: overlay hides during a capture and comes back after");

    // Bringing it back on purpose during a capture sticks
    await app.evaluate(() => global.__overlayTest.setCaptureActive(true));
    await waitForBar(app, false, "bar hidden again");
    await app.evaluate(() => global.__overlayTest.tray.buildMenu().items.find((i) => /^Show overlay/.test(i.label)).click());
    await waitForBar(app, true, "bar shown on request during the capture");
    await app.evaluate(() => global.__overlayTest.setCaptureActive(false));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await visibility(app))["control.html"], true);
    assert.equal(await showLabel(app), "Hide overlay");
    console.log("ok: showing the overlay during a capture is respected");

    // With the setting off nothing hides
    await app.evaluate(() => global.__overlayTest.store.update({ contentProtection: false }));
    await app.evaluate(() => global.__overlayTest.setCaptureActive(true));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await visibility(app))["control.html"], true, "setting off: stays visible");
    await app.evaluate(() => global.__overlayTest.setCaptureActive(false));
    await app.evaluate(() => global.__overlayTest.store.update({ contentProtection: true }));
    console.log("ok: setting off leaves the overlay alone");

    // The real thing: a Mutter screen cast shows up through pw-dump
    if (haveTool("pw-dump", ["--version"]) && haveTool("busctl", ["--user", "introspect", MUTTER, "/org/gnome/Mutter/ScreenCast"])) {
      const cast = await mutterScreenCast();
      try {
        await waitForBar(app, false, "bar hidden during a real screen cast");
      } finally {
        await cast.stop();
      }
      await waitForBar(app, true, "bar back after the real screen cast");
      console.log("ok: a real GNOME screen cast hides the overlay");
    } else {
      console.log("skip: no GNOME screen cast available here, real capture not checked");
    }

    assert.deepEqual(errors, [], "no renderer errors");
    console.log("ALL OK");
  } finally {
    await app.close();
    mock.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
