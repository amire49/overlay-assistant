// worker_thread: local Whisper speech-to-text via transformers.js (ONNX runtime).
const { parentPort, workerData } = require("node:worker_threads");

// Whisper's usual outputs on silence/noise.
const NOISE = /^\s*[\[(].*[\])]\s*$|^\s*(thank you|thanks for watching|you)[.!]?\s*$/i;

let asrPromise;

const LOAD_ATTEMPTS = 5;

async function loadOnce() {
  const { pipeline, env } = await import("@huggingface/transformers");
  if (workerData.bundledDir) {
    // Installed app: the model ships with it, so never touch the network.
    env.localModelPath = workerData.bundledDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  } else {
    env.cacheDir = workerData.cacheDir;
    env.allowLocalModels = false;
  }
  return pipeline("automatic-speech-recognition", workerData.model, {
    dtype: "q8",
    progress_callback: (p) => {
      // transformers.js also reports progress while reading local files; only real downloads count.
      if (p.status === "progress" && !workerData.bundledDir) {
        parentPort.postMessage({ type: "progress", file: p.file, progress: p.progress });
      }
    },
  });
}

function load() {
  asrPromise ??= (async () => {
    // Completed files stay in the cache, so a retry after a dropped download resumes at the next file.
    for (let attempt = 1; ; attempt++) {
      try {
        return await loadOnce();
      } catch (err) {
        if (attempt >= LOAD_ATTEMPTS || !/fetch|network|ECONN|ETIMEDOUT|socket/i.test(String(err.message))) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  })();
  asrPromise.catch(() => (asrPromise = null));
  return asrPromise;
}

parentPort.on("message", async (msg) => {
  try {
    if (msg.type === "load") {
      await load();
      parentPort.postMessage({ type: "ready" });
    } else if (msg.type === "transcribe") {
      const asr = await load();
      const out = await asr(msg.samples);
      const text = out.text.trim();
      parentPort.postMessage({ type: "result", id: msg.id, text: NOISE.test(text) ? "" : text });
    }
  } catch (err) {
    parentPort.postMessage({ type: "error", id: msg.id, message: err.message });
  }
});
