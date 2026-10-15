// Installer + auto-update test against real builds:
//   dist/         v0.1.0 built with OVERLAY_UPDATE_URL=http://127.0.0.1:8765/
//   dist-update/  v0.1.1 built with the same URL (OVERLAY_VERSION=0.1.1 OVERLAY_OUT=dist-update)
// Steps: silent-install 0.1.0 into a temp dir -> launch it and check overlay, Claude call,
// and local Whisper in the packaged layout -> serve dist-update and let the app find,
// download and install 0.1.1 -> confirm the installed exe is 0.1.1 -> uninstall.
// Usage: node tests/e2e-installer.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const setup010 = path.join(root, "dist", "OverlayAssistant-Setup-0.1.0.exe");
const updateDir = path.join(root, "dist-update");
const installDir = path.join(os.tmpdir(), `overlay-install-${process.pid}`);
const exe = path.join(installDir, "Overlay Assistant.exe");
const wav = path.join(__dirname, "fixtures", "question.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileVersion(file) {
  if (!fs.existsSync(file)) return ""; // mid-update the exe is briefly absent
  const v = execFileSync("powershell", ["-NoProfile", "-Command",
    `(Get-Item '${file}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  return v.replace(/\.0$/, ""); // Windows reports 4-part versions (0.1.0.0)
}

function runSilent(file, args) {
  return new Promise((resolve, reject) => {
    // NSIS needs /D unquoted and last, so pass the raw command line through cmd.
    const p = spawn(`"${file}" ${args.join(" ")}`, { shell: true, stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`))));
  });
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function serve(dir, port) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function registeredVersion() {
  return execFileSync("powershell", ["-NoProfile", "-Command",
    "(Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | " +
    `Where-Object { $_.UninstallString -like '*${installDir}\\*' }).DisplayVersion`]).toString().trim();
}

function installedAppRunning() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `@(Get-Process | Where-Object { $_.Path -like '${installDir}\\*' }).Count`]).toString().trim();
  return Number(out) > 0;
}

// The updater relaunches the app on its own schedule, so keep killing until it stays down.
async function killInstalledApp() {
  for (let quiet = 0; quiet < 6; ) {
    if (installedAppRunning()) {
      quiet = 0;
      execFileSync("powershell", ["-NoProfile", "-Command",
        `Get-Process | Where-Object { $_.Path -like '${installDir}\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue`]);
    } else {
      quiet++;
    }
    await sleep(500);
  }
}

(async () => {
  assert.ok(fs.existsSync(setup010), "build dist/ first");
  assert.ok(fs.existsSync(path.join(updateDir, "latest.yml")), "build dist-update/ first");
  const mock = await startMockAnthropic("Packaged app answer.");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  let server;

  try {
    // ---- install ----
    let t = Date.now();
    await runSilent(setup010, ["/S", `/D=${installDir}`]);
    assert.ok(fs.existsSync(exe), "installed exe exists");
    assert.equal(fileVersion(exe), "0.1.0");
    assert.ok(fs.existsSync(path.join(installDir, "resources", "app-update.yml")), "update feed baked in");
    console.log(`ok: silent install of 0.1.0 into ${installDir} (${Math.round((Date.now() - t) / 1000)}s)`);

    // ---- launch packaged app ----
    const app = await electron.launch({
      executablePath: exe,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        OVERLAY_USER_DATA: userData,
        OVERLAY_MODEL_CACHE: path.join(os.tmpdir(), "overlay-models"),
        OVERLAY_TEST: "1",
      },
    });
    const errors = [];
    app.on("window", (w) => w.on("pageerror", (e) => errors.push(e.message)));
    const find = async (file) => {
      await waitFor(() => app.windows().some((w) => w.url().endsWith(file)), 15000, file);
      return app.windows().find((w) => w.url().endsWith(file));
    };
    const bar = await find("control.html");
    const chat = await find("chat.html");
    const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }));
    assert.deepEqual(info, { version: "0.1.0", packaged: true });
    console.log("ok: packaged app launches (v0.1.0, isPackaged)");

    await bar.click("#ask");
    await chat.waitForFunction(() => document.querySelector(".a")?.textContent.includes("Packaged app answer"), null, { timeout: 20000 });
    console.log("ok: screenshot + Claude call works in packaged app");

    await bar.click("#listen");
    await chat.waitForFunction(() => [...document.querySelectorAll(".transcript .you")].some((l) => /thread/i.test(l.textContent)), null, { timeout: 180000 });
    console.log("ok: local Whisper works in packaged app");
    await bar.click("#listen");

    // ---- auto-update ----
    server = await serve(updateDir, 8765);
    await app.evaluate(() => global.__overlayTest.updater.check());
    await waitFor(
      () => app.evaluate(() => global.__overlayTest.updater.getStatus()).then((s) => {
        if (s.state === "error") throw new Error(`updater error: ${s.message}`);
        return s.state === "ready";
      }),
      300000,
      "update download",
    );
    const status = await app.evaluate(() => global.__overlayTest.updater.getStatus());
    assert.equal(status.version, "0.1.1");
    const trayItem = await app.evaluate(() => global.__overlayTest.tray.buildMenu().items[0].label);
    assert.equal(trayItem, "Restart to update (v0.1.1)");
    console.log("ok: updater found and downloaded 0.1.1; tray offers restart");

    assert.deepEqual(errors, [], "no renderer errors");

    // quitAndInstall: app exits, installer runs silently, relaunches the new version
    t = Date.now();
    app.evaluate(() => global.__overlayTest.updater.install()).catch(() => {});
    // The new exe lands before the update installer finishes; it writes the uninstaller
    // and registry entry last and then relaunches the app.
    const uninstaller = path.join(installDir, "Uninstall Overlay Assistant.exe");
    await waitFor(
      () => fileVersion(exe) === "0.1.1" && fs.existsSync(uninstaller) && registeredVersion() === "0.1.1",
      240000,
      "update installer to finish",
    );
    console.log(`ok: update installed in place -> ${fileVersion(exe)} (${Math.round((Date.now() - t) / 1000)}s)`);
    await waitFor(installedAppRunning, 60000, "updated app relaunch");
    console.log("ok: updated app relaunched itself");

    console.log("\nINSTALLER + UPDATE PASSED");
  } finally {
    server?.close();
    mock.close();
    // ---- uninstall ----
    console.log("cleanup: stopping installed app");
    await killInstalledApp();
    const uninstaller = path.join(installDir, "Uninstall Overlay Assistant.exe");
    // if a step failed mid-update, give the update installer a chance to finish
    await waitFor(() => fs.existsSync(uninstaller), 120000, "uninstaller").catch(() => {});
    await killInstalledApp();
    if (fs.existsSync(uninstaller)) {
      console.log("cleanup: running uninstaller");
      await runSilent(uninstaller, ["/S"]).catch((e) => console.error("uninstall:", e.message));
      await waitFor(() => !fs.existsSync(exe), 60000, "uninstall").then(
        () => console.log("ok: uninstalled"),
        (e) => console.error(e.message),
      );
    } else {
      console.log(`cleanup: no uninstaller in ${installDir}`);
    }
    // the uninstaller keeps the folder locked for a few seconds after it exits
    await waitFor(() => {
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }, 30000, "install folder removal").catch((e) => console.error(`cleanup: ${e.message}`));
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
