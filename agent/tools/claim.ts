import { z } from "zod";

import { claimFields } from "../claim/letter.js";
import { compensationFor, computeCompensation } from "./compensation.js";
import { defineTool, type ToolContext } from "./tool.js";

// the claimed amount comes from code, using the inputs of the last successful compute_compensation call
function lastCompensation(ctx: ToolContext) {
  const last = ctx.memory
    .decisions(ctx.caseId)
    .filter((d) => d.tool === computeCompensation.name && d.outcome === "ok")
    .at(-1);
  const args = last ? computeCompensation.schema.safeParse(last.args) : null;
  if (!args?.success) throw new Error("run compute_compensation for this case first");
  return compensationFor(args.data, ctx.memory.getCase(ctx.caseId)?.facts ?? {});
}

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

    const result = lastCompensation(ctx);
    const fields = claimFields(facts, result);
    const filed = await actions.fileClaim(actions.airline.formUrl, { ...fields, email: actions.agentInbox });

    ctx.memory.updateFacts(ctx.caseId, { claimRef: filed.reference });
    ctx.memory.addEvent(ctx.caseId, "claim_filed", `${actions.airline.name} case ${filed.reference}, EUR ${String(result.compensationEur)} claimed`);
    ctx.memory.setStatus(ctx.caseId, "waiting");
    await actions.tellOwner(
      `I filed your claim on the ${actions.airline.name} form for flight ${fields.flightNumber}, asking for EUR ${String(result.compensationEur)}. Their case number is ${filed.reference}. I'll tell you as soon as they answer.`,
      [
        { png: filed.before, caption: "The form, filled in, before I sent it" },
        { png: filed.after, caption: `The airline's confirmation: case ${filed.reference}` },
      ],
    );
    return { filed: true, reference: filed.reference, airline: actions.airline.name, compensationEur: result.compensationEur };
  },
});
