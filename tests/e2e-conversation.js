// End-to-end checks that conversations stay valid for Claude's thinking, which the API binds to the exact
// system prompt and history it was written under. The mock API (tests/mock-anthropic.js) rejects a request
// whose history changed under an earlier answer, as the real API does, unless the request asks it to drop
// that thinking - so every check below also asserts nothing had to be dropped. Ends with the command-line
// actions (`--toggle` etc.) that desktop shortcuts use.
// Usage: node tests/e2e-conversation.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function windowByFile(app, file) {
  for (let i = 0; i < 80; i++) {
    const page = app.windows().find((w) => w.url().endsWith(file));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`window ${file} never opened`);
}

const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? `[${c.type}]`).join(" "));
const userTexts = (req) => req.body.messages.filter((m) => m.role === "user").map(text);
const thinkingBlocks = (req) => req.body.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "thinking") : []));

(async () => {
  const mock = await startMockAnthropic();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "sk-ant-test-key", OVERLAY_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const fakeMedia = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

  const app = await electron.launch({ args: [root, ...fakeMedia], env });
  const errors = [];
  app.on("window", (w) => w.on("pageerror", (e) => errors.push(e.message)));
  try {
    const bar = await windowByFile(app, "control.html");
    const chat = await windowByFile(app, "chat.html");
    await chat.waitForLoadState();
    await chat.uncheck("#shot");
    const call = (method, ...args) => chat.evaluate(([m, a]) => window.assistant[m](...a), [method, args]);

    // Asks in the chat window; resolves with the request that question sent and how it was answered.
    const ask = async (q) => {
      const n = await chat.$$eval(".a", (a) => a.length);
      const sent = mock.requests.length;
      await chat.fill("#input", q);
      await chat.press("#input", "Enter");
      await chat.waitForFunction((n) => {
        const a = document.querySelectorAll(".a")[n];
        return a && (a.classList.contains("err") || a.textContent.includes("Mock answer"));
      }, n, { timeout: 20000 });
      const a = (await chat.$$(".a"))[n];
      return { req: mock.requests[sent], answer: await a.textContent(), failed: await a.evaluate((el) => el.classList.contains("err")) };
    };
    const ok = (r, what) => {
      assert.ok(!r.failed, `${what}: answered (got "${r.answer}")`);
      assert.deepEqual(r.req.dropped, [], `${what}: no thinking dropped`);
    };

    // ---- a run of turns: system prompt fixed, every earlier answer's thinking still valid ----
    let r = await ask("q1");
    ok(r, "q1");
    const system = r.req.body.system;
    for (const q of ["q2", "q3", "q4"]) {
      r = await ask(q);
      ok(r, q);
      assert.equal(r.req.body.system, system);
    }
    assert.equal(thinkingBlocks(r.req).length, 3, "all three earlier answers replay their thinking");
    console.log("ok: four turns; system prompt fixed; earlier thinking replayed and valid");

    // ---- mode switched and back before asking: nothing to announce ----
    await call("setMode", "meeting");
    await call("setMode", "general");
    r = await ask("q5");
    ok(r, "q5");
    assert.doesNotMatch(userTexts(r.req).at(-1), /mode_change/);
    console.log("ok: mode switched and back before asking: no announcement");

    // ---- mode switch: announced once in the question, system prompt untouched ----
    await call("setMode", "meeting");
    r = await ask("q6");
    ok(r, "q6");
    assert.equal(r.req.body.system, system);
    assert.match(userTexts(r.req).at(-1), /^<mode_change>The user switched to the Meeting mode\. From now on, follow its instructions[\s\S]*Track decisions/);
    r = await ask("q7");
    ok(r, "q7");
    assert.doesNotMatch(userTexts(r.req).at(-1), /mode_change/);
    console.log("ok: mode switch announced once; system prompt untouched");

    // ---- switching to a mode without instructions ----
    await call("setMode", "general");
    r = await ask("q8");
    ok(r, "q8");
    assert.match(userTexts(r.req).at(-1), /switched to the General mode\. Stop following the earlier mode's instructions\./);
    console.log("ok: switch to a mode without instructions is announced");

    // ---- editing the active mode's instructions mid-conversation ----
    await call("saveMode", { id: "general", name: "General", prompt: "Answer in one sentence." });
    r = await ask("q9");
    ok(r, "q9");
    assert.match(userTexts(r.req).at(-1), /switched to the General mode\. From now on[\s\S]*Answer in one sentence\./);
    assert.equal(r.req.body.system, system);
    console.log("ok: edited mode instructions are announced");

    // ---- a failed request: its question leaves history, a pending mode note is sent again ----
    await call("setMode", "coding");
    mock.failNext = { status: 400, message: "Simulated bad request" };
    r = await ask("q-fails");
    assert.ok(r.failed && /Simulated bad request/.test(r.answer), "error shown");
    r = await ask("q10");
    ok(r, "q10");
    assert.ok(!userTexts(r.req).some((t) => t.includes("q-fails")), "failed question not in history");
    assert.match(userTexts(r.req).at(-1), /switched to the Coding mode/);
    console.log("ok: failed question dropped from history; mode note re-sent with the next one");

    // ---- a refusal: its question leaves history ----
    mock.refuseNext = true;
    r = await ask("q-refused");
    assert.ok(r.failed && /declined/.test(r.answer), "refusal shown");
    r = await ask("q11");
    ok(r, "q11");
    assert.ok(!userTexts(r.req).some((t) => t.includes("q-refused")), "refused question not in history");
    console.log("ok: refused question dropped from history");

    // ---- profile added, then removed, mid-conversation ----
    await call("updateSettings", { aboutMe: "I build compilers." });
    r = await ask("q12");
    ok(r, "q12");
    assert.match(r.req.body.system, /user's profile/);
    assert.equal(r.req.body.messages[0].role, "user");
    assert.match(text(r.req.body.messages[0]), /I build compilers/);
    assert.equal(thinkingBlocks(r.req).length, 0, "thinking from before the profile left out");
    r = await ask("q13");
    ok(r, "q13");
    assert.equal(thinkingBlocks(r.req).length, 1, "thinking after the profile change replays");
    await call("updateSettings", { aboutMe: "" });
    r = await ask("q14");
    ok(r, "q14");
    assert.doesNotMatch(r.req.body.system, /user's profile/);
    assert.doesNotMatch(text(r.req.body.messages[0]), /I build compilers/);
    console.log("ok: profile added and removed mid-conversation without errors");

    // ---- New session while an answer is still coming ----
    mock.delay = 1500;
    await chat.fill("#input", "q-interrupted");
    await chat.press("#input", "Enter");
    await sleep(300);
    await chat.click("#reset");
    mock.delay = 0;
    r = await ask("fresh");
    ok(r, "fresh");
    assert.deepEqual(userTexts(r.req), ["fresh"], "a new conversation");
    assert.match(r.req.body.system, /\n\nMode: Coding\n/, "the new conversation's system prompt has the current mode");
    assert.doesNotMatch(r.req.body.system, /mode_change|user's profile/);
    console.log("ok: New session mid-answer starts a clean conversation");

    // ---- command-line actions from a second launch (what desktop shortcuts run) ----
    const second = (arg) => new Promise((resolve) =>
      spawn(require("electron"), [root, arg], { env, stdio: "ignore" }).on("exit", resolve));
    const barVisible = () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("control.html")).isVisible());

    await second("--toggle");
    await sleep(500);
    assert.equal(await barVisible(), false, "--toggle hides");
    await second("--toggle");
    await sleep(500);
    assert.equal(await barVisible(), true, "--toggle shows again");
    console.log("ok: --toggle hides and shows the overlay");

    let before = mock.requests.length;
    await second("--ask");
    await chat.waitForFunction(() => [...document.querySelectorAll(".a")].at(-1)?.textContent.includes("Mock answer"), null, { timeout: 20000 });
    assert.equal(mock.requests.length, before + 1);
    assert.ok(mock.requests.at(-1).body.messages.at(-1).content.some((c) => c.type === "image"), "--ask sends a screenshot");
    console.log("ok: --ask asks about the screen");

    await second("--new-session");
    await chat.waitForFunction(() => document.querySelectorAll(".a").length === 0);
    r = await ask("after --new-session");
    ok(r, "after --new-session");
    assert.deepEqual(userTexts(r.req), ["after --new-session"]);
    console.log("ok: --new-session starts a new conversation");

    await second("--listen");
    await bar.waitForFunction(() => document.querySelector("#listen").textContent.includes("Stop"), null, { timeout: 60000 });
    await second("--listen");
    await bar.waitForFunction(() => document.querySelector("#listen").textContent.includes("Listen"), null, { timeout: 10000 });
    console.log("ok: --listen starts and stops listening");

    assert.deepEqual(errors, [], "no renderer errors");
    console.log("\nCONVERSATION PASSED");
  } finally {
    await app.close();
    mock.close();
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
