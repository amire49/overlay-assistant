// System tray icon + menu. The icon is drawn in code so no image asset is needed.
const { Tray, Menu, nativeImage } = require("electron");

function makeIcon(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      // BGRA: accent ring with a light center dot
      const ring = d <= size * 0.47 && d >= size * 0.3;
      const dot = d <= size * 0.16;
      const alpha = ring || dot ? 255 : 0;
      buf[i] = 0xff; // B
      buf[i + 1] = dot ? 0xff : 0x8c; // G
      buf[i + 2] = dot ? 0xff : 0x7c; // R
      buf[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/**
 * @param {{ getState: () => { visible: boolean, listening: boolean, modes: {id:string,name:string}[], activeModeId: string },
 *           actions: Record<string, Function> }} opts
 */
function createTray({ getState, actions }) {
  const tray = new Tray(makeIcon());
  tray.setToolTip("Overlay Assistant");

  function buildMenu() {
    const s = getState();
    const update = s.update?.state === "ready"
      ? [{ label: `Restart to update (v${s.update.version})`, click: actions.installUpdate }, { type: "separator" }]
      : [];
    return Menu.buildFromTemplate([
      ...update,
      { label: s.visible ? "Hide overlay" : "Show overlay", accelerator: "CommandOrControl+\\", click: actions.toggleAll },
      { label: "Ask about screen", accelerator: "CommandOrControl+Enter", click: actions.askScreen },
      { label: s.listening ? "Stop listening" : "Start listening", accelerator: "CommandOrControl+Shift+L", click: actions.toggleListening },
      { label: "New session", accelerator: "CommandOrControl+R", click: actions.reset },
      { type: "separator" },
      {
        label: "Mode",
        submenu: s.modes.map((m) => ({
          label: m.name,
          type: "radio",
          checked: m.id === s.activeModeId,
          click: () => actions.setMode(m.id),
        })),
      },
      { type: "separator" },
      { label: "Settings…", click: () => actions.openSettings("general") },
      { label: "History…", click: () => actions.openSettings("history") },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]);
  }

  const refresh = () => tray.setContextMenu(buildMenu());
  tray.on("click", actions.toggleAll);
  refresh();
  return { tray, refresh, buildMenu };
}

module.exports = { createTray };
