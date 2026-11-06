// Tells when something is capturing the screen (a screen share, a recording), so the overlay can hide
// in the meantime. Linux can't keep a window out of a capture, but under Wayland every capture
// (GNOME, KDE, wlroots: all through the ScreenCast portal) is a PipeWire video stream, and
// `pw-dump -m` (pipewire-bin) reports those streams as they start and stop.
const { spawn } = require("node:child_process");

// What a screen or window being cast looks like in the PipeWire graph; cameras are "Video/Source"
// and apps that read video are "Stream/Input/Video".
const CAPTURE_CLASS = "Stream/Output/Video";
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const HEALTHY_MS = 60_000; // a run this long resets the retry backoff
const GIVE_UP_AFTER = 4; // quick failures in a row (PipeWire not running) before the setting says "unavailable"

/** Keeps the set of capture streams across pw-dump batches. */
class CaptureTracker {
  constructor() {
    this.nodes = new Set();
  }

  /** @param {object[]} batch one pw-dump array @returns {boolean} whether a capture is active afterwards */
  apply(batch) {
    for (const obj of batch) {
      if (!obj || typeof obj.id !== "number") continue;
      if (obj.info === null) this.nodes.delete(obj.id);
      else if (obj.type === "PipeWire:Interface:Node" && obj.info?.props?.["media.class"] === CAPTURE_CLASS) this.nodes.add(obj.id);
    }
    return this.nodes.size > 0;
  }

  reset() {
    this.nodes.clear();
  }
}

/** Splits `pw-dump -m` output into its JSON arrays: each is pretty-printed with `[` and `]` alone on a line. */
class BatchParser {
  constructor(onBatch) {
    this.onBatch = onBatch;
    this.buf = "";
  }

  feed(chunk) {
    this.buf += chunk;
    let end;
    while ((end = this.buf.indexOf("\n]\n")) !== -1) {
      const text = this.buf.slice(0, end + 2);
      this.buf = this.buf.slice(end + 3);
      let batch;
      try {
        batch = JSON.parse(text);
      } catch {
        continue; // pw-dump output got interleaved with something else; the next batch resyncs
      }
      if (Array.isArray(batch)) this.onBatch(batch);
    }
  }
}

/**
 * Runs `pw-dump -m` and reports when a screen capture starts or stops.
 * @param {(active: boolean) => void} onChange
 * @param {{ onStateChange?: (state: "watching" | "unavailable") => void, command?: string, log?: Console }} [opts]
 * @returns {{ stop: () => void, isActive: () => boolean, readonly available: boolean }}
 */
function watchScreenCaptures(onChange, { onStateChange, command = "pw-dump", log = console } = {}) {
  const tracker = new CaptureTracker();
  let child = null;
  let timer = null;
  let stopped = false;
  let active = false;
  let failures = 0;
  let available = true;

  const setActive = (next) => {
    if (next === active) return;
    active = next;
    onChange(active);
  };
  const setAvailable = (next) => {
    if (next === available) return;
    available = next;
    onStateChange?.(available ? "watching" : "unavailable");
  };

  function start() {
    timer = null;
    const startedAt = Date.now();
    let ended = false;
    const parser = new BatchParser((batch) => {
      failures = 0; // PipeWire answered, so this is a working setup
      setAvailable(true);
      setActive(tracker.apply(batch));
    });
    child = spawn(command, ["-m"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => parser.feed(chunk));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-500)));
    child.on("error", (err) => {
      if (err.code !== "ENOENT") return; // exit handles the rest
      ended = true;
      child = null;
      log.warn(`${command} not found (install pipewire-bin): the overlay can't tell when the screen is being shared`);
      setAvailable(false);
    });
    child.on("exit", (code, signal) => {
      if (ended) return;
      ended = true;
      child = null;
      tracker.reset();
      setActive(false);
      if (stopped) return;
      failures = Date.now() - startedAt >= HEALTHY_MS ? 0 : failures + 1;
      if (failures >= GIVE_UP_AFTER) setAvailable(false);
      const delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.max(0, failures - 1));
      log.warn(`${command} exited (${signal ?? code}${stderr.trim() ? `: ${stderr.trim()}` : ""}); retrying in ${delay / 1000}s`);
      timer = setTimeout(start, delay);
    });
  }

  start();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
    },
    isActive: () => active,
    get available() {
      return available;
    },
  };
}

module.exports = { watchScreenCaptures, CaptureTracker, BatchParser, CAPTURE_CLASS };
