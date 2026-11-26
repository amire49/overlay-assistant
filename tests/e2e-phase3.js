// End-to-end check of Phase 3: modes, model choice, session history, settings window, tray menu.
// Usage: node tests/e2e-phase3.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tests", "output");

async function windowByFile(app, file) {
  for (let i = 0; i < 80; i++) {
    const page = app.windows().find((w) => w.url().includes(file));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`window ${file} never opened`);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const mock = await startMockAnthropic("Mock answer from Claude.");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    OVERLAY_USER_DATA: userData,
    OVERLAY_TEST: "1",
  };

  const app = await electron.launch({ args: [root], env });
  const errors = [];
  app.on("window", (w) => w.on("pageerror", (e) => errors.push(`${w.url()}: ${e.message}`)));
  try {
    const bar = await windowByFile(app, "control.html");
    const chat = await windowByFile(app, "chat.html");
    await bar.waitForLoadState();
    await chat.waitForLoadState();

    // ---- tray ----
    const trayLabels = await app.evaluate(() => {
      const items = global.__overlayTest.tray.buildMenu().items;
      return items.map((i) => (i.submenu ? `${i.label}[${i.submenu.items.map((s) => s.label).join(",")}]` : i.label));
    });
    console.log("tray:", trayLabels.filter(Boolean).join(" | "));
    assert.ok(trayLabels.includes("Settings…") && trayLabels.includes("Quit"));
    assert.ok(trayLabels.some((l) => l.startsWith("Mode[General,Meeting")), "mode submenu");
    console.log("ok: tray menu built");

    // ---- mode pill cycles mode, prompt reaches Claude ----
    await bar.waitForFunction(() => document.querySelector("#mode").textContent === "General");
    await bar.click("#mode");
    await bar.waitForFunction(() => document.querySelector("#mode").textContent === "Meeting");
    const checkedInTray = await app.evaluate(() =>
      global.__overlayTest.tray.buildMenu().items.find((i) => i.label === "Mode").submenu.items.find((s) => s.checked).label);
    assert.equal(checkedInTray, "Meeting", "tray radio follows mode");

    await bar.click("#ask");
    await chat.waitForFunction(() => document.querySelectorAll(".a").length === 1 && document.querySelector(".a").textContent.includes("Mock answer"));
    let req = mock.requests.at(-1);
    assert.match(req.body.system, /Mode: Meeting/);
    assert.equal(req.body.model, "claude-opus-5-5");
    console.log("ok: mode pill switches mode; mode prompt sent to Claude");

    // ---- settings window via tray item ----
    await app.evaluate(() => global.__overlayTest.tray.buildMenu().items.find((i) => i.label === "Settings…").click());
    const settings = await windowByFile(app, "settings.html");
    await settings.waitForLoadState();
    await settings.waitForSelector("#tab-general", { state: "visible" });
    assert.match(await settings.textContent("#key-status"), /ANTHROPIC_API_KEY/);
    await settings.screenshot({ path: path.join(outDir, "settings-general.png") });
    console.log("ok: settings opens from tray");

    // model -> Haiku: no server-side fallback params
    await settings.selectOption("#model", "claude-haiku-5-5");
    await new Promise((r) => setTimeout(r, 200));
    await chat.fill("#input", "second question");
    await chat.uncheck("#shot");
    await chat.press("#input", "Enter");
    await chat.waitForFunction(() => document.querySelectorAll(".a").length === 2 && document.querySelectorAll(".a")[1].textContent.includes("Mock answer"));
    req = mock.requests.at(-1);
    assert.equal(req.body.model, "claude-haiku-5-5");
    assert.equal(req.body.fallbacks, undefined, "no fallbacks for Haiku");
    assert.ok(!("anthropic-beta" in req.headers) || !/server-side-fallback/.test(req.headers["anthropic-beta"]));
    console.log("ok: model choice applied (Haiku, no fallback)");

    // ---- modes tab: create, use, delete ----
    await settings.click('nav button[data-tab="modes"]');
    await settings.click("#mode-new");
    await settings.fill("#mode-name", "Study");
    await settings.fill("#mode-prompt", "Explain step by step like a tutor.");
    await settings.click('#mode-form button.primary');
    await settings.waitForFunction(() => [...document.querySelectorAll("#mode-list li")].some((li) => li.textContent.includes("Study")));
    await settings.click("#mode-use");
    await bar.waitForFunction(() => document.querySelector("#mode").textContent === "Study");
    await settings.screenshot({ path: path.join(outDir, "settings-modes.png") });
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert.equal(saved.modes.find((m) => m.id === saved.activeModeId).name, "Study");
    console.log("ok: custom mode created, activated, persisted");

    // ---- history: reset saves session, shows in History ----
    await chat.click("#reset");
    await settings.click('nav button[data-tab="history"]');
    await settings.waitForSelector("#session-list li");
    const sessions = await settings.$$eval("#session-list li", (ls) => ls.map((l) => l.textContent));
    assert.equal(sessions.length, 1);
    assert.match(sessions[0], /Meeting/);
    assert.match(sessions[0], /2 answers/);
    await settings.click("#session-list li");
    await settings.waitForSelector("#session-detail .a");
    const detail = await settings.textContent("#session-detail");
    assert.match(detail, /second question/);
    assert.match(detail, /Mock answer/);
    await settings.screenshot({ path: path.join(outDir, "settings-history.png") });
    console.log("ok: session saved on reset and viewable in History");

    // delete the mode again
    await settings.click('nav button[data-tab="modes"]');
    settings.once("dialog", (d) => d.accept());
    await settings.click("#mode-list li:last-child");
    await settings.click("#mode-delete");
    await bar.waitForFunction(() => document.querySelector("#mode").textContent !== "Study");
    console.log("ok: mode deleted, active mode falls back");

    // ---- drag-to-move: chat follows the bar, position persists ----
    const moved = await app.evaluate(async ({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      const bar = wins.find((w) => w.webContents.getURL().endsWith("control.html"));
      const chat = wins.find((w) => w.webContents.getURL().endsWith("chat.html"));
      const b = bar.getBounds();
      bar.setPosition(b.x - 200, b.y + 150); // same events as an app-region drag
      bar.emit("moved");
      await new Promise((r) => setTimeout(r, 100));
      return { bar: bar.getBounds(), chat: chat.getBounds() };
    });
    assert.equal(moved.chat.y, moved.bar.y + moved.bar.height + 8, "chat sits under bar");
    assert.equal(moved.chat.x, Math.round(moved.bar.x + (moved.bar.width - moved.chat.width) / 2), "chat centered on bar");
    const pos = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).barPosition;
    assert.deepEqual(pos, { x: moved.bar.x, y: moved.bar.y }, "bar position saved");
    console.log("ok: chat follows dragged bar; position saved");

    // ---- closing settings keeps the app running ----
    await settings.close();
    await new Promise((r) => setTimeout(r, 500));
    const stillRunning = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.ok(stillRunning >= 2, "overlay survives settings close");
    console.log("ok: app keeps running after settings closes");

    await bar.screenshot({ path: path.join(outDir, "bar-phase3.png") });
    assert.deepEqual(errors, [], "no renderer errors");
    console.log("\nPHASE 3 PASSED");
  } finally {
    await app.close();
    mock.close();
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
