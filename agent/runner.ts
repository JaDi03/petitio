import { afterTool } from "./narrate.js";
import { runAgent, type AgentEvent, type ChatClient, type Limits } from "./loop.js";
import type { Memory } from "./memory/store.js";
import { computeCompensation } from "./tools/compensation.js";
import { recordFacts } from "./tools/facts.js";
import { getLaw } from "./tools/law.js";
import type { AgentTool } from "./tools/tool.js";
import { getMetar } from "./tools/weather.js";

// the owner reads the update on a phone; the full text stays in the log
export const MAX_UPDATE_CHARS = 700;

// the last paragraph holds the question to the owner, so a long update loses its middle, never its end
export function clipUpdate(text: string): string {
  if (text.length <= MAX_UPDATE_CHARS) return text;
  const parts = text.trimEnd().split(/\n\s*\n/);
  const last = parts.length > 1 ? (parts.at(-1) ?? "") : "";
  const room = MAX_UPDATE_CHARS - last.length - 3;
  if (last && room >= 200) return `${text.slice(0, room).trimEnd()}…\n\n${last}`;
  return `${text.slice(0, MAX_UPDATE_CHARS - 1).trimEnd()}…`;
}

export const AGENT_TOOLS = [recordFacts, getMetar, getLaw, computeCompensation] as unknown as AgentTool[];

export interface Notifier {
  send(text: string): Promise<void>;
  typing(): Promise<void>;
}

export interface RunnerDeps {
  memory: Memory;
  client: ChatClient;
  model: string;
  notify: Notifier;
  log: (line: string) => void;
  hold: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  fetch: typeof fetch;
  maxRunsPerDay: number;
  limits?: Limits;
  now?: () => Date;
}

// one run at a time: events queue behind each other so a case is never worked twice at once
export function createRunner(deps: RunnerDeps) {
  const now = deps.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve();

  const safeSend = async (text: string) => {
    try {
      await deps.notify.send(text);
    } catch (e) {
      deps.log(`⚠️  telegram send failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  };

  async function work(caseId: string, event: AgentEvent, ack: string): Promise<void> {
    const dayStart = `${now().toISOString().slice(0, 10)}T00:00:00.000Z`;
    if (deps.memory.countEventsSince("run_start", dayStart) >= deps.maxRunsPerDay) {
      deps.log("⛔ daily run limit reached, event not processed");
      await safeSend("I've hit my daily limit of runs, so I'll pick this up tomorrow.");
      return;
    }
    deps.memory.addEvent(caseId, "run_start", event.kind);
    await safeSend(ack);
    // one grouped progress line per run, built from tool results, never from model text
    const found: string[] = [];
    let progressSent = false;
    let lastTurn = 0;
    const sendProgress = async () => {
      if (progressSent || found.length === 0) return;
      progressSent = true;
      await safeSend(found.join("\n"));
    };
    const typing = setInterval(() => { void deps.notify.typing().catch(() => undefined); }, 4000);
    void deps.notify.typing().catch(() => undefined);
    try {
      const result = await deps.hold(`case-${caseId.slice(0, 8)}`, () =>
        runAgent({
          client: deps.client,
          model: deps.model,
          tools: AGENT_TOOLS,
          event,
          ctx: { caseId, memory: deps.memory, fetch: deps.fetch, now },
          ...(deps.limits ? { limits: deps.limits } : {}),
          onStep: async (s) => {
            if (s.phase === "before") {
              if (s.turn !== lastTurn && s.reason) deps.log(`🤔 ${s.reason.replace(/\s+/g, " ").slice(0, 160)}`);
              lastTurn = s.turn;
              deps.log(`🔧 ${s.tool} ${JSON.stringify(s.args).slice(0, 160)}`);
              return;
            }
            deps.log(`   ${s.ok ? "✅" : "❌"} ${s.ok ? "ok" : String(s.value).slice(0, 160)}`);
            const line = afterTool(s.tool, s.ok === true, s.value);
            if (line) {
              deps.log(`   ↳ ${line}`);
              found.push(line);
            }
            if (s.lastInTurn) await sendProgress();
          },
        }),
      );
      await sendProgress();
      deps.log(`💬 update to owner (${String(result.modelCalls)} model calls, ${String(result.toolCalls)} tools, ${String(result.tokens.input + result.tokens.output)} tokens)`);
      if (result.update.length > MAX_UPDATE_CHARS) deps.log(`💬 full update: ${result.update.replace(/\s+/g, " ")}`);
      await safeSend(clipUpdate(result.update));
    } catch (e) {
      deps.log(`❌ run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
      await safeSend("Something went wrong on my side while working on this. Nothing was sent to the airline. I'll need another try.");
    } finally {
      clearInterval(typing);
    }
  }

  return {
    enqueue(caseId: string, event: AgentEvent, ack: string): Promise<void> {
      chain = chain.then(() => work(caseId, event, ack));
      return chain;
    },
  };
}
