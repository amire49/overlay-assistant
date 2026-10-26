// Main-process wrapper around the Whisper worker: one queue, promise per segment.
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const fs = require("node:fs");

const DEFAULT_MODEL = "Xenova/whisper-base.en";

/** A models folder (e.g. resources/models) that contains the model, or null. */
function findBundledModels(dirs, model = DEFAULT_MODEL) {
  return dirs.find((d) => d && fs.existsSync(path.join(d, model, "onnx", "encoder_model_quantized.onnx"))) ?? null;
}

class WhisperSTT {
  /** bundledDir: offline model folder (used when set); cacheDir: download cache otherwise. */
  constructor({ cacheDir, bundledDir = null, model = DEFAULT_MODEL, onProgress }) {
    this.bundled = Boolean(bundledDir);
    this.worker = new Worker(path.join(__dirname, "whisper-worker.js"), {
      workerData: { cacheDir, bundledDir, model },
    });
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (msg) => {
        if (msg.type === "ready") resolve();
        else if (msg.type === "progress") onProgress?.(msg);
        else if (msg.type === "result") this.settle(msg.id, null, msg.text);
        else if (msg.type === "error") {
          if (msg.id) this.settle(msg.id, new Error(msg.message));
          else reject(new Error(msg.message));
        }
      });
      this.worker.on("error", reject);
    });
    this.ready.catch(() => {});
    this.worker.postMessage({ type: "load" });
  }

  settle(id, err, text) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    err ? p.reject(err) : p.resolve(text);
  }

  /** @param {Float32Array} samples mono 16 kHz PCM */
  transcribe(samples) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "transcribe", id, samples });
    });
  }

  dispose() {
    return this.worker.terminate();
  }
}

module.exports = { WhisperSTT, findBundledModels };
