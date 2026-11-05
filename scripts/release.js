// Builds this OS's installer and publishes it to GitHub Release v<version> (the app's update feed).
// Usage: bump "version" in package.json, commit and push, then: npm run release [-- --notes "What changed"]
// Run it on Windows (.exe) and on Linux (.deb) from the same commit: the first run creates the
// release and the second adds its files to it.
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

// What scripts/build.js writes to dist/ for each OS; the .yml is the update feed for that OS.
const exe = `OverlayAssistant-Setup-${version}.exe`;
const ASSETS = {
  win32: [exe, `${exe}.blockmap`, "latest.yml"],
  linux: [`overlay-assistant_${version}_amd64.deb`, "latest-linux.yml"],
}[process.platform];
if (!ASSETS) fail(`no installer for ${process.platform}; release from Windows or Linux`);

const notesIdx = process.argv.indexOf("--notes");
const notes = notesIdx > 0 ? process.argv[notesIdx + 1] : `Overlay Assistant ${tag}`;

// Releases must match committed, pushed code.
if (sh("git", ["status", "--porcelain"])) fail("working tree has uncommitted changes");
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
sh("git", ["fetch", "--quiet", "origin", branch]);
const head = sh("git", ["rev-parse", "HEAD"]);
if (head !== sh("git", ["rev-parse", `origin/${branch}`])) fail(`push ${branch} first`);

const existing = spawnSync("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"], { cwd: root, encoding: "utf8" });
const exists = existing.status === 0;
if (exists) {
  const taken = ASSETS.filter((a) => existing.stdout.split("\n").includes(a));
  if (taken.length) fail(`release ${tag} already has ${taken.join(", ")}; bump "version" in package.json`);
  // Adding this OS's installer to a release made on the other OS: it must be the same code.
  sh("git", ["fetch", "--quiet", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  if (sh("git", ["rev-parse", `${tag}^{commit}`]) !== head) fail(`release ${tag} was made from a different commit; bump "version" in package.json`);
}

const env = { ...process.env };
delete env.OVERLAY_UPDATE_URL; // releases always use the GitHub feed
const build = spawnSync(process.execPath, [path.join(__dirname, "build.js")], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) fail("build failed");

const assets = ASSETS.map((f) => path.join(root, "dist", f));
for (const a of assets) if (!fs.existsSync(a)) fail(`missing ${a}`);

if (exists) {
  console.log(`\nAdding ${process.platform} files to ${tag}…`);
  sh("gh", ["release", "upload", tag, ...assets], { stdio: "inherit" });
} else {
  console.log(`\nPublishing ${tag}…`);
  sh("gh", ["release", "create", tag, ...assets, "--title", tag, "--notes", notes, "--target", branch], { stdio: "inherit" });
}
console.log(sh("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"]));
