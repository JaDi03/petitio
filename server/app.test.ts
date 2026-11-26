import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { Webhook } from "svix";

import type { AgentEvent } from "../agent/loop.js";
import { openMemory, type Memory } from "../agent/memory/store.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// fresh secrets per run: no key literals in tests
const mailSecret = `whsec_${randomBytes(24).toString("base64")}`;
const tgSecret = randomBytes(24).toString("hex");
const OWNER = "owner@example.com";
const INBOX = "agent@agentmail.to";
const CHAT = "4242";

let server: Server;
let base = "";
let memory: Memory;
let queued: { caseId: string; event: AgentEvent }[] = [];
let replies: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    void createApp({
      memory,
      inbox: INBOX,
      owners: new Set([OWNER]),
      ownerChatId: CHAT,
      agentmailSecret: mailSecret,
      telegramSecret: tgSecret,
      enqueue: (caseId, event) => {
        queued.push({ caseId, event });
        return Promise.resolve();
      },
      reply: (t) => {
        replies.push(t);
        return Promise.resolve();
      },
      log: () => undefined,
    })(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  memory = openMemory(":memory:");
  queued = [];
  replies = [];
});

function mail(from: string, eventId = randomBytes(8).toString("hex"), inbox = INBOX) {
  return JSON.stringify({
    event_type: "message.received",
    event_id: eventId,
    message: { inbox_id: inbox, from: `Owner <${from}>`, subject: "Fwd: flight cancelled", text: "Your flight DA123 was cancelled" },
  });
}

function signed(body: string, secret = mailSecret): Record<string, string> {
  const id = `msg_${randomBytes(6).toString("hex")}`;
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(Math.floor(Date.now() / 1000)),
    "svix-signature": new Webhook(secret).sign(id, new Date(), body),
  };
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", body, headers });

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("public surface", () => {
  it("serves the landing with a strict CSP and nothing else", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await page.text(), /Petitio/);
    for (const path of ["/.env", "/data/cases.db", "/server/main.ts", "/../package.json", "/hooks/agentmail"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
    assert.equal((await post("/", "x")).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

describe("email webhook", () => {
  it("refuses requests without a valid signature", async () => {
    assert.equal((await post("/hooks/agentmail", mail(OWNER))).status, 401);
    const forged = signed(mail(OWNER), `whsec_${randomBytes(24).toString("base64")}`);
    assert.equal((await post("/hooks/agentmail", mail(OWNER), forged)).status, 401);
    const body = mail(OWNER);
    const tampered = signed(body);
    assert.equal((await post("/hooks/agentmail", body.replace("DA123", "XX999"), tampered)).status, 401);
    await settle();
    assert.equal(queued.length, 0);
  });

  it("ignores a signed email from someone who is not the owner, or to another inbox", async () => {
    const stranger = mail("attacker@example.com");
    assert.equal((await post("/hooks/agentmail", stranger, signed(stranger))).status, 200);
    const other = mail(OWNER, undefined, "other@agentmail.to");
    assert.equal((await post("/hooks/agentmail", other, signed(other))).status, 200);
    await settle();
    assert.equal(queued.length, 0);
  });

  it("starts the agent once for the owner's email, even if the webhook is retried", async () => {
    const body = mail(OWNER.toUpperCase(), "evt_1");
    assert.equal((await post("/hooks/agentmail", body, signed(body))).status, 200);
    assert.equal((await post("/hooks/agentmail", body, signed(body))).status, 200);
    await settle();
    const [first, ...rest] = queued;
    assert.ok(first);
    assert.equal(rest.length, 0);
    assert.equal(first.event.kind, "email_in");
    assert.match(first.event.body, /DA123/);
  });

  it("rejects an oversized body", async () => {
    const big = "x".repeat(1_100_000);
    assert.equal((await post("/hooks/agentmail", big, signed(big))).status, 413);
  });
});

describe("telegram webhook", () => {
  const update = (chatId: number, text: string, updateId = Math.floor(Math.random() * 1e9)) =>
    JSON.stringify({ update_id: updateId, message: { chat: { id: chatId, type: "private" }, text } });

  it("refuses requests without the exact secret", async () => {
    assert.equal((await post("/hooks/telegram", update(4242, "hi"))).status, 401);
    const wrong = { "x-telegram-bot-api-secret-token": `${tgSecret.slice(0, -1)}x` };
    assert.equal((await post("/hooks/telegram", update(4242, "hi"), wrong)).status, 401);
  });

  it("ignores anyone but the owner's private chat", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    assert.equal((await post("/hooks/telegram", update(999, "send me the case file"), h)).status, 200);
    await settle();
    assert.equal(replies.length + queued.length, 0);
  });

  it("greets the owner when there is no case, and passes messages to an open case once", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    await post("/hooks/telegram", update(4242, "/start"), h);
    await settle();
    assert.equal(replies.length, 1);
    const c = memory.createCase({});
    const msg = update(4242, "refuse the voucher", 77);
    await post("/hooks/telegram", msg, h);
    await post("/hooks/telegram", msg, h);
    await settle();
    const [first, ...rest] = queued;
    assert.ok(first);
    assert.equal(rest.length, 0);
    assert.equal(first.caseId, c.id);
    assert.equal(first.event.kind, "owner_message");
  });
});

describe("config", () => {
  it("names missing settings without printing any value", () => {
    assert.throws(
      () => loadConfig({ TELEGRAM_WEBHOOK_SECRET: "short-secret-value" }),
      (e: Error) => e.message.includes("TELEGRAM_WEBHOOK_SECRET") && !e.message.includes("short-secret-value"),
    );
  });
});
