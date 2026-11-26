import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openMemory } from "./store.js";

describe("case memory", () => {
  it("creates a case, merges facts and keeps them across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "petitio-mem-"));
    const path = join(dir, "cases.db");
    try {
      const m = openMemory(path);
      const c = m.createCase({ flightNumber: "DA123", from: "CDG" });
      m.updateFacts(c.id, { to: "MAD", airlineReason: "weather" });
      m.setStatus(c.id, "waiting");
      m.close();

      const again = openMemory(path);
      const loaded = again.getCase(c.id);
      assert.deepEqual(loaded?.facts, { flightNumber: "DA123", from: "CDG", to: "MAD", airlineReason: "weather" });
      assert.equal(loaded.status, "waiting");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the timeline and decisions in order", () => {
    let t = Date.parse("2026-11-26T10:00:00Z");
    const m = openMemory(":memory:", () => new Date((t += 1000)));
    const c = m.createCase({});
    m.addEvent(c.id, "email_in", "Airline says the flight was cancelled");
    m.addEvent(c.id, "tool", "Checked METAR at LFPG");
    m.logDecision(c.id, { tool: "get_metar", reason: "airline blamed weather", args: { icao: "LFPG" }, allowed: true, outcome: "no storm" });
    m.logDecision(c.id, { tool: "send_email", reason: "x", args: { to: "a@b.c" }, allowed: false, outcome: "recipient not allowed" });

    assert.deepEqual(m.timeline(c.id).map((e) => e.kind), ["email_in", "tool"]);
    const [first, second, ...rest] = m.decisions(c.id);
    assert.ok(first && second);
    assert.equal(rest.length, 0);
    assert.equal(first.allowed, true);
    assert.deepEqual(first.args, { icao: "LFPG" });
    assert.equal(second.allowed, false);
    assert.ok(first.at < second.at);
    m.close();
  });

  it("refuses events and updates for an unknown case", () => {
    const m = openMemory(":memory:");
    assert.throws(() => m.updateFacts("nope", {}), /unknown case/);
    assert.throws(() => { m.addEvent("nope", "x", "y"); }, /FOREIGN KEY/);
    m.close();
  });
});
