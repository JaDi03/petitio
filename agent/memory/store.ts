import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// what the agent knows about one claim; every field is optional until learned
export interface CaseFacts {
  passengerName?: string;
  bookingRef?: string;
  flightNumber?: string;
  airline?: string;
  from?: string;
  to?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  noticeAt?: string;
  airlineEmail?: string;
  airlineFormUrl?: string;
  airlineReason?: string;
  // set only by code when the airline confirms the claim; never by the model
  claimRef?: string;
}

export type CaseStatus = "open" | "waiting" | "closed";

export interface CaseRecord {
  id: string;
  status: CaseStatus;
  createdAt: string;
  facts: CaseFacts;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  summary: string;
}

export interface Decision {
  at: string;
  tool: string;
  reason: string;
  args: unknown;
  allowed: boolean;
  outcome: string;
}

export type ApprovalStatus = "pending" | "sending" | "sent" | "declined" | "expired" | "failed" | "stale";

// an exact action the owner must approve; code runs exactly this text, never a new one
export interface Approval {
  id: string;
  caseId: string;
  kind: string;
  to: string;
  subject: string;
  body: string;
  amountEur: number;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
}

export interface Memory {
  createCase(facts: CaseFacts): CaseRecord;
  getCase(id: string): CaseRecord | undefined;
  updateFacts(id: string, patch: CaseFacts): CaseRecord;
  setStatus(id: string, status: CaseStatus): void;
  addEvent(caseId: string, kind: string, summary: string): void;
  timeline(caseId: string): TimelineEntry[];
  logDecision(caseId: string, d: Omit<Decision, "at">): void;
  decisions(caseId: string): Decision[];
  // true the first time an external event id is seen, false on any repeat
  firstSeen(id: string): boolean;
  latestOpenCase(): CaseRecord | undefined;
  countEventsSince(kind: string, sinceIso: string): number;
  createApproval(a: Omit<Approval, "id" | "status" | "createdAt">): Approval;
  getApproval(id: string): Approval | undefined;
  pendingApproval(caseId: string, kind: string): Approval | undefined;
  // true only for the one caller that moves the approval out of "pending"
  takeApproval(id: string, to: ApprovalStatus): boolean;
  setApprovalStatus(id: string, status: ApprovalStatus): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  facts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  amount_eur INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  reason TEXT NOT NULL,
  args TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
`;

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("unexpected column type");
  return v;
}

export function openMemory(path: string, now: () => Date = () => new Date()): Memory {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const ts = () => now().toISOString();

  const getCase = (id: string): CaseRecord | undefined => {
    const row = db.prepare("SELECT id, status, created_at, facts FROM cases WHERE id = ?").get(id);
    if (!row) return undefined;
    return {
      id: str(row.id),
      status: str(row.status) as CaseStatus,
      createdAt: str(row.created_at),
      facts: JSON.parse(str(row.facts)) as CaseFacts,
    };
  };

  const toApproval = (r: Record<string, unknown>): Approval => ({
    id: str(r.id),
    caseId: str(r.case_id),
    kind: str(r.kind),
    to: str(r.to_addr),
    subject: str(r.subject),
    body: str(r.body),
    amountEur: Number(r.amount_eur),
    status: str(r.status) as ApprovalStatus,
    createdAt: str(r.created_at),
    expiresAt: str(r.expires_at),
  });
  const getApproval = (id: string): Approval | undefined => {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? toApproval(row) : undefined;
  };

  const mustGet = (id: string): CaseRecord => {
    const c = getCase(id);
    if (!c) throw new Error(`unknown case: ${id}`);
    return c;
  };

  return {
    createCase(facts) {
      const record: CaseRecord = { id: randomUUID(), status: "open", createdAt: ts(), facts };
      db.prepare("INSERT INTO cases (id, status, created_at, facts) VALUES (?, ?, ?, ?)").run(
        record.id,
        record.status,
        record.createdAt,
        JSON.stringify(facts),
      );
      return record;
    },
    getCase,
    updateFacts(id, patch) {
      const current = mustGet(id);
      const facts = { ...current.facts, ...patch };
      db.prepare("UPDATE cases SET facts = ? WHERE id = ?").run(JSON.stringify(facts), id);
      return { ...current, facts };
    },
    setStatus(id, status) {
      mustGet(id);
      db.prepare("UPDATE cases SET status = ? WHERE id = ?").run(status, id);
    },
    addEvent(caseId, kind, summary) {
      db.prepare("INSERT INTO events (case_id, at, kind, summary) VALUES (?, ?, ?, ?)").run(caseId, ts(), kind, summary);
    },
    timeline(caseId) {
      return db
        .prepare("SELECT at, kind, summary FROM events WHERE case_id = ? ORDER BY id")
        .all(caseId)
        .map((r) => ({ at: str(r.at), kind: str(r.kind), summary: str(r.summary) }));
    },
    logDecision(caseId, d) {
      db.prepare(
        "INSERT INTO decisions (case_id, at, tool, reason, args, allowed, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(caseId, ts(), d.tool, d.reason, JSON.stringify(d.args), d.allowed ? 1 : 0, d.outcome);
    },
    decisions(caseId) {
      return db
        .prepare("SELECT at, tool, reason, args, allowed, outcome FROM decisions WHERE case_id = ? ORDER BY id")
        .all(caseId)
        .map((r) => ({
          at: str(r.at),
          tool: str(r.tool),
          reason: str(r.reason),
          args: JSON.parse(str(r.args)) as unknown,
          allowed: r.allowed === 1,
          outcome: str(r.outcome),
        }));
    },
    firstSeen(id) {
      const r = db.prepare("INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)").run(id, ts());
      return r.changes === 1;
    },
    latestOpenCase() {
      const row = db.prepare("SELECT id FROM cases WHERE status != 'closed' ORDER BY created_at DESC LIMIT 1").get();
      return row ? getCase(str(row.id)) : undefined;
    },
    countEventsSince(kind, sinceIso) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?").get(kind, sinceIso);
      return Number(row?.n ?? 0);
    },
    createApproval(a) {
      const id = randomBytes(9).toString("base64url");
      db.prepare(
        "INSERT INTO approvals (id, case_id, kind, to_addr, subject, body, amount_eur, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(id, a.caseId, a.kind, a.to, a.subject, a.body, a.amountEur, ts(), a.expiresAt);
      const created = getApproval(id);
      if (!created) throw new Error("approval not stored");
      return created;
    },
    getApproval,
    pendingApproval(caseId, kind) {
      const row = db
        .prepare("SELECT * FROM approvals WHERE case_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
        .get(caseId, kind);
      return row ? toApproval(row) : undefined;
    },
    takeApproval(id, to) {
      return db.prepare("UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending'").run(to, id).changes === 1;
    },
    setApprovalStatus(id, status) {
      db.prepare("UPDATE approvals SET status = ? WHERE id = ?").run(status, id);
    },
    close() {
      db.close();
    },
  };
}
