// End-to-end check of Phase 1 against a mock Claude API.
// Usage: node tests/e2e-phase1.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tests", "output");

async function windowByFile(app, file) {
  for (let i = 0; i < 50; i++) {
    const page = app.windows().find((w) => w.url().endsWith(file));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`window ${file} never opened`);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const mock = await startMockAnthropic();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, OVERLAY_USER_DATA: userData };
  delete env.ANTHROPIC_API_KEY;

  const app = await electron.launch({ args: [root], env });
  const errors = [];
  app.on("window", (w) => w.on("pageerror", (e) => errors.push(e.message)));
  try {
    const bar = await windowByFile(app, "control.html");
    const chat = await windowByFile(app, "chat.html");
    for (const w of [bar, chat]) w.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await bar.waitForLoadState();
    await chat.waitForLoadState();

    // Window flags
    const flags = await app.evaluate(({ BrowserWindow, globalShortcut }) => ({
      windows: BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().endsWith("audio.html")).map((w) => ({
        onTop: w.isAlwaysOnTop(), visible: w.isVisible(), bounds: w.getBounds(),
      })),
      hotkeys: ["CommandOrControl+\\", "CommandOrControl+Enter", "CommandOrControl+R",
        "CommandOrControl+Up", "CommandOrControl+Shift+Down"].map((k) => [k, globalShortcut.isRegistered(k)]),
    }));
    console.log("windows:", JSON.stringify(flags.windows));
    console.log("hotkeys:", JSON.stringify(flags.hotkeys));
    assert.ok(flags.windows.every((w) => w.onTop), "all windows always-on-top");
    for (const [k, ok] of flags.hotkeys) assert.ok(ok, `hotkey registered: ${k}`);

    // No key yet -> asking reveals the key form
    await bar.click("#ask");
    await chat.waitForSelector("#key-form", { state: "visible", timeout: 5000 });
    console.log("ok: key form shown when no API key");

    await chat.fill("#key", "sk-ant-test-key");
    await chat.click("#key-form button");
    await chat.waitForSelector("#key-form", { state: "hidden" });
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert.ok(saved.encryptedKey && !saved.encryptedKey.includes("sk-ant"), "key stored encrypted");
    console.log("ok: key saved encrypted");

    // Screenshot + ask via the bar button
    await bar.click("#ask");
    await chat.waitForFunction(() => document.querySelector(".a")?.textContent.includes("from Claude"), null, { timeout: 15000 });
    const req = mock.requests.at(-1);
    assert.equal(req.headers["x-api-key"], "sk-ant-test-key");
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.fallbacks, "default");
    const img = req.body.messages[0].content.find((c) => c.type === "image");
    assert.ok(img && img.source.data.length > 10000, "screenshot attached");
    fs.writeFileSync(path.join(outDir, "captured-screen.png"), Buffer.from(img.source.data, "base64"));
    assert.ok(await chat.$(".a strong"), "markdown rendered");
    console.log(`ok: screenshot ask streamed answer (image ${Math.round(img.source.data.length / 1024)} KB base64)`);

    // Typed follow-up without screenshot keeps history
    await chat.uncheck("#shot");
    await chat.fill("#input", "follow up?");
    await chat.press("#input", "Enter");
    await chat.waitForFunction(() => document.querySelectorAll(".a").length === 2 &&
      document.querySelectorAll(".a")[1].textContent.includes("from Claude"), null, { timeout: 15000 });
    const req2 = mock.requests.at(-1);
    assert.equal(req2.body.messages.length, 3, "history carried over");
    assert.ok(!req2.body.messages[2].content.some((c) => c.type === "image"), "no image when unchecked");
    console.log("ok: typed follow-up uses history");

    await chat.screenshot({ path: path.join(outDir, "chat.png") });
    await bar.screenshot({ path: path.join(outDir, "bar.png") });

    // Reset clears UI
    await chat.click("#reset");
    await chat.waitForFunction(() => document.querySelectorAll(".a").length === 0);
    console.log("ok: reset clears conversation");

    // Content protection toggle persists
    await chat.uncheck("#protect");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).contentProtection, false);
    console.log("ok: content protection toggle persists");

    assert.deepEqual(errors, [], "no renderer errors");
    console.log("\nPHASE 1 PASSED");
  } finally {
    await app.close();
    mock.close();
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
