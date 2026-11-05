// Downloads the Whisper model into build/models so the installer can ship it.
// Resumes interrupted downloads and verifies each file's size, so a partial file
// can never be mistaken for a complete one.
// Usage: node scripts/fetch-model.js
const fs = require("node:fs");
const path = require("node:path");

const MODEL = "Xenova/whisper-base.en";
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const OUT = path.join(__dirname, "..", "build", "models", MODEL);
const ATTEMPTS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// Large (LFS) files report their size; small text files may not (compressed responses).
async function remoteSize(url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow" });
    } catch (err) {
      // network hiccup (every build re-checks sizes): retry like the downloads do
      if (attempt >= ATTEMPTS) throw err;
      console.log(`retry HEAD ${url.slice(BASE.length + 1)} (${attempt}/${ATTEMPTS}): ${err.message}`);
      await sleep(Math.min(2000 * attempt, 15000));
      continue;
    }
    if (!res.ok) throw new Error(`HEAD ${url}: ${res.status}`);
    const size = Number(res.headers.get("x-linked-size") || res.headers.get("content-length"));
    return size > 0 ? size : null;
  }
}

// Small files of unknown size: fetch whole, keep only if the body arrived completely.
async function downloadWhole(file, url, dest) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("empty response");
      if (file.endsWith(".json")) JSON.parse(buf.toString("utf8")); // truncated JSON won't parse
      fs.writeFileSync(dest, buf);
      console.log(`ok    ${file} (${mb(buf.length)})`);
      return;
    } catch (err) {
      console.log(`retry ${file} (${attempt}/${ATTEMPTS}): ${err.message}`);
      await sleep(Math.min(2000 * attempt, 15000));
    }
  }
  throw new Error(`${file}: failed after ${ATTEMPTS} attempts`);
}

async function download(file) {
  const url = `${BASE}/${file}`;
  const dest = path.join(OUT, file);
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const size = await remoteSize(url);
  if (size === null) {
    if (fs.existsSync(dest)) {
      console.log(`ok    ${file} (already present)`);
      return;
    }
    return downloadWhole(file, url, dest);
  }
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
    console.log(`ok    ${file} (${mb(size)}, already complete)`);
    return;
  }
  fs.rmSync(dest, { force: true }); // wrong size: never trust it

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have === size) break;
    try {
      const res = await fetch(url, { redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {} });
      if (have && res.status !== 206) {
        fs.rmSync(part, { force: true }); // server ignored the range; start over
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      let got = have;
      let lastLog = 0;
      for await (const chunk of res.body) {
        out.write(chunk);
        got += chunk.length;
        if (Date.now() - lastLog > 5000) {
          process.stdout.write(`      ${file} ${Math.floor((got / size) * 100)}% (${mb(got)} / ${mb(size)})\n`);
          lastLog = Date.now();
        }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (err) {
      console.log(`retry ${file} (${attempt}/${ATTEMPTS}): ${err.message}`);
      await sleep(Math.min(2000 * attempt, 15000));
    }
  }

  const final = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (final !== size) throw new Error(`${file}: got ${final} of ${size} bytes after ${ATTEMPTS} attempts`);
  fs.renameSync(part, dest);
  console.log(`ok    ${file} (${mb(size)})`);
}

(async () => {
  console.log(`Fetching ${MODEL} into ${path.relative(process.cwd(), OUT)}`);
  for (const f of FILES) await download(f);
  console.log("Model ready.");
})().catch((err) => {
  console.error(`fetch-model: ${err.message}`);
  process.exit(1);
});
