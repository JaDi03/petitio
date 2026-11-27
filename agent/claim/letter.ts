import { findAirport } from "../knowledge/eu261/airports.js";
import type { CancellationResult } from "../knowledge/eu261/eu261.js";
import { LAW } from "../knowledge/eu261/law.js";
import type { CaseFacts } from "../memory/store.js";

export const CLAIM_TEXT_MAX = 2000;

export interface ClaimFields {
  firstName: string;
  lastName: string;
  bookingRef: string;
  flightNumber: string;
  flightDate: string;
  description: string;
}

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

// first word is the first name; the rest is the last name, as most airline forms split it
export function splitName(full: string): { firstName: string; lastName: string } | null {
  const words = full.trim().split(/\s+/);
  if (words.length < 2) return null;
  return { firstName: words[0] ?? "", lastName: words.slice(1).join(" ") };
}

// nothing is asked of the airline unless the regulation gives the passenger money
export function assertClaimable(result: CancellationResult): void {
  if (!result.inScope) throw new Error("this flight is outside Regulation 261/2004, so there is nothing to claim");
  if (result.exception !== null) throw new Error(`exception ${result.exception} of Article 5(1)(c) applies, so there is nothing to claim`);
  if (result.unconfirmed !== null) throw new Error("ask the owner about Article 3(1)(b) before filing");
  if (!(result.compensationEur > 0)) throw new Error("the compensation for this flight is EUR 0, so there is nothing to claim");
}

// every sentence is fixed text filled with case facts and code results; nothing comes from the model
export function claimFields(facts: CaseFacts, result: CancellationResult): ClaimFields {
  const { passengerName, bookingRef, flightNumber, from, to, scheduledDeparture, noticeAt } = facts;
  if (!passengerName || !bookingRef || !flightNumber || !from || !to || !scheduledDeparture || !noticeAt) {
    throw new Error("missing facts: passengerName, bookingRef, flightNumber, from, to, scheduledDeparture and noticeAt are needed");
  }
  const name = splitName(passengerName);
  if (!name) throw new Error("the passenger's full name (first and last) is needed");
  assertClaimable(result);

  const fromName = findAirport(from)?.name ?? from;
  const toName = findAirport(to)?.name ?? to;
  const days = Math.floor((Date.parse(scheduledDeparture) - Date.parse(noticeAt)) / 86_400_000);
  const description = [
    "Claim for compensation under Regulation (EC) No 261/2004.",
    `Flight ${flightNumber} from ${fromName} (${from}) to ${toName} (${to}), scheduled to depart at ${utc(scheduledDeparture)}, was cancelled. I was told on ${utc(noticeAt)}, ${String(days)} days before departure.`,
    `Under Article 5(1)(c) and Article 7(1), compensation of EUR ${String(result.compensationEur)} is due for this ${String(result.distanceKm)} km flight.`,
    "If you rely on extraordinary circumstances, Article 5(3) only releases the carrier \"if it can prove\" them. Please send that evidence.",
    "Please pay the compensation in cash or by bank transfer, as Article 7(3) provides.",
    `Booking reference ${bookingRef}. Passenger ${passengerName}.`,
  ].join("\n\n");
  if (description.length > CLAIM_TEXT_MAX) throw new Error("claim text is over the form's limit");
  return { ...name, bookingRef, flightNumber, flightDate: scheduledDeparture.slice(0, 10), description };
}

export const EMAIL_KINDS = ["reject_voucher", "follow_up"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export interface Email {
  subject: string;
  body: string;
}

// letters to the airline: fixed sentences, case facts, code amounts and the regulation's own words
export function airlineEmail(kind: EmailKind, input: { airline: string; facts: CaseFacts; amountEur: number; filedOn: string }): Email {
  const { facts, airline, amountEur, filedOn } = input;
  const { claimRef, flightNumber, passengerName, bookingRef } = facts;
  if (!claimRef || !flightNumber || !passengerName || !bookingRef) throw new Error("the claim has not been filed yet");
  const sign = `Kind regards,\n${passengerName}\nBooking reference ${bookingRef}`;
  if (kind === "reject_voucher") {
    return {
      subject: `Claim ${claimRef}: compensation in money, not a voucher`,
      body: [
        `Dear ${airline},`,
        `Thank you for your answer to claim ${claimRef} about the cancelled flight ${flightNumber}. You offered a travel voucher. I do not accept it.`,
        `Article 7(3) of Regulation (EC) No 261/2004 says: "${LAW["art7.3"]}" I do not give that agreement.`,
        `Please pay the EUR ${String(amountEur)} compensation by bank transfer and tell me what details you need for it.`,
        sign,
      ].join("\n\n"),
    };
  }
  return {
    subject: `Claim ${claimRef}: waiting for your answer`,
    body: [
      `Dear ${airline},`,
      `On ${filedOn} I filed claim ${claimRef} for the cancelled flight ${flightNumber}, asking for EUR ${String(amountEur)} under Article 7(1) of Regulation (EC) No 261/2004. I have not had an answer yet.`,
      "Please tell me when you will pay, or send the evidence you rely on if you refuse.",
      sign,
    ].join("\n\n"),
  };
}
