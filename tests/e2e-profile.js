// End-to-end check of the Profile feature: upload CV/notes, About-me text, and what reaches Claude.
// Usage: node tests/e2e-profile.js
const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAnthropic } = require("./mock-anthropic");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tests", "output");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Smallest valid one-page PDF with a line of text, xref offsets computed so viewers accept it.
function makePdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, filled below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((body, i) => {
    const off = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return off;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function windowByFile(app, file) {
  for (let i = 0; i < 80; i++) {
    const page = app.windows().find((w) => w.url().includes(file));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`window ${file} never opened`);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-profile-files-"));
  const cvPath = path.join(fixtures, "Jane Doe CV.pdf");
  const cvBytes = makePdf("Jane Doe - Senior Backend Engineer, Acme Corp 2019-2024. Go, Postgres, Kafka.");
  fs.writeFileSync(cvPath, cvBytes);
  const notesPath = path.join(fixtures, "notes.md");
  fs.writeFileSync(notesPath, "# Notes\nLed the migration from a monolith to services; cut p99 latency by 40%.\n");
  const fakePdf = path.join(fixtures, "not-really.pdf");
  fs.writeFileSync(fakePdf, "hello, I am not a PDF");

  const mock = await startMockAnthropic("Mock answer from Claude.");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "sk-ant-test-key", OVERLAY_USER_DATA: userData, OVERLAY_TEST: "1" },
  });
  const errors = [];
  app.on("window", (w) => w.on("pageerror", (e) => errors.push(e.message)));
  try {
    const bar = await windowByFile(app, "control.html");
    const chat = await windowByFile(app, "chat.html");
    await chat.waitForLoadState();

    const ask = async (q) => {
      const n = await chat.$$eval(".a", (a) => a.length);
      await chat.fill("#input", q);
      await chat.press("#input", "Enter");
      await chat.waitForFunction((n) => document.querySelectorAll(".a").length === n + 1 &&
        document.querySelectorAll(".a")[n].textContent.includes("Mock answer"), n);
      return mock.requests.at(-1).body;
    };

    // ---- no profile yet: nothing extra is sent ----
    await chat.uncheck("#shot");
    let body = await ask("hello");
    assert.equal(body.messages.length, 1, "no profile turn without documents");
    assert.doesNotMatch(body.system, /user's profile/);
    console.log("ok: without a profile, requests are unchanged");

    // ---- upload through the Profile tab ----
    await app.evaluate(() => global.__overlayTest.tray.buildMenu().items.find((i) => i.label === "Settings…").click());
    const settings = await windowByFile(app, "settings.html");
    await settings.waitForLoadState();
    await settings.click('nav button[data-tab="profile"]');
    await settings.setInputFiles("#doc-file", [cvPath, notesPath, fakePdf]);
    await settings.waitForFunction(() => document.querySelector("#doc-msg").textContent.includes("not-really.pdf"));
    const msg = await settings.textContent("#doc-msg");
    assert.match(msg, /not-really\.pdf: That file isn't a valid PDF/);
    const docs = await settings.$$eval("#doc-list li .name", (n) => n.map((x) => x.textContent));
    assert.deepEqual(docs, ["Jane Doe CV.pdf", "notes.md"]);
    console.log("ok: PDF and .md added; fake PDF rejected with a clear message");

    await settings.fill("#about-me", "Looking for a staff role; I enjoy mentoring.");
    await settings.click("#about-save");
    await settings.waitForFunction(() => document.querySelector("#about-msg").textContent === "Saved.");
    await settings.screenshot({ path: path.join(outDir, "settings-profile.png") });

    // ---- what Claude receives ----
    body = await ask("Tell me about your last job");
    const [profileTurn, ack, ...rest] = body.messages;
    assert.equal(profileTurn.role, "user");
    assert.equal(ack.role, "assistant");
    assert.equal(rest.length, 3, "profile turn sits before the existing history");
    // Adding a profile mid-conversation changes what the first answer's thinking was bound to:
    // the app leaves that thinking out, so nothing stale reaches the API.
    assert.ok(!rest[1].content.some((b) => b.type === "thinking"), "earlier thinking left out");
    assert.deepEqual(mock.requests.at(-1).dropped, []);
    const pdfBlock = profileTurn.content.find((c) => c.type === "document" && c.source.type === "base64");
    assert.equal(pdfBlock.source.media_type, "application/pdf");
    assert.equal(pdfBlock.title, "Jane Doe CV.pdf");
    assert.ok(Buffer.from(pdfBlock.source.data, "base64").equals(cvBytes), "PDF sent byte-for-byte");
    const textBlock = profileTurn.content.find((c) => c.type === "document" && c.source.type === "text");
    assert.match(textBlock.source.data, /p99 latency by 40%/);
    const last = profileTurn.content.at(-1);
    assert.match(last.text, /<about_me>[\s\S]*staff role/);
    assert.deepEqual(last.cache_control, { type: "ephemeral" }, "profile prefix is cached");
    assert.match(body.system, /facts from the profile/);
    console.log("ok: PDF, notes and About-me sent as a cached profile turn with first-person interview guidance");

    // same prefix on the next question (cache-friendly)
    const body2 = await ask("And your strengths?");
    assert.deepEqual(body2.messages.slice(0, 2), body.messages.slice(0, 2), "profile prefix is byte-stable");
    console.log("ok: profile prefix identical across questions");

    // ---- disable / remove ----
    await settings.click("#doc-list li:first-child input[type=checkbox]");
    await sleep(200);
    body = await ask("Again?");
    assert.ok(!body.messages[0].content.some((c) => c.source?.type === "base64"), "disabled PDF not sent");
    console.log("ok: unchecked document is left out");

    settings.once("dialog", (d) => d.accept());
    await settings.click("#doc-list li:last-child button.danger");
    await settings.waitForFunction(() => document.querySelectorAll("#doc-list li").length === 1);
    const stored = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert.equal(stored.profileDocs.length, 1);
    assert.equal(fs.readdirSync(path.join(userData, "profile")).length, 1, "removed file deleted from disk");
    assert.equal(stored.aboutMe, "Looking for a staff role; I enjoy mentoring.");
    console.log("ok: removing a document deletes its file; About-me persisted");

    assert.deepEqual(errors, [], "no renderer errors");
    console.log("\nPROFILE PASSED");
  } finally {
    await app.close();
    mock.close();
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
