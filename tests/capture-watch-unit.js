// Checks the parsing of `pw-dump -m` output and the capture watcher's lifecycle, without PipeWire.
// Usage: node tests/capture-watch-unit.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BatchParser, CaptureTracker, watchScreenCaptures } = require("../src/capture-watch");

// What a GNOME screen share looks like in pw-dump output (trimmed), then the node going away.
const dumpAdded = `[
  {
    "id": 63,
    "type": "PipeWire:Interface:Node",
    "version": 3,
    "info": {
      "props": {
        "media.class": "Video/Source",
        "node.name": "v4l2_input.pci-0000_00_14.0-usb-0_6_1.0",
        "object.id": 63
      }
    }
  },
  {
    "id": 77,
    "type": "PipeWire:Interface:Node",
    "version": 3,
    "info": {
      "state": "suspended",
      "props": {
        "media.class": "Stream/Output/Video",
        "node.name": "gnome-shell",
        "object.id": 77
      }
    }
  }
]
`;
const dumpRemoved = `[
  {
    "id": 77,
    "info": null
  }
]
`;

(async () => {
  // Parser: batches arrive split at arbitrary points and are delivered whole
  const batches = [];
  const parser = new BatchParser((b) => batches.push(b));
  const text = dumpAdded + dumpRemoved;
  for (let i = 0; i < text.length; i += 7) parser.feed(text.slice(i, i + 7));
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 2);
  assert.deepEqual(batches[1], [{ id: 77, info: null }]);
  console.log("ok: pw-dump batches parsed");

  // Tracker: only "Stream/Output/Video" nodes count; a camera doesn't
  const tracker = new CaptureTracker();
  assert.equal(tracker.apply(batches[0]), true, "screen cast node means active");
  assert.equal(tracker.apply([{ id: 63, info: null }]), true, "camera going away changes nothing");
  assert.equal(tracker.apply(batches[1]), false, "screen cast node removed means inactive");
  assert.equal(tracker.apply([batches[0][0]]), false, "a camera alone isn't a capture");
  console.log("ok: capture nodes tracked");

  if (process.platform !== "linux") return console.log("skip: watcher process checks are Linux-only");

  // Watcher with a stand-in pw-dump: reports the capture starting and stopping
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-capture-"));
  fs.writeFileSync(path.join(dir, "added.json"), dumpAdded);
  fs.writeFileSync(path.join(dir, "removed.json"), dumpRemoved);
  const fake = path.join(dir, "pw-dump");
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = "-m" ] || exit 2\ncat "${dir}/added.json"\nsleep 0.3\ncat "${dir}/removed.json"\nsleep 30\n`, { mode: 0o755 });
  const changes = [];
  const states = [];
  const watcher = watchScreenCaptures((active) => changes.push(active), { command: fake, onStateChange: (s) => states.push(s), log: { warn() {} } });
  await waitFor(() => changes.length === 2, "capture start and stop reported");
  assert.deepEqual(changes, [true, false]);
  assert.equal(watcher.available, true);
  watcher.stop();
  console.log("ok: watcher reports a capture starting and stopping");

  // Missing pw-dump: unavailable, no change reported
  const missingStates = [];
  const missing = watchScreenCaptures(() => assert.fail("no change without pw-dump"), {
    command: path.join(dir, "no-such-pw-dump"),
    onStateChange: (s) => missingStates.push(s),
    log: { warn() {} },
  });
  await waitFor(() => missingStates.length === 1, "missing command reported");
  assert.deepEqual(missingStates, ["unavailable"]);
  assert.equal(missing.available, false);
  missing.stop();
  console.log("ok: missing pw-dump makes auto-hide unavailable");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ALL OK");
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});

async function waitFor(cond, what, ms = 5000) {
  for (let i = 0; i < ms / 50; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
