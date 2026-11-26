import type { ChatRequest, ChatResponse, Message } from "ollama";

import type { Memory } from "./memory/store.js";
import { SYSTEM_PROMPT, neutralize, untrusted } from "./prompt.js";
import { callTool, safeToolName, toModelTool, type AgentTool, type ToolContext } from "./tools/tool.js";

export interface ChatClient {
  chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;
}

export interface AgentEvent {
  kind: "email_in" | "owner_message" | "call_transcript" | "tick";
  source: string;
  body: string;
}

export interface Limits {
  maxModelCalls: number;
  maxToolCalls: number;
  maxTokens: number;
  modelTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = { maxModelCalls: 12, maxToolCalls: 20, maxTokens: 60_000, modelTimeoutMs: 30_000 };

const MAX_TOOL_RESULT_CHARS = 12_000;

export interface RunResult {
  update: string;
  modelCalls: number;
  toolCalls: number;
  stoppedBy: "done" | "model_limit" | "tool_limit" | "token_limit";
  tokens: { input: number; output: number };
}

// the case file was built from outside text, so it goes to the model as data, never as instructions
function caseContext(memory: Memory, caseId: string): string {
  const c = memory.getCase(caseId);
  const timeline = memory.timeline(caseId).slice(-20).map((e) => `${e.at} ${e.kind}: ${e.summary}`).join("\n");
  const body = `Status: ${c?.status ?? "unknown"}\nKnown facts: ${JSON.stringify(c?.facts ?? {})}\nTimeline:\n${timeline || "(empty)"}`;
  return untrusted("case-file", body, 12_000);
}

function toolMessage(result: unknown): string {
  const json = JSON.stringify(result);
  const body = json.length <= MAX_TOOL_RESULT_CHARS ? json : JSON.stringify({ truncated: true, partial: json.slice(0, MAX_TOOL_RESULT_CHARS) });
  return neutralize(body);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error("model timeout")); }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runAgent(opts: {
  client: ChatClient;
  model: string;
  tools: readonly AgentTool[];
  event: AgentEvent;
  ctx: ToolContext;
  limits?: Limits;
  think?: ChatRequest["think"];
}): Promise<RunResult> {
  const { client, model, tools, event, ctx } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const { memory, caseId } = ctx;
  memory.addEvent(caseId, event.kind, "New input received");

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Case file:\n${caseContext(memory, caseId)}\n\nNew event (${event.kind}):\n${untrusted(event.source, event.body)}` },
  ];
  const modelTools = tools.map(toModelTool);
  let modelCalls = 0;
  let toolCalls = 0;
  const tokens = { input: 0, output: 0 };
  const stop = (stoppedBy: RunResult["stoppedBy"], update: string): RunResult => {
    memory.addEvent(caseId, "limit", update);
    return { update, modelCalls, toolCalls, stoppedBy, tokens };
  };

  while (modelCalls < limits.maxModelCalls) {
    if (tokens.input + tokens.output >= limits.maxTokens) return stop("token_limit", "I stopped because this run reached its token budget.");
    modelCalls++;
    let res: ChatResponse;
    try {
      res = await withTimeout(
        client.chat({ model, messages, tools: modelTools, stream: false, ...(opts.think === undefined ? {} : { think: opts.think }) }),
        limits.modelTimeoutMs,
      );
    } catch (e) {
      memory.addEvent(caseId, "error", `Model call failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
      throw e;
    }
    tokens.input += Number.isFinite(res.prompt_eval_count) ? res.prompt_eval_count : 0;
    tokens.output += Number.isFinite(res.eval_count) ? res.eval_count : 0;
    const msg = res.message;
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const update = msg.content.trim() || "I looked at this but have nothing new to report yet.";
      memory.addEvent(caseId, "agent_update", update.slice(0, 500));
      return { update, modelCalls, toolCalls, stoppedBy: "done", tokens };
    }
    // the model's visible reasoning is recorded as the reason; it explains, it does not authorize
    const thinking = msg.thinking?.trim() ?? "";
    const reason = (thinking || msg.content.trim()).slice(0, 400) || "(no reason given)";
    for (const call of calls) {
      if (toolCalls >= limits.maxToolCalls) return stop("tool_limit", "I stopped because this run reached its tool call limit.");
      toolCalls++;
      const name = safeToolName(call.function.name);
      const result = await callTool(tools, call.function.name, call.function.arguments, reason, ctx);
      memory.addEvent(caseId, "tool", `${name}: ${result.ok ? "ok" : `refused (${result.error.slice(0, 200)})`}`);
      messages.push({ role: "tool", tool_name: name, content: toolMessage(result) });
    }
  }
  return stop("model_limit", "I stopped because this run reached its model call limit.");
}
