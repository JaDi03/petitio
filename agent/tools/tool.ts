import { z } from "zod";

import type { Memory } from "../memory/store.js";

export interface ToolContext {
  caseId: string;
  memory: Memory;
  fetch: typeof fetch;
  now: () => Date;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

// the model sees the schema; long date regexes add tokens without helping it
function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$schema") continue;
    if (k === "pattern" && obj.format === "date-time") continue;
    out[k] = compact(v);
  }
  return out;
}

export function toModelTool(tool: AgentTool) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: compact(z.toJSONSchema(tool.schema)) as Record<string, unknown>,
    },
  };
}

export type ToolCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

// a name the model chose is only stored or echoed in this shape
export function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unnamed";
}

const MAX_LOGGED_ARGS = 2000;

function loggable(args: unknown): unknown {
  const json = JSON.stringify(args ?? null);
  return json.length <= MAX_LOGGED_ARGS ? args : { truncated: json.slice(0, MAX_LOGGED_ARGS) };
}

// code decides: arguments are validated before any tool runs, and every call is logged
export async function callTool(
  tools: readonly AgentTool[],
  name: string,
  rawArgs: unknown,
  reason: string,
  ctx: ToolContext,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const shown = safeToolName(name);
    ctx.memory.logDecision(ctx.caseId, { tool: shown, reason, args: loggable(rawArgs), allowed: false, outcome: "unknown tool" });
    return { ok: false, error: `unknown tool: ${shown}` };
  }
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500);
    ctx.memory.logDecision(ctx.caseId, { tool: name, reason, args: loggable(rawArgs), allowed: false, outcome: `invalid arguments: ${error}` });
    return { ok: false, error: `invalid arguments: ${error}` };
  }
  try {
    const value = await tool.run(parsed.data, ctx);
    ctx.memory.logDecision(ctx.caseId, { tool: name, reason, args: parsed.data, allowed: true, outcome: "ok" });
    return { ok: true, value };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    ctx.memory.logDecision(ctx.caseId, { tool: name, reason, args: parsed.data, allowed: true, outcome: `failed: ${error}` });
    return { ok: false, error };
  }
}
