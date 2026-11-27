import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Actions, FileClaim, Photo } from "../actions.js";
import { CLAIM_TEXT_MAX, claimFields, splitName } from "../claim/letter.js";
import { openMemory } from "../memory/store.js";
import { submitClaimForm } from "./claim.js";
import { computeCompensation } from "./compensation.js";
import { recordFacts } from "./facts.js";
import { callTool, type AgentTool, type ToolContext } from "./tool.js";

const FACTS = {
  passengerName: "Alex Doe",
  bookingRef: "AB12CD",
  flightNumber: "DA456",
  airline: "Demo Air",
  from: "FRA",
  to: "LIS",
  scheduledDeparture: "2026-11-24T06:30:00Z",
  scheduledArrival: "2026-11-24T09:30:00Z",
  noticeAt: "2026-11-24T04:00:00Z",
};

const tools = [recordFacts, computeCompensation, submitClaimForm] as unknown as AgentTool[];

function setup(opts: { paused?: boolean; fileClaim?: FileClaim } = {}) {
  const memory = openMemory(":memory:");
  const c = memory.createCase({ ...FACTS });
  const filed: Parameters<FileClaim>[1][] = [];
  const told: { text: string; photos: readonly Photo[] }[] = [];
  const actions: Actions = {
    airline: { name: "Demo Air", email: "claims@airline.example", formUrl: new URL("https://airline.example/claims") },
    agentInbox: "agent@agentmail.to",
    paused: () => opts.paused ?? false,
    fileClaim: opts.fileClaim ?? ((_url, fields) => {
      filed.push(fields);
      return Promise.resolve({ reference: "DA-141262", before: Buffer.from("b"), after: Buffer.from("a") });
    }),
    tellOwner: (text, photos = []) => {
      told.push({ text, photos });
      return Promise.resolve();
    },
  };
  const fail: typeof fetch = () => Promise.reject(new Error("network not allowed in tests"));
  const ctx: ToolContext = { caseId: c.id, memory, fetch: fail, now: () => new Date("2026-11-26T12:00:00Z"), actions };
  return { ctx, memory, caseId: c.id, filed, told };
}

describe("claim text", () => {
  it("is written from case facts and code results only, within the form's limit", async () => {
    const { ctx } = setup();
    const comp = await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    assert.ok(comp.ok);
    const fields = claimFields(FACTS, comp.value as Parameters<typeof claimFields>[1]);
    assert.equal(fields.firstName, "Alex");
    assert.equal(fields.lastName, "Doe");
    assert.equal(fields.flightDate, "2026-11-24");
    assert.ok(fields.description.length <= CLAIM_TEXT_MAX);
    assert.match(fields.description, /Article 5\(1\)\(c\) and Article 7\(1\), compensation of EUR 400 is due/);
    assert.match(fields.description, /"if it can prove"/);
    assert.doesNotMatch(fields.description, /voucher/i);
  });

  it("needs a first and a last name", () => {
    assert.equal(splitName("Alex"), null);
    assert.deepEqual(splitName("  Jo  van der Berg "), { firstName: "Jo", lastName: "van der Berg" });
  });
});

describe("submit_claim_form", () => {
  it("refuses until compute_compensation has run, then files once and fixes the facts", async () => {
    const { ctx, memory, caseId, filed, told } = setup();
    const early = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.ok(!early.ok && early.error.includes("compute_compensation"));
    assert.equal(filed.length, 0);

    assert.ok((await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx)).ok);
    const first = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.deepEqual(first, { ok: true, value: { filed: true, reference: "DA-141262", airline: "Demo Air", compensationEur: 400 } });
    // the airline answers to the agent's inbox, never to an address from outside text
    assert.equal(filed[0]?.email, "agent@agentmail.to");
    const [note, ...extra] = told;
    assert.ok(note);
    assert.equal(extra.length, 0);
    assert.equal(note.photos.length, 2);
    assert.match(note.text, /DA-141262/);

    const again = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.deepEqual(again, { ok: true, value: { alreadyFiled: true, reference: "DA-141262", airline: "Demo Air" } });
    assert.equal(filed.length, 1);
    assert.equal(memory.getCase(caseId)?.status, "waiting");
    const moved = await callTool(tools, "record_facts", { from: "CDG" }, "x", ctx);
    assert.ok(!moved.ok && moved.error.includes("DA-141262"));
  });

  it("does nothing while the owner has paused actions", async () => {
    const { ctx, filed } = setup({ paused: true });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    const r = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.ok(!r.ok && r.error.includes("/resume"));
    assert.equal(filed.length, 0);
  });

  it("refuses when no airline is set up, and keeps no reference when the form fails", async () => {
    const { ctx, memory, caseId } = setup({ fileClaim: () => Promise.reject(new Error("the airline's form refused the claim")) });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    const failed = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.ok(!failed.ok && failed.error.includes("refused"));
    assert.equal(memory.getCase(caseId)?.facts.claimRef, undefined);
    const bare: ToolContext = { caseId: ctx.caseId, memory: ctx.memory, fetch: ctx.fetch, now: ctx.now };
    const none = await callTool(tools, "submit_claim_form", {}, "x", bare);
    assert.ok(!none.ok && none.error.includes("no airline"));
  });

  it("files nothing when the regulation's exception applies", async () => {
    const { ctx, filed } = setup();
    ctx.memory.updateFacts(ctx.caseId, { noticeAt: "2026-10-01T00:00:00Z" });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", ctx);
    const r = await callTool(tools, "submit_claim_form", {}, "x", ctx);
    assert.ok(!r.ok && r.error.includes("nothing to claim"));
    assert.equal(filed.length, 0);
  });
});
