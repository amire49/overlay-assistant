// Debian package + auto-update test against real builds (Linux):
//   dist/         built with OVERLAY_UPDATE_URL=http://127.0.0.1:8765/
//   dist-update/  a newer version with the same URL (OVERLAY_VERSION=<newer> OVERLAY_OUT=dist-update)
// Steps: unpack the .deb into a temp dir (dpkg-deb -x, no root) -> check its metadata and layout ->
// launch the packaged app and check overlay, Claude call, local Whisper and the --ask command ->
// serve dist-update and let the updater find and download the newer .deb. Installing it runs
// `pkexec dpkg -i`, which needs root, so that last step is left to a real install.
// Usage: node tests/e2e-deb.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const updateDir = path.join(root, "dist-update");
const wav = path.join(__dirname, "fixtures", "question.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const debIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".deb")).map((f) => path.join(dir, f));
const field = (deb, name) => execFileSync("dpkg-deb", ["-f", deb, name], { encoding: "utf8" }).trim();
const newer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0;

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

(async () => {
  const [deb] = debIn(path.join(root, "dist"));
  assert.ok(deb, "build dist/ first");
  assert.ok(fs.existsSync(path.join(updateDir, "latest-linux.yml")), "build dist-update/ first");
  const version = field(deb, "Version");
  const updateVersion = field(debIn(updateDir)[0], "Version");
  assert.ok(newer(updateVersion, version), `dist-update (${updateVersion}) must be newer than dist (${version})`);

  // ---- package metadata and layout ----
  assert.equal(field(deb, "Package"), "overlay-assistant");
  assert.match(field(deb, "Depends"), /libsecret-1-0/, "keyring library for safeStorage");
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-deb-"));
  execFileSync("dpkg-deb", ["-x", deb, unpacked]);
  const opt = path.join(unpacked, "opt", "Overlay Assistant");
  const exe = path.join(opt, "overlay-assistant");
  const resources = path.join(opt, "resources");
  const desktop = fs.readFileSync(path.join(unpacked, "usr/share/applications/overlay-assistant.desktop"), "utf8");
  assert.match(desktop, /^Exec="\/opt\/Overlay Assistant\/overlay-assistant"/m);
  assert.equal(fs.readFileSync(path.join(resources, "package-type"), "utf8").trim(), "deb", "updater installs with dpkg");
  assert.match(fs.readFileSync(path.join(resources, "app-update.yml"), "utf8"), /url: http:\/\/127\.0\.0\.1:8765\//);
  assert.ok(fs.existsSync(path.join(resources, "models/Xenova/whisper-base.en/onnx/encoder_model_quantized.onnx")), "speech model bundled");
  const ort = fs.readdirSync(path.join(resources, "app/node_modules/onnxruntime-node/bin/napi-v3"));
  assert.deepEqual(ort, ["linux"], "only the Linux ONNX runtime");
  assert.ok(!fs.readdirSync(path.join(resources, "app/node_modules/onnxruntime-node/bin/napi-v3/linux/x64")).some((f) => /cuda|tensorrt/.test(f)), "no GPU providers");
  execFileSync("dpkg-deb", ["-e", deb, path.join(unpacked, "DEBIAN")]);
  assert.match(fs.readFileSync(path.join(unpacked, "DEBIAN/postinst"), "utf8"), /\/usr\/bin\/overlay-assistant/, "postinst links the command");
  console.log(`ok: ${path.basename(deb)} metadata and layout (unpacked into ${unpacked})`);

  const mock = await startMockAnthropic("Packaged app answer.");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    OVERLAY_USER_DATA: userData,
    OVERLAY_TEST: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let server;
  let app;

  try {
    // ---- launch packaged app ----
    app = await electron.launch({
      executablePath: exe,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
      env,
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
    assert.deepEqual(info, { version, packaged: true });
    console.log(`ok: packaged app launches (v${version}, isPackaged)`);

    await bar.click("#ask");
    await chat.waitForFunction(() => document.querySelector(".a")?.textContent.includes("Packaged app answer"), null, { timeout: 20000 });
    console.log("ok: screenshot + Claude call works in packaged app");

    // The fake capture device stands in for both the mic and system audio on Linux; either line will do.
    await bar.click("#listen");
    await chat.waitForFunction(() => [...document.querySelectorAll(".transcript .line")].some((l) => /thread/i.test(l.textContent)), null, { timeout: 180000 });
    console.log("ok: local Whisper works in packaged app");
    await bar.click("#listen");

    // `overlay-assistant --ask` from a desktop shortcut reaches the running app as a second instance.
    const before = mock.requests.length;
    const second = spawn(exe, ["--ask"], { env, stdio: "ignore" });
    await new Promise((r) => second.on("exit", r));
    await waitFor(() => mock.requests.length > before, 20000, "--ask request");
    assert.ok(mock.requests.at(-1).body.messages.at(-1).content.some((c) => c.type === "image"), "--ask attaches a screenshot");
    console.log("ok: --ask from a second launch asks with a screenshot");

    // ---- auto-update: check and download (installing needs root) ----
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
    assert.equal(status.version, updateVersion);
    const trayItem = await app.evaluate(() => global.__overlayTest.tray.buildMenu().items[0].label);
    assert.equal(trayItem, `Restart to update (v${updateVersion})`);
    console.log(`ok: updater found and downloaded ${updateVersion}; tray offers restart`);

    assert.deepEqual(errors, [], "no renderer errors");
    console.log("\nDEB PACKAGE + UPDATE PASSED");
  } finally {
    await app?.close().catch(() => {});
    server?.close();
    mock.close();
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
