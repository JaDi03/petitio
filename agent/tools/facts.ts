import { z } from "zod";

import type { CaseFacts } from "../memory/store.js";
import { defineTool } from "./tool.js";

// one line, no angle brackets: facts are re-read into later prompts and must not carry markup
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n<>]+$/, "single line without < or >");

// a case is one flight: what identifies the flight and the passenger never changes once known,
// so an email about another flight cannot rewrite it before or after the claim is filed
const IDENTITY_KEYS: readonly (keyof CaseFacts)[] = [
  "flightNumber", "bookingRef", "passengerName", "airline", "from", "to", "scheduledDeparture", "scheduledArrival", "noticeAt",
];

export const recordFacts = defineTool({
  name: "record_facts",
  description:
    "Save facts you learned about this claim to the case file so you remember them next time. Only record what the messages state; never guess. Times are ISO 8601 UTC.",
  schema: z
    .object({
      passengerName: text(100),
      bookingRef: z.string().regex(/^[A-Z0-9]{5,8}$/),
      flightNumber: z.string().regex(/^[A-Z0-9]{2,3}\d{1,4}$/),
      airline: text(100),
      from: z.string().regex(/^[A-Z]{3,4}$/),
      to: z.string().regex(/^[A-Z]{3,4}$/),
      scheduledDeparture: z.iso.datetime(),
      scheduledArrival: z.iso.datetime(),
      noticeAt: z.iso.datetime(),
      airlineReason: text(300),
    })
    .partial()
    .strict(),
  run(facts, ctx) {
    const patch = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)) as CaseFacts;
    const current = ctx.memory.getCase(ctx.caseId)?.facts ?? {};
    const changed = IDENTITY_KEYS.filter((k) => patch[k] !== undefined && current[k] !== undefined && patch[k] !== current[k]);
    if (changed.length > 0) {
      const why = current.claimRef === undefined
        ? `this case is for flight ${current.flightNumber ?? "?"}, booking ${current.bookingRef ?? "?"}; this version follows one flight at a time`
        : `the claim ${current.claimRef} was already filed with these facts`;
      throw new Error(`not saved: ${changed.join(", ")} cannot change because ${why}`);
    }
    const updated = ctx.memory.updateFacts(ctx.caseId, patch);
    ctx.memory.addEvent(ctx.caseId, "facts", `Recorded: ${Object.keys(patch).join(", ")}`);
    return Promise.resolve({ saved: Object.keys(patch), facts: updated.facts });
  },
});
