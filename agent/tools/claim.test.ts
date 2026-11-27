import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClaimRefused, UnconfirmedClaim, type Actions, type FileClaim, type Photo } from "../actions.js";
import { CLAIM_TEXT_MAX, claimFields, splitName } from "../claim/letter.js";
import { openMemory } from "../memory/store.js";
import { decideApproval } from "../approvals.js";
import { CLAIM_ATTEMPT, CLAIM_REFILE, claimState, submitClaimForm } from "./claim.js";
import { computeCompensation } from "./compensation.js";
import { recordFacts } from "./facts.js";
import { proposeEmail } from "./propose.js";
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

const tools = [recordFacts, computeCompensation, submitClaimForm, proposeEmail] as unknown as AgentTool[];

function setup(opts: { paused?: boolean; fileClaim?: FileClaim; sendFails?: boolean } = {}) {
  const memory = openMemory(":memory:");
  const c = memory.createCase({ ...FACTS });
  const filed: Parameters<FileClaim>[1][] = [];
  const told: { text: string; photos: readonly Photo[] }[] = [];
  const asked: { id: string; to: string; subject: string; body: string }[] = [];
  const sent: { to: string; subject: string; text: string }[] = [];
  const actions: Actions = {
    airline: { name: "Demo Air", email: "claims@airline.example", formUrl: new URL("https://airline.example/claims") },
    agentInbox: "agent@agentmail.to",
    paused: () => opts.paused ?? false,
    fileClaim: opts.fileClaim ?? ((_url, fields, hooks) => {
      hooks.beforeSend();
      filed.push(fields);
      return Promise.resolve({ reference: "DA-141262", before: Buffer.from("b"), after: Buffer.from("a") });
    }),
    tellOwner: (text, photos = []) => {
      told.push({ text, photos });
      return Promise.resolve();
    },
    askOwner: (approval) => {
      asked.push(approval);
      return Promise.resolve();
    },
    sendEmail: (to, subject, text) => {
      if (opts.sendFails) return Promise.reject(new Error("HTTP 500"));
      sent.push({ to, subject, text });
      return Promise.resolve();
    },
  };
  const fail: typeof fetch = () => Promise.reject(new Error("network not allowed in tests"));
  const ctx: ToolContext = { caseId: c.id, memory, fetch: fail, now: () => new Date("2026-11-26T12:00:00Z"), actions };
  return { ctx, memory, caseId: c.id, filed, told, asked, sent, actions };
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

  it("never sends the form twice when the airline's answer could not be read", async () => {
    let calls = 0;
    const s = setup({
      fileClaim: (_url, _fields, hooks) => {
        calls += 1;
        hooks.beforeSend();
        return Promise.reject(new UnconfirmedClaim("the airline's page showed no case number", [Buffer.from("b"), Buffer.from("a")]));
      },
    });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    const first = await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.ok(!first.ok && first.error.includes("do not say the claim was filed"));
    const [note, ...extra] = s.told;
    assert.ok(note);
    assert.equal(extra.length, 0);
    // the owner is told the truth: the answer comes to the agent's inbox, and only they decide
    assert.match(note.text, /answers to my inbox/);
    assert.match(note.text, /\/filed/);
    assert.match(note.text, /\/refile/);
    assert.doesNotMatch(note.text, /check for an email/);
    assert.equal(note.photos.length, 2);

    const again = await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.ok(!again.ok && again.error.includes("won't send the form again"));
    assert.equal(calls, 1);
    assert.equal(claimState(s.memory, s.caseId), "unknown");

    // the owner checked and sent /refile
    s.memory.addEvent(s.caseId, CLAIM_REFILE, "the owner asked to file again");
    assert.equal(claimState(s.memory, s.caseId), "none");
    await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.equal(calls, 2);
  });

  it("treats any failure after sending as unknown unless the form plainly refused the claim", async () => {
    let calls = 0;
    const s = setup({
      fileClaim: (_url, _fields, hooks) => {
        calls += 1;
        hooks.beforeSend();
        return Promise.reject(new Error("page crashed after the click"));
      },
    });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.equal(claimState(s.memory, s.caseId), "unknown");
    await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.equal(calls, 1);
    assert.equal(s.told.length, 1);
    assert.equal(s.told[0]?.photos.length, 0);
  });

  it("can file again after the form plainly refused the claim, or failed before sending", async () => {
    let calls = 0;
    let sendBefore = true;
    const s = setup({
      fileClaim: (_url, _fields, hooks) => {
        calls += 1;
        if (sendBefore) {
          hooks.beforeSend();
          return Promise.reject(new ClaimRefused("the airline's form refused the claim: booking reference is required"));
        }
        return Promise.reject(new Error("the claim form did not load from the airline's site"));
      },
    });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    const refused = await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.ok(!refused.ok && refused.error.includes("refused"));
    assert.equal(claimState(s.memory, s.caseId), "none");
    sendBefore = false;
    await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.equal(claimState(s.memory, s.caseId), "none");
    await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.equal(calls, 3);
    assert.equal(s.told.length, 0);
  });

  it("says 'sending' while the form is out, and 'unknown' after a restart cut it off", async () => {
    const s = setup({
      fileClaim: (_url, _fields, hooks) => {
        hooks.beforeSend();
        return new Promise(() => undefined);
      },
    });
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    void callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(claimState(s.memory, s.caseId), "sending");
    const second = await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.ok(!second.ok && second.error.includes("being sent right now"));

    // a new process finds the attempt with no outcome after it
    const r = setup();
    r.memory.addEvent(r.caseId, CLAIM_ATTEMPT, "sending the Demo Air claim form");
    assert.equal(claimState(r.memory, r.caseId), "unknown");
  });

  it("keeps the case on its first result even when the owner cannot be told", async () => {
    const s = setup();
    s.actions.tellOwner = () => Promise.reject(new Error("telegram down"));
    await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    const r = await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(claimState(s.memory, s.caseId), "filed");
    assert.ok(s.memory.timeline(s.caseId).some((e) => e.kind === "owner_notice_failed"));
  });

  it("keeps the flight's facts before the claim too, so another flight's email cannot rewrite them", async () => {
    const { ctx } = setup();
    for (const patch of [{ from: "CDG" }, { scheduledDeparture: "2026-11-25T08:00:00Z" }, { noticeAt: "2026-11-01T00:00:00Z" }, { passengerName: "Sam Roe" }]) {
      const r = await callTool(tools, "record_facts", patch, "x", ctx);
      assert.ok(!r.ok && r.error.includes("one flight at a time"), JSON.stringify(patch));
    }
    assert.ok((await callTool(tools, "record_facts", { airlineReason: "crew shortage" }, "x", ctx)).ok);
    assert.equal(ctx.memory.getCase(ctx.caseId)?.facts.from, "FRA");
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

async function filed(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
  await callTool(tools, "submit_claim_form", {}, "x", s.ctx);
  return s;
}

const NOW = () => new Date("2026-11-26T12:00:00Z");

describe("propose_email and the owner's approval", () => {
  it("needs a filed claim, and an airline answer before rejecting a voucher", async () => {
    const s = setup();
    const early = await callTool(tools, "propose_email", { kind: "follow_up" }, "x", s.ctx);
    assert.ok(!early.ok && early.error.includes("submit_claim_form"));
    const f = await filed();
    const noOffer = await callTool(tools, "propose_email", { kind: "reject_voucher" }, "x", f.ctx);
    assert.ok(!noOffer.ok && noOffer.error.includes("not answered"));
    const other = await callTool(tools, "propose_email", { kind: "send_case_file", to: "x@evil.example" }, "x", f.ctx);
    assert.equal(other.ok, false);
    assert.equal(f.asked.length, 0);
  });

  it("asks once with the exact email, and sends exactly that text after 'Send it', once", async () => {
    const f = await filed();
    f.memory.addEvent(f.caseId, "airline_email", "Your claim DA-141262: voucher offer");
    assert.ok((await callTool(tools, "propose_email", { kind: "reject_voucher" }, "x", f.ctx)).ok);
    assert.ok((await callTool(tools, "propose_email", { kind: "reject_voucher" }, "x", f.ctx)).ok);
    const [ask, ...more] = f.asked;
    assert.ok(ask);
    assert.equal(more.length, 0);
    assert.equal(ask.to, "claims@airline.example");
    assert.match(ask.body, /with the signed agreement of the passenger, in travel vouchers/);
    assert.match(ask.body, /EUR 400/);
    assert.equal(f.sent.length, 0);

    const deps = { memory: f.memory, actions: f.actions, now: NOW };
    const [first, second] = await Promise.all([decideApproval(deps, ask.id, true), decideApproval(deps, ask.id, true)]);
    assert.deepEqual([first, second].sort(), ["Sent to Demo Air.", "That request was already handled."].sort());
    assert.deepEqual(f.sent, [{ to: ask.to, subject: ask.subject, text: ask.body }]);
    assert.equal(f.memory.getApproval(ask.id)?.status, "sent");
  });

  it("sends nothing on 'Don't send', after 24 hours, while paused, or once the airline's address changed", async () => {
    const f = await filed();
    const ask = async () => {
      await callTool(tools, "propose_email", { kind: "follow_up" }, "x", f.ctx);
      const a = f.asked.at(-1);
      assert.ok(a);
      return a.id;
    };
    const deps = { memory: f.memory, actions: f.actions, now: NOW };
    assert.equal(await decideApproval(deps, await ask(), false), "OK, I won't send it.");
    const late = { ...deps, now: () => new Date("2026-11-27T12:00:01Z") };
    assert.match(await decideApproval(late, await ask(), true), /expired/);

    const paused = { ...deps, actions: { ...f.actions, paused: () => true } };
    const id = await ask();
    assert.match(await decideApproval(paused, id, true), /\/resume/);
    assert.equal(f.memory.getApproval(id)?.status, "pending");
    const moved = { ...deps, actions: { ...f.actions, airline: { ...f.actions.airline, email: "new@airline.example" } } };
    assert.match(await decideApproval(moved, id, true), /changed/);
    assert.equal(f.memory.getApproval(id)?.status, "stale");
    assert.equal(f.sent.length, 0);
    assert.match(await decideApproval(deps, "unknown-id-0", true), /already handled/);
  });

  it("never asks for money the regulation does not give, at proposal or at the tap", async () => {
    const f = await filed();
    await callTool(tools, "propose_email", { kind: "follow_up" }, "x", f.ctx);
    const a = f.asked[0];
    assert.ok(a);
    // a later compute_compensation finds an exception, so the amount drops to EUR 0
    const reroute = { departure: "2026-11-24T06:00:00Z", arrival: "2026-11-24T09:00:00Z" };
    const later = await callTool(tools, "compute_compensation", { operatedByEuCarrier: true, reroute }, "x", f.ctx);
    assert.ok(later.ok, JSON.stringify(later));
    assert.match(await decideApproval({ memory: f.memory, actions: f.actions, now: NOW }, a.id, true), /changed/);
    assert.equal(f.sent.length, 0);
    const none = await callTool(tools, "propose_email", { kind: "follow_up" }, "x", f.ctx);
    assert.ok(!none.ok && none.error.includes("nothing to claim"), JSON.stringify(none));
    assert.equal(f.asked.length, 1);
  });

  it("sends nothing at the tap once Article 3(1)(b) is unconfirmed, even with the same amount", async () => {
    const s = setup();
    s.memory.updateFacts(s.caseId, { from: "LHR", claimRef: "DA-141262" });
    const checked = await callTool(tools, "compute_compensation", { operatedByEuCarrier: true, receivedBenefitsCompensationAndAssistanceInThirdCountry: false }, "x", s.ctx);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.ok((await callTool(tools, "propose_email", { kind: "follow_up" }, "x", s.ctx)).ok);
    const a = s.asked[0];
    assert.ok(a);
    // a later run drops the answer about benefits outside the EU: same amount, now unconfirmed
    const unsure = await callTool(tools, "compute_compensation", { operatedByEuCarrier: true }, "x", s.ctx);
    assert.ok(unsure.ok && (unsure.value as { unconfirmed: string | null; compensationEur: number }).unconfirmed === "art3.1b");
    assert.equal((unsure.value as { compensationEur: number }).compensationEur, (checked.value as { compensationEur: number }).compensationEur);
    assert.match(await decideApproval({ memory: s.memory, actions: s.actions, now: NOW }, a.id, true), /changed/);
    assert.equal(s.sent.length, 0);
  });

  it("marks a failed send and tells the owner nothing went out", async () => {
    const f = await filed({ sendFails: true });
    await callTool(tools, "propose_email", { kind: "follow_up" }, "x", f.ctx);
    const a = f.asked[0];
    assert.ok(a);
    assert.match(await decideApproval({ memory: f.memory, actions: f.actions, now: NOW }, a.id, true), /nothing went out/);
    assert.equal(f.memory.getApproval(a.id)?.status, "failed");
  });
});
