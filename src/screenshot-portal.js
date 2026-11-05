// Screenshots in Wayland sessions through the desktop's Screenshot portal (org.freedesktop.portal.Screenshot).
// Chromium's screen capture goes through the ScreenCast portal, which asks the user to pick a screen every
// time. A non-interactive Screenshot asks once ("Allow Overlay Assistant to take screenshots?") and the
// desktop remembers the answer. GNOME only shows that question while the app has focus, so the first
// grant happens on a click in the overlay; until then this fails and the caller falls back.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");

// The .deb's desktop file is overlay-assistant.desktop, so the desktop shows the app's own name and icon.
const APP_ID = "overlay-assistant";
const PORTAL = { destination: "org.freedesktop.portal.Desktop", path: "/org/freedesktop/portal/desktop" };
const TIMEOUT_MS = 120_000; // the first time, the user is answering a dialog

let busPromise = null;

async function connect() {
  const dbus = require("dbus-next");
  const bus = dbus.sessionBus();
  bus.on("error", () => (busPromise = null));
  await new Promise((resolve, reject) => {
    bus.once("connect", resolve);
    bus.once("error", reject);
  });
  // Name the app before any other portal call, so the permission belongs to it and not to
  // whatever launched it (a terminal, a shortcut). Older portals don't have this; that's fine.
  await bus
    .call(new dbus.Message({
      ...PORTAL,
      interface: "org.freedesktop.host.portal.Registry",
      member: "Register",
      signature: "sa{sv}",
      body: [APP_ID, {}],
    }))
    .catch(() => {});
  return { bus, dbus };
}

/** PNG of the whole desktop. Rejects if the portal is missing, the user hasn't allowed it yet, or it fails. */
async function portalScreenshot() {
  busPromise ??= connect();
  busPromise.catch(() => (busPromise = null));
  const { bus, dbus } = await busPromise;

  const token = `overlay${crypto.randomBytes(6).toString("hex")}`;
  const requestPath = `/org/freedesktop/portal/desktop/request/${bus.name.slice(1).replace(/\./g, "_")}/${token}`;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("the desktop didn't answer the screenshot request")), TIMEOUT_MS);
    // The portal sends Response straight to this connection, so no match rule is needed.
    const onMessage = (msg) => {
      if (msg.type === dbus.MessageType.SIGNAL && msg.path === requestPath && msg.member === "Response") done(null, msg.body);
    };
    function done(err, body) {
      clearTimeout(timer);
      bus.removeListener("message", onMessage);
      err ? reject(err) : resolve(body);
    }
    bus.on("message", onMessage);
  });

  const requestedAt = Date.now();
  await bus.call(new dbus.Message({
    ...PORTAL,
    interface: "org.freedesktop.portal.Screenshot",
    member: "Screenshot",
    signature: "sa{sv}",
    body: ["", { handle_token: new dbus.Variant("s", token), interactive: new dbus.Variant("b", false) }],
  }));

  const [code, results] = await response;
  if (code === 1) throw new Error("screenshot cancelled");
  if (code !== 0 || !results.uri) throw new Error("screenshot not allowed");
  // The portal saves the picture as a file (GNOME: in ~/Pictures), so take it and delete it, or every
  // question would leave a copy of the screen behind. Only a file written for this request, though.
  const file = fileURLToPath(results.uri.value);
  const png = fs.readFileSync(file);
  if (fs.statSync(file).mtimeMs >= requestedAt - 1000) fs.rmSync(file, { force: true });
  return png;
}

module.exports = { portalScreenshot };
