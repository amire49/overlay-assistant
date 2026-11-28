// Cloudflare Worker: per-device approval & revocation server for Overlay Assistant.
// Bindings required:
//   KV Namespace: DEVICES
// Secrets required (`wrangler secret put ...`):
//   LICENSE_PRIVATE_KEY  (PKCS8 Ed25519 base64 from `node scripts/keygen.js`)
//   ADMIN_SECRET         (random hex string from `node scripts/keygen.js`)
// Optional notification secrets:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   DISCORD_WEBHOOK_URL

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function signDeviceToken(deviceId, privateKeyB64) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromB64(privateKeyB64),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const payload = { deviceId, approvedAt: Date.now() };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

async function notifyOwner(env, url, record) {
  const approveUrl = `${url.origin}/admin/decide?deviceId=${encodeURIComponent(record.deviceId)}&action=approve&secret=${encodeURIComponent(env.ADMIN_SECRET)}`;
  const revokeUrl = `${url.origin}/admin/decide?deviceId=${encodeURIComponent(record.deviceId)}&action=revoke&secret=${encodeURIComponent(env.ADMIN_SECRET)}`;
  const text =
    `🔐 Overlay Assistant Access Request\n` +
    `Name: ${record.name || "(none)"}\n` +
    `PC: ${record.hostname || "unknown"}\n` +
    `Device ID: ${record.deviceId}\n` +
    `Version: ${record.appVersion || "?"}`;

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: `approve:${record.deviceId}` },
            { text: "🚫 Deny / Revoke", callback_data: `revoke:${record.deviceId}` },
          ]],
        },
      }),
    }).catch(() => {});
  }

  if (env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${text}\n\n✅ Approve: ${approveUrl}\n🚫 Revoke: ${revokeUrl}`,
      }),
    }).catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 1. User clicks "Request Access" inside the .exe
    if (request.method === "POST" && url.pathname === "/request") {
      const body = await request.json().catch(() => ({}));
      const deviceId = String(body.deviceId || "").trim();
      if (!/^OA-[A-F0-9-]{19}$/.test(deviceId)) return json({ error: "Invalid deviceId" }, 400);

      const existing = await env.DEVICES.get(deviceId, "json");
      if (existing?.status === "approved") {
        const token = await signDeviceToken(deviceId, env.LICENSE_PRIVATE_KEY);
        return json({ status: "approved", token });
      }
      if (existing?.status === "revoked") {
        return json({ status: "revoked" });
      }

      const record = {
        deviceId,
        name: String(body.name || "").slice(0, 80),
        hostname: String(body.hostname || "").slice(0, 80),
        appVersion: String(body.appVersion || "").slice(0, 20),
        status: "pending",
        requestedAt: Date.now(),
      };
      await env.DEVICES.put(deviceId, JSON.stringify(record));
      await notifyOwner(env, url, record);
      return json({ status: "pending" });
    }

    // 2. App polls or checks on launch whether this deviceId is approved or revoked
    if (request.method === "GET" && url.pathname === "/status") {
      const deviceId = String(url.searchParams.get("deviceId") || "").trim();
      if (!deviceId) return json({ error: "Missing deviceId" }, 400);

      const record = await env.DEVICES.get(deviceId, "json");
      if (!record) return json({ status: "unrequested" });
      if (record.status === "approved") {
        const token = await signDeviceToken(deviceId, env.LICENSE_PRIVATE_KEY);
        return json({ status: "approved", token });
      }
      return json({ status: record.status });
    }

    // 3. Browser Admin Dashboard (`/admin?secret=...`)
    if (request.method === "GET" && url.pathname === "/admin") {
      const secret = url.searchParams.get("secret");
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });

      const list = await env.DEVICES.list();
      const rows = (await Promise.all(list.keys.map((k) => env.DEVICES.get(k.name, "json")))).filter(Boolean);
      rows.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));

      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Overlay Assistant — Devices</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#09090b;color:#fafafa;max-width:860px;margin:40px auto;padding:0 20px}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #27272a}
a.btn{display:inline-block;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:600;font-size:12px;margin-right:6px}
.ok{background:#059669;color:#fff}.no{background:#e11d48;color:#fff}.pill{padding:2px 8px;border-radius:99px;font-size:12px;background:#27272a}</style></head>
<body><h1>Overlay Assistant — Device Approvals</h1><p>Total devices: ${rows.length}</p>
<table><tr><th>Name</th><th>PC</th><th>Device ID</th><th>Status</th><th>Actions</th></tr>
${rows.map((r) => `<tr><td>${esc(r.name || "—")}</td><td>${esc(r.hostname || "—")}</td><td><code>${esc(r.deviceId)}</code></td><td><span class="pill">${esc(r.status)}</span></td>
<td><a class="btn ok" href="/admin/decide?deviceId=${encodeURIComponent(r.deviceId)}&action=approve&secret=${encodeURIComponent(secret)}">Approve</a>
<a class="btn no" href="/admin/decide?deviceId=${encodeURIComponent(r.deviceId)}&action=revoke&secret=${encodeURIComponent(secret)}">Revoke</a></td></tr>`).join("")}
</table></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 4. One-click Approve / Revoke link (Discord/browser)
    if (request.method === "GET" && url.pathname === "/admin/decide") {
      const secret = url.searchParams.get("secret");
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });

      const deviceId = String(url.searchParams.get("deviceId") || "").trim();
      const action = url.searchParams.get("action");
      if (!deviceId || !["approve", "revoke"].includes(action)) return new Response("Bad request", { status: 400 });

      const record = (await env.DEVICES.get(deviceId, "json")) || { deviceId };
      record.status = action === "approve" ? "approved" : "revoked";
      record.updatedAt = Date.now();
      await env.DEVICES.put(deviceId, JSON.stringify(record));

      return new Response(
        `<h2>${record.status === "approved" ? "✅ Approved" : "🚫 Revoked"}</h2><p>Device: <code>${deviceId}</code></p><p>Name: ${record.name || "(none)"}</p><p><a href="/admin?secret=${encodeURIComponent(secret)}">← Back to Admin Dashboard</a></p>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // 4. Telegram inline button webhook
    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      const update = await request.json().catch(() => ({}));
      const cb = update.callback_query;
      if (cb && String(cb.from?.id) === String(env.TELEGRAM_CHAT_ID)) {
        const [action, deviceId] = String(cb.data || "").split(":");
        if (["approve", "revoke"].includes(action) && deviceId) {
          const record = (await env.DEVICES.get(deviceId, "json")) || { deviceId };
          record.status = action === "approve" ? "approved" : "revoked";
          record.updatedAt = Date.now();
          await env.DEVICES.put(deviceId, JSON.stringify(record));

          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: `${record.status.toUpperCase()}: ${deviceId}` }),
          }).catch(() => {});
        }
      }
      return json({ ok: true });
    }

    return json({ ok: true, service: "overlay-assistant-license" });
  },
};

