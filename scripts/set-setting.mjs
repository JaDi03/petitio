// Set one value in ~/petitio-data/.env from standard input, so secrets never go through a command line.
// Usage on the Sprite: node scripts/set-setting.mjs AGENTMAIL_WEBHOOK_SECRET   (then paste the value and press Enter)
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ALLOWED = {
  AGENTMAIL_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9+/=]{16,}$/,
  OWNER_EMAILS: /^[^\s,]+@[^\s,]+(,[^\s,]+@[^\s,]+)*$/,
  OWNER_CHAT_ID: /^-?\d{1,20}$/,
  AGENTMAIL_CONNECTOR_ID: /^[A-Za-z0-9_-]{8,64}$/,
  AIRLINE_NAME: /^[A-Za-z0-9 .&'-]{2,60}$/,
  AIRLINE_EMAIL: /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/,
  AIRLINE_FORM_URL: /^https:\/\/[^\s]+$/,
};

const name = process.argv[2];
if (!name || !(name in ALLOWED)) {
  console.error(`usage: node scripts/set-setting.mjs <${Object.keys(ALLOWED).join("|")}>`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
const value = await new Promise((resolve) => {
  rl.once("line", (line) => {
    rl.close();
    resolve(line.trim());
  });
});
if (!ALLOWED[name].test(value)) {
  console.error(`${name}: value has the wrong format, nothing changed`);
  process.exit(1);
}

const file = join(process.env.DATA_DIR ?? join(homedir(), "petitio-data"), ".env");
const lines = readFileSync(file, "utf8").split("\n").filter((l) => !l.startsWith(`${name}=`));
const out = [...lines.filter((l, i) => l !== "" || i < lines.length - 1), `${name}=${value}`, ""].join("\n");
writeFileSync(`${file}.tmp`, out, { mode: 0o600 });
renameSync(`${file}.tmp`, file);
chmodSync(file, 0o600);
console.log(`${name} saved (${String(value.length)} characters)`);
