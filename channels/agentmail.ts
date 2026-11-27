import { Webhook } from "svix";
import { z } from "zod";

// AgentMail signs webhooks with Svix: https://docs.agentmail.to/webhook-verification
export function verifyAgentMail(secret: string, rawBody: string, headers: Record<string, string | undefined>): unknown {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];
  if (!id || !timestamp || !signature) throw new Error("missing signature headers");
  // throws on a bad or stale signature; only a verified body is parsed
  new Webhook(secret).verify(rawBody, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature });
  return JSON.parse(rawBody) as unknown;
}

const Received = z.object({
  event_type: z.literal("message.received"),
  event_id: z.string().min(1).max(200),
  message: z.object({
    inbox_id: z.string().max(320),
    from: z.string().max(500),
    subject: z.string().max(1000).optional(),
    text: z.string().max(200_000).optional(),
  }),
});

export interface InboundEmail {
  eventId: string;
  from: string;
  subject: string;
  text: string;
}

const Address = z.email();

// one mailbox only: "addr", or a plain or quoted display name followed by "<addr>"; any other shape has no sender
const MAILBOX = /^(?:(?:"[^"\\]*"|[^,;:@<>"\\]*)\s*)?<([^<>\s]+)>$/;

export function senderAddress(from: string): string | null {
  const text = from.trim();
  const addr = MAILBOX.exec(text)?.[1] ?? text;
  // validated before case folding, so no Unicode letter can fold into an ASCII address
  return Address.safeParse(addr).success ? addr.toLowerCase() : null;
}

export type Classified =
  | { kind: "accept"; email: InboundEmail }
  | { kind: "ignore"; reason: string };

// only plain message.received for our inbox from an owner address opens work for the agent
export function classifyEmail(payload: unknown, inbox: string, owners: ReadonlySet<string>): Classified {
  const p = Received.safeParse(payload);
  if (!p.success) return { kind: "ignore", reason: "not a message.received event" };
  const m = p.data.message;
  if (m.inbox_id.toLowerCase() !== inbox.toLowerCase()) return { kind: "ignore", reason: "other inbox" };
  const from = senderAddress(m.from);
  if (from === null || !owners.has(from)) return { kind: "ignore", reason: "sender is not the owner" };
  return { kind: "accept", email: { eventId: p.data.event_id, from, subject: m.subject ?? "", text: m.text ?? "" } };
}

export function maskEmail(address: string): string {
  return address.replace(/^(.)[^@]*@/, "$1***@");
}
