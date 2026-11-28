# Overlay Assistant — Device Approval Server

Locks each `.exe` installation to its Windows hardware `Device ID`. Even if someone copies the `.exe` or `%APPDATA%` to another computer, it will remain locked until you approve the new device.

## Setup (5 minutes, free Cloudflare tier)

1. **Generate signing keys**:
   ```powershell
   node scripts/keygen.js
   ```
   - Paste the printed `PUBLIC_KEY` into `DEFAULT_PUBLIC_KEY` in `src/license.js`.

2. **Create a Cloudflare KV namespace & deploy**:
   ```powershell
   cd license-server
   npx wrangler login
   npx wrangler kv namespace create DEVICES
   ```
   - Copy the `id` into `license-server/wrangler.toml`.
   - Set your secrets:
     ```powershell
     npx wrangler secret put LICENSE_PRIVATE_KEY
     npx wrangler secret put ADMIN_SECRET
     ```
   - Add at least one notification channel so you get asked when someone opens the app:
     - **Discord** (fastest): `npx wrangler secret put DISCORD_WEBHOOK_URL`
     - **Telegram**: `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_CHAT_ID` (and optionally set webhook to `https://<worker-url>/telegram-webhook` for one-tap inline buttons).
   - Deploy:
     ```powershell
     npx wrangler deploy
     ```

3. **Connect the desktop app**:
   - Paste your deployed `https://overlay-assistant-license.<subdomain>.workers.dev` URL into `DEFAULT_LICENSE_URL` in `src/license.js`.
   - Rebuild/release with `npm run dist` or `npm run release`.

