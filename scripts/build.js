// Builds the installer for this OS with electron-builder (--win or --linux picks one explicitly).
//   Windows: node scripts/build.js -> dist/OverlayAssistant-Setup-<version>.exe
//   Linux:   node scripts/build.js -> dist/overlay-assistant_<version>_amd64.deb
// Both update from the private GitHub repo's Releases (publish with scripts/release.js).
//   OVERLAY_UPDATE_URL=https://host/path/ node scripts/build.js
//                           -> updates from a plain static URL instead (used by the installer test)
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const builder = require("electron-builder");

const root = path.join(__dirname, "..");
const platform = process.argv.includes("--win") ? "win32" : process.argv.includes("--linux") ? "linux" : process.platform;
if (!["win32", "linux"].includes(platform)) {
  console.error(`build: no installer target for ${platform}; use --win or --linux`);
  process.exit(1);
}

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
  // Reuse the Electron already in node_modules instead of downloading it again
  // (it is the host's build, so only when building for the host).
  ...(platform === process.platform && { electronDist: path.join(root, "node_modules", "electron", "dist") }),
  // Plain files instead of app.asar: the Whisper worker thread and ONNX native
  // runtime load from disk, which is simplest and most reliable unpacked.
  asar: false,
  electronLanguages: ["en-US"], // Chromium UI strings only; saves ~40 MB

  files: [
    "src/**/*",
    "package.json",
    "!**/*.map",
    // native ONNX runtime: keep only the target OS, x64
    `!node_modules/onnxruntime-node/bin/napi-v3/{${["darwin", "linux", "win32"].filter((os) => os !== platform).join(",")}}/**`,
    `!node_modules/onnxruntime-node/bin/napi-v3/${platform}/arm64/**`,
    // Linux x64: GPU providers npm fetches (~340 MB; Whisper runs on the CPU) and a second copy of
    // the runtime (the binding loads libonnxruntime.so.1)
    "!node_modules/onnxruntime-node/bin/napi-v3/linux/x64/{libonnxruntime_providers_cuda.so,libonnxruntime_providers_tensorrt.so,libonnxruntime.so.1.*}",
    // Alpine (musl) builds of optional native packages; Debian and Ubuntu use glibc
    "!node_modules/@img/*-linuxmusl-*/**",
    "!node_modules/@napi-rs/*-linux-x64-musl/**",
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
  linux: {
    target: [{ target: "deb", arch: ["x64"] }],
    icon: "build/icon.png",
    executableName: "overlay-assistant", // also the /usr/bin command, e.g. `overlay-assistant --ask`
    executableArgs: ["--ozone-platform=x11"], // menu entry: run under XWayland without a restart (see main.js)
    category: "Utility",
    synopsis: "Floating AI assistant overlay: screenshot + ask Claude",
    maintainer: "amire49 <amirnasir7530@gmail.com>",
    // Electron's WM_CLASS is the package name; GNOME needs the match to tell the overlay is this app
    // (e.g. before it lets the app ask for screenshot access)
    desktop: { entry: { StartupWMClass: "overlay-assistant" } },
  },
  deb: {
    artifactName: "overlay-assistant_${version}_${arch}.${ext}",
  },
  publish: updateUrl
    ? [{ provider: "generic", url: updateUrl }]
    : [{ provider: "github", ...GITHUB, private: true, releaseType: "release" }],
};

builder
  .build({
    projectDir: root,
    targets: (platform === "linux" ? builder.Platform.LINUX : builder.Platform.WINDOWS).createTarget(),
    config,
    publish: "never",
  })
  .then((files) => {
    console.log("\nBuilt:");
    for (const f of files) console.log("  " + path.relative(root, f));
    console.log(`\nUpdate feed: ${updateUrl ?? `GitHub Releases ${GITHUB.owner}/${GITHUB.repo} (private)`}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
