import type { Actions } from "./actions.js";
import { assertClaimable } from "./claim/letter.js";
import type { Memory } from "./memory/store.js";
import { lastCompensation } from "./tools/claim.js";

export const APPROVAL_DATA = /^ap:([A-Za-z0-9_-]{12}):(y|n)$/;

// Runs the owner's answer to one approval. The email sent is the stored text, exactly as shown.
export async function decideApproval(
  deps: { memory: Memory; actions: Actions; now: () => Date },
  id: string,
  yes: boolean,
): Promise<string> {
  const { memory, actions } = deps;
  const a = memory.getApproval(id);
  if (a?.status !== "pending") return "That request was already handled.";
  const event = (kind: string, summary: string) => { memory.addEvent(a.caseId, kind, summary); };

  if (!yes) {
    if (!memory.takeApproval(id, "declined")) return "That request was already handled.";
    event("approval_declined", `${a.kind}: the owner said no`);
    return "OK, I won't send it.";
  }
  if (deps.now().toISOString() > a.expiresAt) {
    memory.takeApproval(id, "expired");
    return "That request expired. Ask me again if you still want it sent.";
  }
  if (actions.paused()) return "Actions are paused. Send /resume, then tap the button again.";
  const c = memory.getCase(a.caseId);
  // the target and the amount are checked again now: either may have changed since the owner was asked
  let amountEur: number | null;
  try {
    const result = lastCompensation(memory, a.caseId);
    assertClaimable(result);
    amountEur = result.compensationEur;
  } catch {
    amountEur = null;
  }
  if (c?.status === "closed" || a.to !== actions.airline.email || amountEur !== a.amountEur) {
    memory.takeApproval(id, "stale");
    event("approval_stale", `${a.kind}: the case changed since the owner was asked`);
    return "The case changed since I asked, so I didn't send it. Ask me to prepare it again.";
  }
  if (!memory.takeApproval(id, "sending")) return "That request was already handled.";
  try {
    await actions.sendEmail(a.to, a.subject, a.body);
  } catch {
    memory.setApprovalStatus(id, "failed");
    event("email_failed", `${a.kind}: sending failed`);
    return `Sending to ${actions.airline.name} failed, so nothing went out. Ask me to try again.`;
  }
  memory.setApprovalStatus(id, "sent");
  event("email_sent", `${a.kind} sent to ${actions.airline.name}: ${a.subject}`);
  return `Sent to ${actions.airline.name}.`;
}
