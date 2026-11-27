import type { ClaimFields } from "./claim/letter.js";

export interface FiledClaim {
  reference: string;
  before: Buffer;
  after: Buffer;
}

// an airline case number, as the form shows it and as the owner types it
export const CASE_REFERENCE = /^[A-Z0-9][A-Z0-9-]{3,19}$/;

// the form was sent but the airline's answer could not be read, so it may or may not have the claim
export class UnconfirmedClaim extends Error {
  constructor(message: string, readonly screenshots: readonly Buffer[]) {
    super(message);
    this.name = "UnconfirmedClaim";
  }
}

// the airline's form showed field errors and no case number, so it did not take the claim;
// any other failure after sending counts as unconfirmed
export class ClaimRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimRefused";
  }
}

// beforeSend runs right before the form is sent, so the attempt is on record even if the answer never comes
export type FileClaim = (
  formUrl: URL,
  fields: ClaimFields & { email: string },
  hooks: { beforeSend: () => void },
) => Promise<FiledClaim>;

export interface Photo {
  png: Buffer;
  caption: string;
}

// what the agent may do outside the case file; every target here comes from config, never from text
export interface Actions {
  airline: { name: string; email: string; formUrl: URL };
  // the agent's own inbox, so the airline's answer comes back to it
  agentInbox: string;
  paused: () => boolean;
  fileClaim: FileClaim;
  tellOwner: (text: string, photos?: readonly Photo[]) => Promise<void>;
  // shows the owner the exact email with "Send it" and "Don't send" buttons
  askOwner: (approval: { id: string; to: string; subject: string; body: string }) => Promise<void>;
  sendEmail: (to: string, subject: string, text: string) => Promise<void>;
}
