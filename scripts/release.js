// Builds the installer and publishes it as a GitHub Release (the app's update feed).
// Usage: bump "version" in package.json, commit and push, then: npm run release [-- --notes "What changed"]
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
const tag = `v${version}`;
const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }) ?? "").trim();

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const notesIdx = process.argv.indexOf("--notes");
const notes = notesIdx > 0 ? process.argv[notesIdx + 1] : `Overlay Assistant ${tag}`;

// Releases must match committed, pushed code.
if (sh("git", ["status", "--porcelain"])) fail("working tree has uncommitted changes");
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
sh("git", ["fetch", "--quiet", "origin", branch]);
if (sh("git", ["rev-parse", "HEAD"]) !== sh("git", ["rev-parse", `origin/${branch}`])) fail(`push ${branch} first`);
const existing = spawnSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" });
if (existing.status === 0) fail(`release ${tag} already exists; bump "version" in package.json`);

const env = { ...process.env };
delete env.OVERLAY_UPDATE_URL; // releases always use the GitHub feed
const build = spawnSync(process.execPath, [path.join(__dirname, "build.js")], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) fail("build failed");

const exe = `OverlayAssistant-Setup-${version}.exe`;
const assets = [exe, `${exe}.blockmap`, "latest.yml"].map((f) => path.join(root, "dist", f));
for (const a of assets) if (!fs.existsSync(a)) fail(`missing ${a}`);

console.log(`\nPublishing ${tag}…`);
sh("gh", ["release", "create", tag, ...assets, "--title", tag, "--notes", notes, "--target", branch], { stdio: "inherit" });
console.log(sh("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"]));
