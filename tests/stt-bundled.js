// Transcribes the spoken fixture using only the bundled model (build/models), with
// remote downloads disabled and an empty download cache: proves Listen works offline.
// Usage: node scripts/fetch-model.js && node tests/stt-bundled.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WhisperSTT, findBundledModels } = require("../src/stt/whisper");

function readWav16kMono(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let data;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

(async () => {
  const modelsDir = path.join(__dirname, "..", "build", "models");
  const bundledDir = findBundledModels([modelsDir]);
  assert.ok(bundledDir, "run `node scripts/fetch-model.js` first");
  assert.equal(findBundledModels([path.join(os.tmpdir(), "no-such-dir")]), null);

  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-empty-cache-"));
  let downloads = 0;
  const stt = new WhisperSTT({ bundledDir, cacheDir: emptyCache, onProgress: () => downloads++ });
  const t = Date.now();
  await stt.ready;
  console.log(`ok: model loaded from bundle in ${Date.now() - t} ms`);

  const text = await stt.transcribe(readWav16kMono(path.join(__dirname, "fixtures", "question.wav")));
  await stt.dispose();
  console.log(`transcript: "${text}"`);
  assert.match(text, /process/i);
  assert.match(text, /thread/i);
  assert.equal(downloads, 0, "no download progress events");
  assert.deepEqual(fs.readdirSync(emptyCache), [], "download cache untouched");
  console.log("ok: transcribed offline; nothing downloaded");
  console.log("\nBUNDLED STT PASSED");
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
