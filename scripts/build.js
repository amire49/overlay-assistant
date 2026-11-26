// Builds the Windows installer with electron-builder.
//   node scripts/build.js   -> dist/OverlayAssistant-Setup-<version>.exe, updating from the private
//                              GitHub repo's Releases (publish with scripts/release.js)
//   OVERLAY_UPDATE_URL=https://host/path/ node scripts/build.js
//                           -> updates from a plain static URL instead (used by the installer test)
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const builder = require("electron-builder");

const root = path.join(__dirname, "..");

// The installer ships the speech model so Listen never downloads anything.
// fetch-model.js is resumable and skips files that are already complete.
const fetched = spawnSync(process.execPath, [path.join(__dirname, "fetch-model.js")], { cwd: root, stdio: "inherit" });
if (fetched.status !== 0) {
  console.error("build: speech model is missing or incomplete; not building an installer without it");
  process.exit(1);
}
const updateUrl = process.env.OVERLAY_UPDATE_URL;
const GITHUB = { owner: "amire49", repo: "overlay-assistant" };

const config = {
  appId: "com.overlayassistant.app",
  productName: "Overlay Assistant",
  copyright: "Copyright © 2026",
  directories: { output: process.env.OVERLAY_OUT ?? "dist", buildResources: "build" },
  // tests build a "newer" copy without editing package.json
  ...(process.env.OVERLAY_VERSION && { extraMetadata: { version: process.env.OVERLAY_VERSION } }),
  // Reuse the Electron already in node_modules instead of downloading it again.
  electronDist: path.join(root, "node_modules", "electron", "dist"),
  // Plain files instead of app.asar: the Whisper worker thread and ONNX native
  // runtime load from disk, which is simplest and most reliable unpacked.
  asar: false,
  electronLanguages: ["en-US"], // Chromium UI strings only; saves ~40 MB

  files: [
    "src/**/*",
    "package.json",
    "!**/*.map",
    // native ONNX runtime: keep only Windows x64
    "!node_modules/onnxruntime-node/bin/napi-v3/{darwin,linux}/**",
    "!node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/**",
    // browser builds that the Node code path never loads
    "!node_modules/onnxruntime-web/dist/{*.wasm,ort.all*,ort.webgl*,ort.webgpu*,ort.bundle*,ort.wasm*,ort-wasm*,ort.js,ort.mjs,ort.min.*}",
    "!node_modules/@huggingface/transformers/dist/{transformers.js,transformers.min.js,transformers.web*}",
  ],
  // -> resources/models/Xenova/whisper-base.en/...
  extraResources: [{ from: "build/models", to: "models", filter: ["**/*", "!**/*.part"] }],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
  },
  nsis: {
    // no spaces: GitHub rewrites spaces in release asset names, which would break latest.yml
    artifactName: "OverlayAssistant-Setup-${version}.${ext}",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Overlay Assistant",
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },
  publish: updateUrl
    ? [{ provider: "generic", url: updateUrl }]
    : [{ provider: "github", ...GITHUB, private: false, releaseType: "release" }],
};

builder
  .build({ projectDir: root, targets: builder.Platform.WINDOWS.createTarget(), config, publish: "never" })
  .then((files) => {
    console.log("\nBuilt:");
    for (const f of files) console.log("  " + path.relative(root, f));
    console.log(`\nUpdate feed: ${updateUrl ?? `GitHub Releases ${GITHUB.owner}/${GITHUB.repo} (public)`}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
