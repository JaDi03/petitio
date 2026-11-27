import { z } from "zod";

import { findAirport } from "../knowledge/eu261/airports.js";
import { assessCancellation, greatCircleKm } from "../knowledge/eu261/eu261.js";
import type { CaseFacts } from "../memory/store.js";
import { defineTool } from "./tool.js";

const iso = z.iso.datetime();
const REQUIRED = ["from", "to", "scheduledDeparture", "scheduledArrival", "noticeAt"] as const;

const Args = z
  .object({
    operatedByEuCarrier: z.boolean(),
    reroute: z
      .object({ departure: iso, arrival: iso })
      .strict()
      .nullable()
      .optional()
      .describe("Alternative flight the airline offered. Omit it or send null if none was offered"),
    receivedBenefitsCompensationAndAssistanceInThirdCountry: z
      .boolean()
      .optional()
      .describe("Only for departures outside the EU: true only if the passenger got benefits or compensation AND assistance there"),
  })
  .strict();

export type CompensationArgs = z.infer<typeof Args>;

// flight data comes from the case file the server owns, never from the model's arguments
export function compensationFor(a: CompensationArgs, facts: CaseFacts) {
  const missing = REQUIRED.filter((k) => !facts[k]);
  if (missing.length > 0) throw new Error(`missing facts: ${missing.join(", ")}; record them with record_facts first`);
  const { from = "", to = "", scheduledDeparture = "", scheduledArrival = "", noticeAt = "" } = facts;
  const fromAirport = findAirport(from);
  const toAirport = findAirport(to);
  if (!fromAirport || !toAirport) throw new Error("airport not in the supported list");
  const result = assessCancellation({
    from,
    to,
    operatedByEuCarrier: a.operatedByEuCarrier,
    scheduledDeparture: new Date(scheduledDeparture),
    scheduledArrival: new Date(scheduledArrival),
    noticeAt: new Date(noticeAt),
    ...(a.reroute ? { reroute: { departure: new Date(a.reroute.departure), arrival: new Date(a.reroute.arrival) } } : {}),
    ...(a.receivedBenefitsCompensationAndAssistanceInThirdCountry === undefined
      ? {}
      : { receivedBenefitsInThirdCountry: a.receivedBenefitsCompensationAndAssistanceInThirdCountry }),
  });
  // letters quote the exact distance so a 1500.4 km flight never reads as "1500 km"
  const exactKm = Math.round(greatCircleKm(fromAirport, toAirport) * 10) / 10;
  return {
    ...result,
    distanceKm: exactKm,
    route: `${fromAirport.name} -> ${toAirport.name}`,
    basedOn: { from, to, scheduledDeparture, scheduledArrival, noticeAt },
  };
}

export const computeCompensation = defineTool({
  name: "compute_compensation",
  description:
    "Compute what the passenger is owed for the cancelled flight in this case under EU Regulation 261/2004. Airports and times are read from the case file, so record them first with record_facts. Amounts and exceptions come from code; never estimate them yourself.",
  schema: Args,
  run(a, ctx) {
    return Promise.resolve(compensationFor(a, ctx.memory.getCase(ctx.caseId)?.facts ?? {}));
  },
});
