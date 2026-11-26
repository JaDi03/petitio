// Run the agent once on a text file: pnpm agent:try <file>
import { readFileSync } from "node:fs";

import { Ollama } from "ollama";

import { DEFAULT_LIMITS, runAgent } from "./loop.js";
import { openMemory } from "./memory/store.js";
import { computeCompensation } from "./tools/compensation.js";
import { recordFacts } from "./tools/facts.js";
import { getLaw } from "./tools/law.js";
import type { AgentTool } from "./tools/tool.js";
import { getMetar } from "./tools/weather.js";

const file = process.argv[2];
const host = process.env.OLLAMA_HOST;
const model = process.env.OLLAMA_MODEL ?? "deepseek-v4-pro:0813";
const thinkEnv = process.env.OLLAMA_THINK;
const think = thinkEnv === "low" || thinkEnv === "medium" || thinkEnv === "high" ? thinkEnv : undefined;
if (!file || !host) {
  console.error("usage: OLLAMA_HOST=<url> pnpm agent:try <email.txt>");
  process.exit(1);
}

const memory = openMemory(process.env.CASES_DB ?? ":memory:");
const c = memory.createCase({});
const tools = [recordFacts, getMetar, getLaw, computeCompensation] as unknown as AgentTool[];
const result = await runAgent({
  // the request itself is cancelled at the deadline, not just abandoned
  client: new Ollama({
    host,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DEFAULT_LIMITS.modelTimeoutMs) }),
  }),
  model,
  tools,
  event: { kind: "email_in", source: "forwarded by owner", body: readFileSync(file, "utf8") },
  ctx: { caseId: c.id, memory, fetch, now: () => new Date() },
  ...(think ? { think } : {}),
});

for (const d of memory.decisions(c.id)) {
  console.log(`\n> ${d.tool} ${d.allowed ? "" : "(refused) "}${JSON.stringify(d.args)}`);
  console.log(`  why: ${d.reason}`);
  console.log(`  result: ${d.outcome}`);
}
console.log(`\n--- update for the owner (${String(result.modelCalls)} model calls, ${String(result.toolCalls)} tools, ${result.stoppedBy}, tokens in ${String(result.tokens.input)} out ${String(result.tokens.output)}) ---\n${result.update}`);
console.log(`\nfacts: ${JSON.stringify(memory.getCase(c.id)?.facts)}`);
