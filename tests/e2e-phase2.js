// End-to-end check of Phase 2 (listening). The mic is replaced with
// tests/fixtures/question.wav via Chromium's fake-capture flags, so this exercises
// capture -> VAD -> Whisper -> transcript -> Claude request against a mock API.
// Usage: node tests/e2e-phase2.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tests", "output");
const wav = path.join(__dirname, "fixtures", "question.wav");

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
  const mock = await startMockAnthropic("Say: a **process** has its own memory; **threads** share it.");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    OVERLAY_USER_DATA: userData,
    OVERLAY_MODEL_CACHE: path.join(os.tmpdir(), "overlay-models"),
  };

  const app = await electron.launch({
    args: [
      root,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
    env,
  });
  const errors = [];
  app.process().stderr.on("data", (d) => /error/i.test(d) && !/gpu|dxva|devtools/i.test(d) && errors.push(String(d).trim()));
  try {
    const bar = await windowByFile(app, "control.html");
    const chat = await windowByFile(app, "chat.html");
    await windowByFile(app, "audio.html");
    for (const w of [bar, chat]) w.on("pageerror", (e) => errors.push(e.message));

    const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("CommandOrControl+Shift+L"));
    assert.ok(registered, "listen hotkey registered");

    await bar.click("#listen");
    await bar.waitForFunction(() => document.querySelector("#listen").textContent.includes("Stop"));
    console.log("ok: listen toggled on");

    // model load + first segment can take a while on CPU
    await chat.waitForFunction(() => /Listening|Microphone|System audio/.test(document.querySelector("#status").textContent), null, { timeout: 300000 });
    const status = await chat.textContent("#status");
    console.log(`status: ${status}`);
    assert.match(status, /you/, "mic pipeline running");

    await chat.waitForFunction(
      () => [...document.querySelectorAll(".transcript .you")].some((l) => /thread/i.test(l.textContent)),
      null,
      { timeout: 120000 },
    );
    const lines = await chat.$$eval(".transcript .line", (ls) => ls.map((l) => l.textContent));
    console.log("transcript:", lines);
    console.log("ok: mic speech transcribed by local Whisper");

    // Ask: the transcript must be sent to Claude
    await bar.click("#ask");
    await chat.waitForFunction(() => document.querySelector(".a")?.textContent.includes("threads share it"), null, { timeout: 20000 });
    const req = mock.requests.at(-1);
    const texts = req.body.messages[0].content.filter((c) => c.type === "text").map((c) => c.text);
    const live = texts.find((t) => t.startsWith("<live_transcript>"));
    assert.ok(live && /You: .*process.*thread/i.test(live), "transcript included in request");
    assert.ok(texts.includes("What should I say next?"), "default question switches to reply mode");
    console.log("ok: ask includes live transcript");

    await chat.screenshot({ path: path.join(outDir, "chat-listening.png") });
    await bar.screenshot({ path: path.join(outDir, "bar-listening.png") });

    await bar.click("#listen");
    await chat.waitForFunction(() => document.querySelector("#status").textContent === "Not listening", null, { timeout: 10000 });
    console.log("ok: listen toggled off");

    assert.deepEqual(errors, [], "no errors");
    console.log("\nPHASE 2 PASSED");
  } finally {
    await app.close();
    mock.close();
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
