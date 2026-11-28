// Device-bound licensing: generates a hardware-bound Device ID, verifies Ed25519-signed
// activation tokens, and syncs approval/revocation state with the Cloudflare Worker.
const crypto = require("node:crypto");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

// Replace with your Cloudflare Worker URL after deploying `license-server/worker.js`,
// or set OVERLAY_LICENSE_URL in the environment.
const DEFAULT_LICENSE_URL = "https://overlay-assistant-license.amirnasir7530.workers.dev";

// Replace with your generated Ed25519 SPKI public key (base64) from `node scripts/keygen.js`.
const DEFAULT_PUBLIC_KEY = "MCowBQYDK2VwAyEA3C63uHyy/T7O33kd1RvmfLr0mPCewTy+PckmCSzVcZk=";

let cachedDeviceId = null;

function getMachineGuid() {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (m?.[1]) return m[1].trim();
    } catch {}
  }
  return `${os.hostname()}-${os.cpus()[0]?.model ?? "cpu"}-${os.arch()}`;
}

/** Deterministic hardware-bound ID formatted as OA-XXXX-XXXX-XXXX-XXXX. */
function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  const raw = `${getMachineGuid()}|${os.platform()}|${os.arch()}`;
  const hex = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16).toUpperCase();
  cachedDeviceId = `OA-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  return cachedDeviceId;
}

/** Verifies an Ed25519-signed license token (`base64url(payload).base64url(sig)`). */
function verifyToken(token, deviceId, publicKeyB64 = process.env.OVERLAY_LICENSE_PUBLIC_KEY || DEFAULT_PUBLIC_KEY) {
  if (!token || !publicKeyB64) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  try {
    const [payloadB64, sigB64] = parts;
    const payloadBytes = Buffer.from(payloadB64, "base64url");
    const sigBytes = Buffer.from(sigB64, "base64url");
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });

    const ok = crypto.verify(null, Buffer.from(payloadB64, "utf8"), pubKey, sigBytes);
    if (!ok) return null;

    const payload = JSON.parse(payloadBytes.toString("utf8"));
    if (payload.deviceId !== deviceId) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Signs a token (used by tests and offline tooling). */
function signToken(payload, privateKeyB64) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sigB64 = crypto.sign(null, Buffer.from(payloadB64, "utf8"), privKey).toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

function getLicenseUrl() {
  return (process.env.OVERLAY_LICENSE_URL || DEFAULT_LICENSE_URL).replace(/\/+$/, "");
}

async function requestAccess({ name, appVersion, licenseUrl = getLicenseUrl() }) {
  if (!licenseUrl) throw new Error("License server URL is not configured.");
  const deviceId = getDeviceId();
  const res = await fetch(`${licenseUrl}/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId,
      name: String(name ?? "").trim().slice(0, 80),
      hostname: os.hostname(),
      appVersion,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

async function checkServerStatus({ licenseUrl = getLicenseUrl() } = {}) {
  if (!licenseUrl) return { status: "unconfigured" };
  const deviceId = getDeviceId();
  const res = await fetch(`${licenseUrl}/status?deviceId=${encodeURIComponent(deviceId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

module.exports = {
  getDeviceId,
  verifyToken,
  signToken,
  getLicenseUrl,
  requestAccess,
  checkServerStatus,
  DEFAULT_LICENSE_URL,
  DEFAULT_PUBLIC_KEY,
};
