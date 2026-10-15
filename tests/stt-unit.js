// Transcribes tests/fixtures/question.wav with the local Whisper worker.
// Usage: node tests/stt-unit.js [cacheDir]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WhisperSTT } = require("../src/stt/whisper");

function readWav16kMono(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let fmt, data;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (fmt.rate !== 16000 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error(`unexpected wav format ${JSON.stringify(fmt)}`);
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

(async () => {
  const cacheDir = process.argv[2] ?? path.join(os.tmpdir(), "overlay-models");
  const samples = readWav16kMono(path.join(__dirname, "fixtures", "question.wav"));
  let last = -1;
  const stt = new WhisperSTT({
    cacheDir,
    onProgress: ({ file, progress }) => {
      const p = Math.floor(progress / 25) * 25;
      if (p !== last) console.log(`download ${file} ${p}%`), (last = p);
    },
  });
  let t = Date.now();
  await stt.ready;
  console.log(`model ready in ${Date.now() - t} ms`);
  t = Date.now();
  const text = await stt.transcribe(samples);
  console.log(`transcribed ${(samples.length / 16000).toFixed(1)}s audio in ${Date.now() - t} ms: "${text}"`);
  await stt.dispose();
  if (!/process/i.test(text) || !/thread/i.test(text)) {
    console.error("FAILED: transcript missing expected words");
    process.exit(1);
  }
  console.log("STT PASSED");
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
