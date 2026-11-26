import { EU_MEMBER_STATES, findAirport, type Airport } from "./airports.js";
import type { LawRef } from "./law.js";

export interface CancellationInput {
  from: string;
  to: string;
  operatedByEuCarrier: boolean;
  scheduledDeparture: Date;
  scheduledArrival: Date;
  noticeAt: Date;
  reroute?: { departure: Date; arrival: Date };
  // Art. 3(1)(b): only relevant for departures from a third country
  receivedBenefitsInThirdCountry?: boolean;
}

export type Band = "a" | "b" | "c";

export interface CancellationResult {
  inScope: boolean;
  distanceKm: number;
  intraCommunity: boolean;
  band: Band;
  exception: "i" | "ii" | "iii" | null;
  compensationEur: number;
  // the carrier may cut compensation by half when re-routing arrives within the Art. 7(2) window
  reducibleToEur: number | null;
  // why reducibleToEur is what it is: the re-routing delay at arrival against the Art. 7(2) limit
  reroute: { lateByH: number; limitH: number } | null;
  refs: LawRef[];
  // set when the result assumes a fact the passenger has not confirmed yet
  unconfirmed: "art3.1b" | null;
}

const EARTH_RADIUS_KM = 6371;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function greatCircleKm(a: Airport, b: Airport): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function band(distanceKm: number, intraCommunity: boolean): Band {
  if (distanceKm <= 1500) return "a";
  if (intraCommunity || distanceKm <= 3500) return "b";
  return "c";
}

const AMOUNT_EUR: Record<Band, number> = { a: 250, b: 400, c: 600 };
const REDUCTION_WINDOW_H: Record<Band, number> = { a: 2, b: 3, c: 4 };

function airportOrThrow(code: string): Airport {
  const airport = findAirport(code);
  if (!airport) throw new Error(`unknown airport: ${code}`);
  return airport;
}

function exceptionFor(input: CancellationInput): CancellationResult["exception"] {
  const notice = input.scheduledDeparture.getTime() - input.noticeAt.getTime();
  if (notice >= 14 * DAY_MS) return "i";
  const r = input.reroute;
  if (!r) return null;
  const departsEarlyBy = input.scheduledDeparture.getTime() - r.departure.getTime();
  const arrivesLateBy = r.arrival.getTime() - input.scheduledArrival.getTime();
  if (notice >= 7 * DAY_MS) {
    return departsEarlyBy <= 2 * HOUR_MS && arrivesLateBy < 4 * HOUR_MS ? "ii" : null;
  }
  return departsEarlyBy <= HOUR_MS && arrivesLateBy < 2 * HOUR_MS ? "iii" : null;
}

function assertValidDates(input: CancellationInput): void {
  const dates = [input.scheduledDeparture, input.scheduledArrival, input.noticeAt];
  if (input.reroute) dates.push(input.reroute.departure, input.reroute.arrival);
  if (dates.some((d) => Number.isNaN(d.getTime()))) throw new Error("invalid date");
  if (input.scheduledArrival <= input.scheduledDeparture) throw new Error("arrival must be after departure");
  if (input.reroute && input.reroute.arrival <= input.reroute.departure) {
    throw new Error("re-routing arrival must be after its departure");
  }
}

export function assessCancellation(input: CancellationInput): CancellationResult {
  assertValidDates(input);
  const from = airportOrThrow(input.from);
  const to = airportOrThrow(input.to);
  const exactKm = greatCircleKm(from, to);
  const distanceKm = Math.round(exactKm);
  const intraCommunity = EU_MEMBER_STATES.has(from.country) && EU_MEMBER_STATES.has(to.country);
  const b = band(exactKm, intraCommunity);
  const fromEu = EU_MEMBER_STATES.has(from.country);
  const inScope =
    fromEu ||
    (EU_MEMBER_STATES.has(to.country) && input.operatedByEuCarrier && input.receivedBenefitsInThirdCountry !== true);

  const refs: LawRef[] = ["art3.1"];
  const unconfirmed = !fromEu && inScope && input.receivedBenefitsInThirdCountry === undefined ? "art3.1b" : null;
  if (!inScope) {
    return { inScope, distanceKm, intraCommunity, band: b, exception: null, compensationEur: 0, reducibleToEur: null, reroute: null, refs, unconfirmed };
  }

  const exception = exceptionFor(input);
  refs.push("art5.1c", "art5.3", "art5.4");
  if (exception) {
    return { inScope, distanceKm, intraCommunity, band: b, exception, compensationEur: 0, reducibleToEur: null, reroute: null, refs, unconfirmed };
  }

  const compensationEur = AMOUNT_EUR[b];
  refs.push("art7.1", "art7.3", "art7.4");
  let reducibleToEur: number | null = null;
  const r = input.reroute;
  const lateMs = r ? r.arrival.getTime() - input.scheduledArrival.getTime() : 0;
  if (r && lateMs <= REDUCTION_WINDOW_H[b] * HOUR_MS) {
    reducibleToEur = compensationEur / 2;
    refs.push("art7.2");
  }
  const reroute = r ? { lateByH: Math.round((lateMs / HOUR_MS) * 10) / 10, limitH: REDUCTION_WINDOW_H[b] } : null;
  return { inScope, distanceKm, intraCommunity, band: b, exception: null, compensationEur, reducibleToEur, reroute, refs, unconfirmed };
}
