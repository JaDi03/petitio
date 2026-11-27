import { z } from "zod";

import { ClaimRefused, UnconfirmedClaim } from "../actions.js";
import { claimFields } from "../claim/letter.js";
import { compensationFor, computeCompensation } from "./compensation.js";
import type { Memory } from "../memory/store.js";
import { defineTool } from "./tool.js";

// the claimed amount comes from code, using the inputs of the last successful compute_compensation call
export function lastCompensation(memory: Memory, caseId: string) {
  const last = memory
    .decisions(caseId)
    .filter((d) => d.tool === computeCompensation.name && d.outcome === "ok")
    .at(-1);
  const args = last ? computeCompensation.schema.safeParse(last.args) : null;
  if (!args?.success) throw new Error("run compute_compensation for this case first");
  return compensationFor(args.data, memory.getCase(caseId)?.facts ?? {});
}

export const CLAIM_ATTEMPT = "claim_attempt";
export const CLAIM_UNCONFIRMED = "claim_unconfirmed";
export const CLAIM_REFUSED = "claim_refused";
export const CLAIM_REFILE = "claim_refile";
export const CLAIM_FILED = "claim_filed";
const CLAIM_EVENTS = [CLAIM_ATTEMPT, CLAIM_UNCONFIRMED, CLAIM_REFUSED, CLAIM_REFILE, CLAIM_FILED];

// cases whose form is being sent right now, in this process; a restart empties it
const inFlight = new Set<string>();

export type ClaimState = "none" | "sending" | "unknown" | "filed";

// "unknown": the form went out and nobody knows yet whether the airline has it; only the owner resolves it
export function claimState(memory: Memory, caseId: string): ClaimState {
  if (memory.getCase(caseId)?.facts.claimRef) return "filed";
  if (inFlight.has(caseId)) return "sending";
  const last = memory.timeline(caseId).filter((e) => CLAIM_EVENTS.includes(e.kind)).at(-1)?.kind;
  // an attempt with no outcome after it was cut off by a restart
  return last === CLAIM_ATTEMPT || last === CLAIM_UNCONFIRMED ? "unknown" : "none";
}

export const UNKNOWN_CLAIM_HELP = "If it confirms your claim, send /filed and their case number. If you are sure nothing reached them, send /refile.";

export const submitClaimForm = defineTool({
  name: "submit_claim_form",
  description:
    "File the passenger's compensation claim on the airline's own claim form. Run compute_compensation first. The form is filled from the case file and the claim text is written by code, so this tool takes no arguments. It files once per case; later calls return the case number the airline already gave.",
  schema: z.object({}).strict(),
  async run(_args, ctx) {
    const actions = ctx.actions;
    if (!actions) throw new Error("no airline is set up here, so I can only advise the owner");
    const facts = ctx.memory.getCase(ctx.caseId)?.facts ?? {};
    if (facts.claimRef) return { alreadyFiled: true, reference: facts.claimRef, airline: actions.airline.name };
    if (actions.paused()) throw new Error("the owner paused all actions; they can send /resume");

    const state = claimState(ctx.memory, ctx.caseId);
    if (state === "sending") throw new Error("the claim form is being sent right now; wait for the result");
    if (state === "unknown") {
      throw new Error(`an earlier attempt may have reached ${actions.airline.name} and its result is unknown, so I won't send the form again. ${actions.airline.name} answers to my inbox. Tell the owner: ${UNKNOWN_CLAIM_HELP} Do not call submit_claim_form again and do not say the claim was filed.`);
    }

    const result = lastCompensation(ctx.memory, ctx.caseId);
    const fields = claimFields(facts, result);
    const attempt = { sent: false };
    let filed;
    try {
      filed = await actions.fileClaim(actions.airline.formUrl, { ...fields, email: actions.agentInbox }, {
        beforeSend: () => {
          attempt.sent = true;
          inFlight.add(ctx.caseId);
          ctx.memory.addEvent(ctx.caseId, CLAIM_ATTEMPT, `sending the ${actions.airline.name} claim form`);
        },
      });
    } catch (e) {
      // nothing left for the airline: the form failed before sending, or it refused the claim
      if (!attempt.sent) throw e;
      if (e instanceof ClaimRefused) {
        ctx.memory.addEvent(ctx.caseId, CLAIM_REFUSED, e.message.slice(0, 200));
        throw e;
      }
      ctx.memory.addEvent(ctx.caseId, CLAIM_UNCONFIRMED, e instanceof Error ? e.message.slice(0, 200) : "no answer from the form");
      inFlight.delete(ctx.caseId);
      const photos = e instanceof UnconfirmedClaim ? e.screenshots : [];
      try {
        await actions.tellOwner(
          `I sent the ${actions.airline.name} claim form for flight ${fields.flightNumber}, but I couldn't read a case number back, so I don't know if they got it. I won't send it again on my own. ${actions.airline.name} answers to my inbox; when they write, I'll show you what they say. ${UNKNOWN_CLAIM_HELP}`,
          photos.map((png, i) => ({ png, caption: i === 0 ? "The form, filled in, before I sent it" : "What the airline's page showed after I sent it" })),
        );
      } catch {
        ctx.memory.addEvent(ctx.caseId, "owner_notice_failed", "could not tell the owner the claim result is unknown");
      }
      throw new Error(`the claim form went out but its result is unknown. Tell the owner: ${UNKNOWN_CLAIM_HELP} Do not call submit_claim_form again and do not say the claim was filed.`, { cause: e });
    } finally {
      inFlight.delete(ctx.caseId);
    }

    ctx.memory.updateFacts(ctx.caseId, { claimRef: filed.reference });
    ctx.memory.addEvent(ctx.caseId, CLAIM_FILED, `${actions.airline.name} case ${filed.reference}, EUR ${String(result.compensationEur)} claimed`);
    ctx.memory.setStatus(ctx.caseId, "waiting");
    // a failed notice never hides that the claim is filed
    try {
      await actions.tellOwner(
        `I filed your claim on the ${actions.airline.name} form for flight ${fields.flightNumber}, asking for EUR ${String(result.compensationEur)}. Their case number is ${filed.reference}. I'll tell you as soon as they answer.`,
        [
          { png: filed.before, caption: "The form, filled in, before I sent it" },
          { png: filed.after, caption: `The airline's confirmation: case ${filed.reference}` },
        ],
      );
    } catch {
      ctx.memory.addEvent(ctx.caseId, "owner_notice_failed", `could not tell the owner about case ${filed.reference}`);
    }
    return { filed: true, reference: filed.reference, airline: actions.airline.name, compensationEur: result.compensationEur };
  },
});
