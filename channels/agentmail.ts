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
  role: "owner" | "airline";
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

// only plain message.received for our inbox from an owner or the configured airline opens work for the agent
export function classifyEmail(payload: unknown, inbox: string, owners: ReadonlySet<string>, airline?: string): Classified {
  const p = Received.safeParse(payload);
  if (!p.success) return { kind: "ignore", reason: "not a message.received event" };
  const m = p.data.message;
  if (m.inbox_id.toLowerCase() !== inbox.toLowerCase()) return { kind: "ignore", reason: "other inbox" };
  const from = senderAddress(m.from);
  const role = from === null ? null : owners.has(from) ? "owner" : from === airline?.toLowerCase() ? "airline" : null;
  if (from === null || role === null) return { kind: "ignore", reason: "sender is neither the owner nor the airline" };
  return { kind: "accept", email: { eventId: p.data.event_id, role, from, subject: m.subject ?? "", text: m.text ?? "" } };
}

export function maskEmail(address: string): string {
  return address.replace(/^(.)[^@]*@/, "$1***@");
}

// AgentMail API through the Sprites connector: POST /v0/inboxes/{inbox_id}/messages/send
export function agentmailSender(opts: { gateway: string; connectorId: string; inbox: string; fetch: typeof fetch }) {
  const url = `${opts.gateway}/agentmail/${opts.connectorId}/v0/inboxes/${encodeURIComponent(opts.inbox)}/messages/send`;
  return async (to: string, subject: string, text: string): Promise<void> => {
    const res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [to], subject, text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`agentmail send HTTP ${String(res.status)}`);
  };
}
