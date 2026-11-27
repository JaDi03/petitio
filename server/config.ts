import { z } from "zod";

const gatewayId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATA_DIR: z.string().min(1).default("data"),
  SPRITES_GATEWAY: z.url().default("https://api.sprites.dev/v1/gateway"),
  OLLAMA_CONNECTOR_ID: gatewayId,
  OLLAMA_MODEL: z.string().min(1).default("deepseek-v4-pro:0813"),
  TELEGRAM_CONNECTOR_ID: gatewayId,
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  OWNER_CHAT_ID: z.string().regex(/^-?\d{1,20}$/),
  AGENTMAIL_INBOX: z.email(),
  AGENTMAIL_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/),
  OWNER_EMAILS: z.string().transform((s, ctx) => {
    const list = s.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (list.length === 0 || !list.every((e) => z.email().safeParse(e).success)) {
      ctx.addIssue({ code: "custom", message: "comma-separated email list" });
      return z.NEVER;
    }
    return new Set(list);
  }),
  MAX_RUNS_PER_DAY: z.coerce.number().int().min(1).max(1000).default(30),
  // the airline this deployment files claims with; without it the agent only advises
  AGENTMAIL_CONNECTOR_ID: gatewayId.optional(),
  AIRLINE_NAME: z.string().regex(/^[A-Za-z0-9 .&'-]{2,60}$/).optional(),
  AIRLINE_EMAIL: z.email().transform((e) => e.toLowerCase()).optional(),
  AIRLINE_FORM_URL: z.url({ protocol: /^https$/ }).optional(),
}).transform((env, ctx) => {
  const { AGENTMAIL_CONNECTOR_ID: connectorId, AIRLINE_NAME: name, AIRLINE_EMAIL: email, AIRLINE_FORM_URL: formUrl, ...rest } = env;
  const given = [connectorId, name, email, formUrl].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 4) {
    ctx.addIssue({ code: "custom", path: ["AIRLINE_EMAIL"], message: "set all airline settings or none" });
    return z.NEVER;
  }
  // the airline is never the owner nor the agent itself, or its email would count as an order
  if (email !== undefined && (env.OWNER_EMAILS.has(email) || email === env.AGENTMAIL_INBOX.toLowerCase())) {
    ctx.addIssue({ code: "custom", path: ["AIRLINE_EMAIL"], message: "must differ from the owner and the agent inbox" });
    return z.NEVER;
  }
  const airline = connectorId && name && email && formUrl ? { connectorId, name, email, formUrl: new URL(formUrl) } : null;
  return { ...rest, airline };
});

export type Config = z.infer<typeof Env>;
export type AirlineConfig = NonNullable<Config["airline"]>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // names only: values may be secrets
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`invalid or missing settings: ${names}`);
  }
  return parsed.data;
}
