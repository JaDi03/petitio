// Register this Sprite's /hooks/telegram with Telegram through the Custom API connector.
// Run on the Sprite: node --env-file=$HOME/petitio-data/.env scripts/telegram-webhook.mjs
const gateway = process.env.SPRITES_GATEWAY ?? "https://api.sprites.dev/v1/gateway";
const { TELEGRAM_CONNECTOR_ID: id, TELEGRAM_WEBHOOK_SECRET: secret, PUBLIC_URL: url } = process.env;
if (!id || !secret || !url) {
  console.error("TELEGRAM_CONNECTOR_ID, TELEGRAM_WEBHOOK_SECRET and PUBLIC_URL are required");
  process.exit(1);
}

const res = await fetch(`${gateway}/custom_api/${id}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${url.replace(/\/$/, "")}/hooks/telegram`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const body = await res.json();
console.log(res.ok && body.ok ? "telegram webhook set" : `telegram webhook failed: HTTP ${res.status} ${body.description ?? ""}`);
process.exit(res.ok && body.ok ? 0 : 1);
