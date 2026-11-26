import { randomUUID } from "node:crypto";
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

export interface Memory {
  createCase(facts: CaseFacts): CaseRecord;
  getCase(id: string): CaseRecord | undefined;
  updateFacts(id: string, patch: CaseFacts): CaseRecord;
  setStatus(id: string, status: CaseStatus): void;
  addEvent(caseId: string, kind: string, summary: string): void;
  timeline(caseId: string): TimelineEntry[];
  logDecision(caseId: string, d: Omit<Decision, "at">): void;
  decisions(caseId: string): Decision[];
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
    close() {
      db.close();
    },
  };
}
