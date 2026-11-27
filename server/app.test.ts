import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { Webhook } from "svix";

import type { AgentEvent } from "../agent/loop.js";
import { openMemory, type Memory } from "../agent/memory/store.js";
import { memoryPause, type PauseSwitch } from "../agent/pause.js";
import type { Actions, FileClaim } from "../agent/actions.js";
import { claimState, submitClaimForm } from "../agent/tools/claim.js";
import { computeCompensation } from "../agent/tools/compensation.js";
import { proposeEmail } from "../agent/tools/propose.js";
import { callTool, type AgentTool, type ToolContext } from "../agent/tools/tool.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// fresh secrets per run: no key literals in tests
const mailSecret = `whsec_${randomBytes(24).toString("base64")}`;
const tgSecret = randomBytes(24).toString("hex");
const OWNER = "owner@example.com";
const INBOX = "agent@agentmail.to";
const CHAT = "4242";
const AIRLINE = "claims@airline.example";

const CLAIM_FACTS = {
  passengerName: "Alex Doe",
  bookingRef: "AB12CD",
  flightNumber: "DA456",
  airline: "Demo Air",
  from: "FRA",
  to: "LIS",
  scheduledDeparture: "2026-11-24T06:30:00Z",
  scheduledArrival: "2026-11-24T09:30:00Z",
  noticeAt: "2026-11-24T04:00:00Z",
};
const CLAIM_TOOLS = [computeCompensation, submitClaimForm, proposeEmail] as unknown as AgentTool[];

// the tools' view of the case in the same memory the webhook uses
function claimContext(caseId: string, fileClaim?: FileClaim): ToolContext {
  const actions: Actions = {
    airline: { name: "Demo Air", email: AIRLINE, formUrl: new URL("https://airline.example/claims") },
    agentInbox: INBOX,
    paused: () => pause.paused(),
    fileClaim: fileClaim ?? (() => Promise.reject(new Error("not used"))),
    tellOwner: () => Promise.resolve(),
    askOwner: () => Promise.resolve(),
    sendEmail: () => Promise.resolve(),
  };
  return { caseId, memory, fetch: () => Promise.reject(new Error("network not allowed in tests")), now: () => new Date("2026-11-26T12:00:00Z"), actions };
}

let server: Server;
let base = "";
let memory: Memory;
let queued: { caseId: string; event: AgentEvent }[] = [];
let replies: string[] = [];
let pause: PauseSwitch = memoryPause();
let decided: { id: string; yes: boolean }[] = [];
let answered: string[] = [];
let cleared = 0;

