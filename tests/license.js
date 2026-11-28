const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { getDeviceId, signToken, verifyToken } = require("../src/license");

// 1. Device ID format and determinism
const id1 = getDeviceId();
const id2 = getDeviceId();
assert.equal(id1, id2, "getDeviceId is deterministic");
assert.match(id1, /^OA-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/, "Device ID matches expected format");

// 2. Ed25519 sign & verify round-trip
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

const token = signToken({ deviceId: id1, approvedAt: Date.now() }, privB64);
const verified = verifyToken(token, id1, pubB64);
assert.ok(verified, "valid token for this device verifies");
assert.equal(verified.deviceId, id1);

// 3. Token copied to another device fails verification
assert.equal(verifyToken(token, "OA-0000-0000-0000-0000", pubB64), null, "rejects token on a different deviceId");

// 4. Tampered token fails verification
const [p, s] = token.split(".");
const tampered = `${p}.${s.slice(0, -2)}AA`;
assert.equal(verifyToken(tampered, id1, pubB64), null, "rejects tampered signature");

// 5. Expired token fails verification
const expired = signToken({ deviceId: id1, exp: Date.now() - 1000 }, privB64);
assert.equal(verifyToken(expired, id1, pubB64), null, "rejects expired token");

console.log("LICENSE UNIT TEST PASSED");

