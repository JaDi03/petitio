import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

// Telegram Bot API through the Sprites Custom API connector; the bot token never reaches this process.
export interface Telegram {
  send(text: string): Promise<void>;
  typing(): Promise<void>;
}

export function telegramClient(opts: { gateway: string; connectorId: string; chatId: string; fetch: typeof fetch }): Telegram {
  const base = `${opts.gateway}/custom_api/${opts.connectorId}`;
  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await opts.fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: opts.chatId, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram ${method} HTTP ${String(res.status)}`);
  };
  return {
    // plain text only: no parse_mode, so model text can never become markup or links
    send: (text) => call("sendMessage", { text: text.slice(0, 4000), link_preview_options: { is_disabled: true } }),
    typing: () => call("sendChatAction", { action: "typing" }),
  };
}

export function validTelegramSecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const Update = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat: z.object({ id: z.number().int(), type: z.string() }),
      text: z.string().max(4096).optional(),
    })
    .optional(),
});

export interface OwnerMessage {
  updateId: number;
  text: string;
}

// only private messages from the owner's chat are accepted; everything else is dropped
export function ownerMessage(body: unknown, ownerChatId: string): OwnerMessage | null {
  const u = Update.safeParse(body);
  if (!u.success) return null;
  const m = u.data.message;
  if (!m?.text || m.chat.type !== "private" || String(m.chat.id) !== ownerChatId) return null;
  return { updateId: u.data.update_id, text: m.text };
}