before(async () => {
  server = createServer((req, res) => {
    void createApp({
      memory,
      inbox: INBOX,
      owners: new Set([OWNER]),
      airlineEmail: AIRLINE,
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
      pause,
      decide: (id, yes) => {
        decided.push({ id, yes });
        return Promise.resolve("Sent to Demo Air.");
      },
      taps: {
        answer: (_id, text) => {
          answered.push(text);
          return Promise.resolve();
        },
        clear: () => {
          cleared += 1;
          return Promise.resolve();
        },
      },
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
  pause = memoryPause();
  decided = [];
  answered = [];
  cleared = 0;
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

  it("passes the airline's email to the open case, and never opens a case for it", async () => {
    const first = mail("Claims@Airline.example");
    assert.equal((await post("/hooks/agentmail", first, signed(first))).status, 200);
    await settle();
    assert.equal(queued.length, 0);
    assert.equal(memory.latestOpenCase(), undefined);
    const c = memory.createCase({});
    const reply = mail(AIRLINE);
    await post("/hooks/agentmail", reply, signed(reply));
    await settle();
    const [only, ...more] = queued;
    assert.ok(only);
    assert.equal(more.length, 0);
    assert.equal(only.caseId, c.id);
    assert.equal(only.event.kind, "airline_email");
    assert.ok(memory.timeline(c.id).some((e) => e.kind === "airline_email"));
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

  const tap = (fromId: number, data: string, updateId = Math.floor(Math.random() * 1e9), chatId = fromId) =>
    JSON.stringify({
      update_id: updateId,
      callback_query: { id: "cb1", from: { id: fromId }, message: { message_id: 9, chat: { id: chatId, type: "private" } }, data },
    });

  it("runs an approval only for the owner's own tap, once, and never from a forged button", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    await post("/hooks/telegram", tap(999, "ap:abcdefghijkl:y"), h);
    await post("/hooks/telegram", tap(999, "ap:abcdefghijkl:y", undefined, 4242), h);
    await settle();
    assert.equal(decided.length, 0);

    const once = tap(4242, "ap:abcdefghijkl:y", 555);
    await post("/hooks/telegram", once, h);
    await post("/hooks/telegram", once, h);
    await settle();
    assert.deepEqual(decided, [{ id: "abcdefghijkl", yes: true }]);
    assert.deepEqual(answered, ["Sent to Demo Air."]);

    await post("/hooks/telegram", tap(4242, "ap:../../etc:y"), h);
    await post("/hooks/telegram", tap(4242, "ap:abcdefghijkl:yes"), h);
    await settle();
    assert.equal(decided.length, 1);
    assert.equal(queued.length, 0);
  });

  it("keeps the buttons while the request still waits, and removes them once it is handled", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    const c = memory.createCase({});
    const a = memory.createApproval({ caseId: c.id, kind: "follow_up", to: AIRLINE, subject: "s", body: "b", amountEur: 400, expiresAt: "2099-01-01T00:00:00Z" });
    // a tap during a pause leaves the request pending
    await post("/hooks/telegram", tap(4242, `ap:${a.id}:y`), h);
    await settle();
    assert.equal(cleared, 0);
    memory.takeApproval(a.id, "sent");
    await post("/hooks/telegram", tap(4242, `ap:${a.id}:y`), h);
    await settle();
    assert.equal(cleared, 1);
  });

  it("files again on /refile only after an unknown result, never while sending or paused, and only once", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await settle();
    assert.deepEqual(replies, ["There is no open claim."]);

    const c = memory.createCase({ ...CLAIM_FACTS });
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await settle();
    assert.equal(replies.at(-1), "There is no claim waiting for an answer.");

    memory.addEvent(c.id, "claim_attempt", "sending the form");
    await post("/hooks/telegram", update(999, "/refile"), h);
    await settle();
    assert.equal(claimState(memory, c.id), "unknown");

    pause.set(true);
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await settle();
    assert.match(replies.at(-1) ?? "", /paused/);
    assert.equal(claimState(memory, c.id), "unknown");
    assert.equal(queued.length, 0);

    pause.set(false);
    await post("/hooks/telegram", update(4242, " /REFILE "), h);
    await settle();
    assert.equal(claimState(memory, c.id), "none");
    assert.equal(queued.length, 1);
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await settle();
    assert.equal(queued.length, 1);

    memory.updateFacts(c.id, { claimRef: "DA-141262" });
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await settle();
    assert.match(replies.at(-1) ?? "", /already filed.*DA-141262/);
    assert.equal(queued.length, 1);
  });

  it("refuses /refile and /filed while the form is being sent", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    const c = memory.createCase({ ...CLAIM_FACTS });
    const ctx = claimContext(c.id, (_u, _f, hooks) => {
      hooks.beforeSend();
      return new Promise(() => undefined);
    });
    await callTool(CLAIM_TOOLS, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    void callTool(CLAIM_TOOLS, "submit_claim_form", {}, "x", ctx);
    await settle();
    assert.equal(claimState(memory, c.id), "sending");
    await post("/hooks/telegram", update(4242, "/refile"), h);
    await post("/hooks/telegram", update(4242, "/filed DA-141262"), h);
    await settle();
    assert.deepEqual(replies.slice(-2), ["I'm sending the claim form right now. Wait for my message.", "I'm sending the claim form right now. Wait for my message."]);
    assert.equal(memory.getCase(c.id)?.facts.claimRef, undefined);
    assert.equal(queued.length, 0);
  });

  it("records the airline's case number from /filed only for the owner, only after an unknown result, in the right format", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    const c = memory.createCase({ ...CLAIM_FACTS });
    await post("/hooks/telegram", update(4242, "/filed DA-141262"), h);
    await settle();
    assert.equal(replies.at(-1), "There is no claim waiting for an answer.");
    memory.addEvent(c.id, "claim_attempt", "sending the form");
    memory.addEvent(c.id, "claim_unconfirmed", "no case number");

    for (const bad of ["/filed", "/filed DA‐141262", "/filed DA-141262.", "/filed DA 141262", "/filed <b>DA1</b>"]) {
      await post("/hooks/telegram", update(4242, bad), h);
      await settle();
      assert.match(replies.at(-1) ?? "", /for example \/filed/, bad);
    }
    await post("/hooks/telegram", update(999, "/filed DA-141262"), h);
    await settle();
    assert.equal(memory.getCase(c.id)?.facts.claimRef, undefined);

    await post("/hooks/telegram", update(4242, " /FILED  da-141262 "), h);
    await settle();
    assert.equal(memory.getCase(c.id)?.facts.claimRef, "DA-141262");
    assert.equal(memory.getCase(c.id)?.status, "waiting");
    assert.equal(claimState(memory, c.id), "filed");
    assert.match(replies.at(-1) ?? "", /DA-141262/);
    assert.equal(queued.length, 0);

    // the case can be followed up now, and the number cannot be changed
    const ctx = claimContext(c.id);
    await callTool(CLAIM_TOOLS, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    assert.ok((await callTool(CLAIM_TOOLS, "propose_email", { kind: "follow_up" }, "x", ctx)).ok);
    await post("/hooks/telegram", update(4242, "/filed DA-999999"), h);
    await settle();
    assert.equal(memory.getCase(c.id)?.facts.claimRef, "DA-141262");
  });

  it("shows the owner the airline's answer as sent when a claim's result is unknown, and only then", async () => {
    const c = memory.createCase({ ...CLAIM_FACTS });
    const quiet = mail(AIRLINE);
    await post("/hooks/agentmail", quiet, signed(quiet));
    await settle();
    assert.equal(replies.length, 0);

    memory.addEvent(c.id, "claim_attempt", "sending the form");
    const answer = mail(AIRLINE);
    await post("/hooks/agentmail", answer, signed(answer));
    await settle();
    const shown = replies.at(-1) ?? "";
    assert.match(shown, /The airline wrote: "Fwd: flight cancelled"/);
    assert.match(shown, /Your flight DA123 was cancelled/);
    assert.match(shown, /\/filed/);
    assert.equal(queued.length, 2);
    assert.equal(claimState(memory, c.id), "unknown");
  });

  it("pauses and resumes actions only for the owner, without the model", async () => {
    const h = { "x-telegram-bot-api-secret-token": tgSecret };
    memory.createCase({});
    await post("/hooks/telegram", update(999, "/pause"), h);
    await settle();
    assert.equal(pause.paused(), false);
    await post("/hooks/telegram", update(4242, " /PAUSE "), h);
    await settle();
    assert.equal(pause.paused(), true);
    await post("/hooks/telegram", update(4242, "/resume"), h);
    await settle();
    assert.equal(pause.paused(), false);
    assert.equal(queued.length, 0);
    assert.equal(replies.length, 2);
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
  const env = {
    OLLAMA_CONNECTOR_ID: "ollama-conn-1",
    TELEGRAM_CONNECTOR_ID: "telegram-conn-1",
    TELEGRAM_WEBHOOK_SECRET: tgSecret,
    OWNER_CHAT_ID: CHAT,
    AGENTMAIL_INBOX: INBOX,
    AGENTMAIL_WEBHOOK_SECRET: mailSecret,
    OWNER_EMAILS: OWNER,
  };
  const airline = {
    AGENTMAIL_CONNECTOR_ID: "agentmail-conn-1",
    AIRLINE_NAME: "Demo Air",
    AIRLINE_EMAIL: "Claims@Airline.example",
    AIRLINE_FORM_URL: "https://airline.example/claims",
  };

  it("runs without an airline, and needs all airline settings together", () => {
    assert.equal(loadConfig(env).airline, null);
    const full = loadConfig({ ...env, ...airline }).airline;
    assert.ok(full);
    assert.equal(full.email, "claims@airline.example");
    assert.equal(full.formUrl.host, "airline.example");
    assert.throws(() => loadConfig({ ...env, AIRLINE_EMAIL: airline.AIRLINE_EMAIL }), /AIRLINE_EMAIL/);
  });

  it("refuses an airline that is the owner or the agent, or a form without https", () => {
    for (const AIRLINE_EMAIL of [OWNER.toUpperCase(), INBOX]) {
      assert.throws(() => loadConfig({ ...env, ...airline, AIRLINE_EMAIL }), /AIRLINE_EMAIL/, AIRLINE_EMAIL);
    }
    assert.throws(() => loadConfig({ ...env, ...airline, AIRLINE_FORM_URL: "http://airline.example/claims" }), /AIRLINE_FORM_URL/);
  });
});
