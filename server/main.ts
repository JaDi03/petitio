import { createServer } from "node:http";
import { join } from "node:path";

import { Ollama } from "ollama";

import { DEFAULT_LIMITS } from "../agent/loop.js";
import { openMemory } from "../agent/memory/store.js";
import { pauseSwitch } from "../agent/pause.js";
import { createRunner } from "../agent/runner.js";
import { telegramClient } from "../channels/telegram.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { withHold } from "./hold.js";

const config = loadConfig();
const log = (line: string) => { console.log(`${new Date().toISOString().slice(11, 19)} ${line}`); };

const memory = openMemory(join(config.DATA_DIR, "cases.db"));
const telegram = telegramClient({
  gateway: config.SPRITES_GATEWAY,
  connectorId: config.TELEGRAM_CONNECTOR_ID,
  chatId: config.OWNER_CHAT_ID,
  fetch,
});
const client = new Ollama({
  host: `${config.SPRITES_GATEWAY}/ollama/${config.OLLAMA_CONNECTOR_ID}`,
  // the request itself is cancelled at the deadline, not just abandoned
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DEFAULT_LIMITS.modelTimeoutMs) }),
});
const runner = createRunner({
  memory,
  client,
  model: config.OLLAMA_MODEL,
  notify: telegram,
  log,
  hold: withHold,
  fetch,
  maxRunsPerDay: config.MAX_RUNS_PER_DAY,
});

const handle = createApp({
  memory,
  inbox: config.AGENTMAIL_INBOX,
  owners: config.OWNER_EMAILS,
  ...(config.airline ? { airlineEmail: config.airline.email } : {}),
  ownerChatId: config.OWNER_CHAT_ID,
  agentmailSecret: config.AGENTMAIL_WEBHOOK_SECRET,
  telegramSecret: config.TELEGRAM_WEBHOOK_SECRET,
  enqueue: (caseId, event, ack) => runner.enqueue(caseId, event, ack),
  reply: (text) => telegram.send(text),
  log,
  pause: pauseSwitch(config.DATA_DIR),
});

createServer((req, res) => { void handle(req, res); }).listen(config.PORT, () => {
  log(`🟢 Petitio listening on :${String(config.PORT)} (model ${config.OLLAMA_MODEL})`);
});
