// Generates an Ed25519 keypair for signing device-bound licenses + an admin secret.
// Usage: node scripts/keygen.js
const crypto = require("node:crypto");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const adminSecret = crypto.randomBytes(24).toString("hex");

console.log("=== Add PUBLIC_KEY to src/license.js ===");
console.log(pubDer);
console.log("\n=== Set these as Cloudflare Worker secrets (`wrangler secret put ...`) ===");
console.log("LICENSE_PRIVATE_KEY=" + privDer);
console.log("ADMIN_SECRET=" + adminSecret);

