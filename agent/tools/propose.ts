import { z } from "zod";

import { airlineEmail, assertClaimable, EMAIL_KINDS } from "../claim/letter.js";
import { lastCompensation } from "./claim.js";
import { defineTool } from "./tool.js";

export const APPROVAL_HOURS = 24;

export const proposeEmail = defineTool({
  name: "propose_email",
  description:
    "Prepare an email to the airline and ask the owner to approve it. Nothing is sent until the owner taps 'Send it'. reject_voucher: the airline offered a voucher and the owner wants money. follow_up: the airline has not answered the filed claim. The text, the amount and the recipient are set by code.",
  schema: z.object({ kind: z.enum(EMAIL_KINDS) }).strict(),
  async run({ kind }, ctx) {
    const actions = ctx.actions;
    if (!actions) throw new Error("no airline is set up here, so I can only advise the owner");
    if (actions.paused()) throw new Error("the owner paused all actions; they can send /resume");
    const facts = ctx.memory.getCase(ctx.caseId)?.facts ?? {};
    if (!facts.claimRef) throw new Error("file the claim with submit_claim_form first");
    const timeline = ctx.memory.timeline(ctx.caseId);
    if (kind === "reject_voucher" && !timeline.some((e) => e.kind === "airline_email")) {
      throw new Error("the airline has not answered yet, so there is no voucher to reject");
    }
    const waiting = ctx.memory.pendingApproval(ctx.caseId, kind);
    if (waiting) return { waitingForOwner: true, kind, askedAt: waiting.createdAt };

    const result = lastCompensation(ctx.memory, ctx.caseId);
    assertClaimable(result);
    const amountEur = result.compensationEur;
    const filedOn = (timeline.find((e) => e.kind === "claim_filed")?.at ?? "").slice(0, 10);
    const email = airlineEmail(kind, { airline: actions.airline.name, facts, amountEur, filedOn });
    const approval = ctx.memory.createApproval({
      caseId: ctx.caseId,
      kind,
      to: actions.airline.email,
      ...email,
      amountEur,
      expiresAt: new Date(ctx.now().getTime() + APPROVAL_HOURS * 3_600_000).toISOString(),
    });
    ctx.memory.addEvent(ctx.caseId, "approval_asked", `${kind}: waiting for the owner`);
    await actions.askOwner(approval);
    return { waitingForOwner: true, kind };
  },
});
