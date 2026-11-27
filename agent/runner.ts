import type { Actions } from "./actions.js";
import { afterTool } from "./narrate.js";
import { runAgent, type AgentEvent, type ChatClient, type Limits } from "./loop.js";
import type { Memory } from "./memory/store.js";
import { CLAIM_ATTEMPT, claimState, submitClaimForm, UNKNOWN_CLAIM_HELP } from "./tools/claim.js";
import { proposeEmail } from "./tools/propose.js";
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

export const UNCHECKED_NOTE = "(Part of this is not checked with my tools yet, so treat it as unconfirmed.)";

const ARTICLE = /\b(?:Art(?:icle)?\.?)\s*(\d{1,2})((?:\(\d+\))*)/gi;
const AMOUNT = /(?:(?:EUR|€)\s?(\d{2,5})\b)|(?:\b(\d{2,5})\s?(?:EUR|€|euros?)\b)/gi;

// every article and euro amount the owner reads must appear in what the tools returned for this case
export function uncheckedMentions(update: string, evidence: readonly string[]): string[] {
  const proof = evidence.join("\n");
  const misses: string[] = [];
  for (const m of update.matchAll(ARTICLE)) {
    const art = m[1] ?? "";
    const parens = m[2] ?? "";
    const paras = [...parens.matchAll(/\((\d+)\)/g)].map((p) => p[1]).join(".");
    const known = paras
      ? proof.includes(`art${art}.${paras}`) || proof.includes(`Art. ${art}${parens}`)
      : proof.includes(`art${art}.`) || proof.includes(`Art. ${art}(`);
    if (!known) misses.push(m[0]);
  }
  for (const m of update.matchAll(AMOUNT)) {
    const n = m[1] ?? m[2] ?? "";
    if (!proof.includes(`${n} EUR`) && !proof.includes(`EUR ${n}`)) misses.push(m[0]);
  }
  return misses;
}

export const AGENT_TOOLS = [recordFacts, getMetar, getLaw, computeCompensation, submitClaimForm, proposeEmail] as unknown as AgentTool[];

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
  actions?: Actions;
}

// what a failed run tells the owner, from what this run actually did with the airline
export function failureNote(memory: Memory, caseId: string): string {
  const events = memory.timeline(caseId);
  const start = events.map((e) => e.kind).lastIndexOf("run_start");
  const sentForm = events.slice(start + 1).some((e) => e.kind === CLAIM_ATTEMPT);
  const oops = "Something went wrong on my side while working on this.";
  if (!sentForm) return `${oops} Nothing was sent to the airline. I'll need another try.`;
  const state = claimState(memory, caseId);
  if (state === "filed") return `${oops} Your claim is filed (case ${memory.getCase(caseId)?.facts.claimRef ?? ""}); I'll need another try for the rest.`;
  if (state === "none") return `${oops} The airline's form did not take the claim, so nothing is filed. I'll need another try.`;
  return `${oops} I sent the claim form, but I don't know if the airline got it. ${UNKNOWN_CLAIM_HELP}`;
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
          ctx: { caseId, memory: deps.memory, fetch: deps.fetch, now, ...(deps.actions ? { actions: deps.actions } : {}) },
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
      const proof = deps.memory.timeline(caseId).filter((e) => e.kind === "evidence" || e.kind === "claim_filed").map((e) => e.summary);
      const misses = uncheckedMentions(result.update, proof);
      if (misses.length > 0) deps.log(`⚠️  update mentions what no tool returned: ${misses.join(", ").slice(0, 160)}`);
      await safeSend(misses.length > 0 ? `${clipUpdate(result.update)}\n\n${UNCHECKED_NOTE}` : clipUpdate(result.update));
    } catch (e) {
      deps.log(`❌ run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
      await safeSend(failureNote(deps.memory, caseId));
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
