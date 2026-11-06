// Checks the GNOME extension installer without a shell: files, version list, idempotence, gsettings parsing.
// Usage: node tests/gnome-extension-unit.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installFiles, parseStrv, formatStrv, UUID } = require("../src/gnome-extension");

const source = path.join(__dirname, "..", "gnome-extension");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-ext-"));
const target = path.join(dir, UUID);

// Fresh install: both files, the running shell's major version added once
let r = installFiles(source, target, "99");
assert.equal(r.changed, true);
const meta = JSON.parse(fs.readFileSync(path.join(target, "metadata.json"), "utf8"));
assert.equal(meta.uuid, UUID);
assert.ok(meta["shell-version"].includes("99"), "running shell version listed");
assert.equal(meta["shell-version"].filter((v) => v === "99").length, 1);
assert.equal(fs.readFileSync(path.join(target, "extension.js"), "utf8"), fs.readFileSync(path.join(source, "extension.js"), "utf8"));
assert.equal(r.version, meta.version);
console.log("ok: extension installed with the shell's version");

// Same again: nothing written
const before = fs.statSync(path.join(target, "extension.js")).mtimeMs;
r = installFiles(source, target, "99");
assert.equal(r.changed, false);
assert.equal(fs.statSync(path.join(target, "extension.js")).mtimeMs, before);
console.log("ok: reinstall is a no-op");

// A version already listed isn't duplicated; a stale copy is replaced
fs.writeFileSync(path.join(target, "extension.js"), "// old");
r = installFiles(source, target, "45");
assert.equal(r.changed, true);
assert.equal(JSON.parse(fs.readFileSync(path.join(target, "metadata.json"), "utf8"))["shell-version"].filter((v) => v === "45").length, 1);
assert.notEqual(fs.readFileSync(path.join(target, "extension.js"), "utf8"), "// old");
console.log("ok: stale copy replaced");

// gsettings string arrays
assert.deepEqual(parseStrv("['a@b.c', 'd-e@f']\n"), ["a@b.c", "d-e@f"]);
assert.deepEqual(parseStrv("@as []\n"), []);
assert.equal(formatStrv([]), "@as []");
assert.equal(formatStrv(["a@b", "c@d"]), "['a@b', 'c@d']");
console.log("ok: gsettings arrays parsed and formatted");

fs.rmSync(dir, { recursive: true, force: true });
console.log("ALL OK");
