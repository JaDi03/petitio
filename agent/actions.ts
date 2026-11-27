import type { ClaimFields } from "./claim/letter.js";

export interface FiledClaim {
  reference: string;
  before: Buffer;
  after: Buffer;
}

export type FileClaim = (formUrl: URL, fields: ClaimFields & { email: string }) => Promise<FiledClaim>;

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
}
