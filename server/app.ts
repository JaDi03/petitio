import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Memory } from "../agent/memory/store.js";
import type { AgentEvent } from "../agent/loop.js";
import type { PauseSwitch } from "../agent/pause.js";
import { classifyEmail, maskEmail, verifyAgentMail } from "../channels/agentmail.js";
import { ownerMessage, validTelegramSecret } from "../channels/telegram.js";

const MAX_BODY = 1_000_000;

const LANDING = {
  "/": { file: new URL("./landing/index.html", import.meta.url), type: "text/html; charset=utf-8" },
  "/landing.css": { file: new URL("./landing/landing.css", import.meta.url), type: "text/css; charset=utf-8" },
} as const;

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface AppDeps {
  memory: Memory;
  inbox: string;
  owners: ReadonlySet<string>;
  airlineEmail?: string;
  ownerChatId: string;
  agentmailSecret: string;
  telegramSecret: string;
  enqueue: (caseId: string, event: AgentEvent, ack: string) => Promise<void>;
  reply: (text: string) => Promise<void>;
  log: (line: string) => void;
  pause: PauseSwitch;
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) {
      reject(new TooLarge());
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new TooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function end(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  res.end(body);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createApp(deps: AppDeps) {
  const pages = new Map(
    Object.entries(LANDING).map(([path, p]) => [path, { body: readFileSync(p.file), type: p.type }]),
  );

  async function agentmail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = verifyAgentMail(deps.agentmailSecret, raw, {
        "svix-id": header(req, "svix-id"),
        "svix-timestamp": header(req, "svix-timestamp"),
        "svix-signature": header(req, "svix-signature"),
      });
    } catch {
      deps.log("🚫 email webhook with an invalid signature refused");
      end(res, 401);
      return;
    }
    const c = classifyEmail(payload, deps.inbox, deps.owners, deps.airlineEmail);
    if (c.kind === "ignore") {
      deps.log(`📭 email ignored: ${c.reason}`);
      end(res, 200, "{}");
      return;
    }
    if (!deps.memory.firstSeen(`agentmail:${c.email.eventId}`)) {
      end(res, 200, "{}");
      return;
    }
    end(res, 200, "{}");
    const existing = deps.memory.latestOpenCase();
    const body = `Subject: ${c.email.subject}\n\n${c.email.text}`;
    if (c.email.role === "airline") {
      // the airline answers a claim; it never opens one
      if (!existing) {
        deps.log("📭 airline email ignored: no open case");
        return;
      }
      deps.log(`🛫 airline email: "${c.email.subject.slice(0, 80)}"`);
      deps.memory.addEvent(existing.id, "airline_email", c.email.subject.replace(/\s+/g, " ").slice(0, 200));
      void deps.enqueue(existing.id, { kind: "airline_email", source: "email from the airline", body }, "The airline wrote back. I'm reading it now.");
      return;
    }
    const caseId = existing?.id ?? deps.memory.createCase({}).id;
    deps.log(`📩 email from ${maskEmail(c.email.from)}: "${c.email.subject.slice(0, 80)}"`);
    void deps.enqueue(caseId, { kind: "email_in", source: "email forwarded by owner", body }, "Got it, I'm looking into this now.");
  }

  async function telegram(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validTelegramSecret(header(req, "x-telegram-bot-api-secret-token"), deps.telegramSecret)) {
      deps.log("🚫 telegram webhook without the secret refused");
      end(res, 401);
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      end(res, 200, "{}");
      return;
    }
    const msg = ownerMessage(body, deps.ownerChatId);
    end(res, 200, "{}");
    if (!msg) {
      deps.log("📭 telegram update ignored: not from the owner's private chat");
      return;
    }
    if (!deps.memory.firstSeen(`telegram:${String(msg.updateId)}`)) return;
    deps.log(`💬 owner on telegram: "${msg.text.slice(0, 80)}"`);
    const command = msg.text.trim().toLowerCase();
    if (command === "/pause" || command === "/resume") {
      deps.pause.set(command === "/pause");
      deps.log(command === "/pause" ? "⏸️  actions paused by the owner" : "▶️  actions resumed by the owner");
      await deps.reply(command === "/pause"
        ? "Paused. I won't fill forms or send anything to the airline until you send /resume."
        : "Resumed. I can act on your claims again.");
      return;
    }
    const open = deps.memory.latestOpenCase();
    if (command === "/start" || !open) {
      await deps.reply("Hi, I'm Petitio. Forward me the airline's email about your cancelled flight and I'll follow it up until they pay.");
      return;
    }
    void deps.enqueue(open.id, { kind: "owner_message", source: "owner on telegram", body: msg.text }, "On it.");
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      if (req.method === "GET" && path === "/health") {
        end(res, 200, JSON.stringify({ status: "ok" }));
        return;
      }
      const page = req.method === "GET" ? pages.get(path) : undefined;
      if (page) {
        res.writeHead(200, { "content-type": page.type, "cache-control": "public, max-age=300", ...PAGE_HEADERS });
        res.end(page.body);
        return;
      }
      if (req.method === "POST" && path === "/hooks/agentmail") {
        await agentmail(req, res);
        return;
      }
      if (req.method === "POST" && path === "/hooks/telegram") {
        await telegram(req, res);
        return;
      }
      end(res, 404);
    } catch (e) {
      if (!res.headersSent) end(res, e instanceof TooLarge ? 413 : 500);
      if (!(e instanceof TooLarge)) deps.log(`❌ request failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    }
  };
}
