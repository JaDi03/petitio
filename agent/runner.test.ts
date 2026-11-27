import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatResponse, Message } from "ollama";

import type { ChatClient } from "./loop.js";
import { openMemory } from "./memory/store.js";
import { UnconfirmedClaim, type Actions, type FileClaim } from "./actions.js";
import { MAX_UPDATE_CHARS, createRunner, failureNote, uncheckedMentions } from "./runner.js";

const SAMPLE = [
  "station,valid,metar",
  "LFPG,2026-11-20 07:00,LFPG 200700Z 23018KT 9999 BKN025 11/07 Q1001",
  "LFPG,2026-11-20 07:30,LFPG 200730Z 24016KT 9999 -SHRA BKN020 10/08 Q1000",
].join("\n");

function reply(message: Partial<Message>): ChatResponse {
  return { message: { role: "assistant", content: "", ...message } } as ChatResponse;
}

function scripted(steps: ChatResponse[]): ChatClient {
  return { chat: () => { const next = steps.shift(); return next ? Promise.resolve(next) : Promise.reject(new Error("script exhausted")); } };
}

const window = { from: "2026-11-20T06:00:00Z", to: "2026-11-20T09:00:00Z" };

describe("runner messages to the owner", () => {
  it("sends the ack, one grouped progress line from tool results and a clipped update", async () => {
    const memory = openMemory(":memory:");
    const c = memory.createCase({});
    const sent: string[] = [];
    const logs: string[] = [];
    const client = scripted([
      reply({ thinking: "Save the flight and check the weather.", tool_calls: [
        { function: { name: "record_facts", arguments: { flightNumber: "DA123" } } },
        { function: { name: "get_metar", arguments: { icao: "CDG", ...window } } },
      ] }),
      reply({ tool_calls: [
        { function: { name: "get_metar", arguments: { icao: "LFPG", ...window } } },
        { function: { name: "get_law", arguments: { ref: "art5.3" } } },
      ] }),
      reply({ content: `${"x".repeat(MAX_UPDATE_CHARS + 200)}\n\nShould I reject the voucher?` }),
    ]);
    const runner = createRunner({
      memory,
      client,
      model: "m",
      notify: { send: (t) => { sent.push(t); return Promise.resolve(); }, typing: () => Promise.resolve() },
      log: (l) => { logs.push(l); },
      hold: (_n, w) => w(),
      fetch: () => Promise.resolve(new Response(SAMPLE)),
      maxRunsPerDay: 5,
    });
    await runner.enqueue(c.id, { kind: "email_in", source: "owner forward", body: "cancelled" }, "Got it.");

    assert.equal(sent.length, 3);
    assert.equal(sent[0], "Got it.");
    assert.equal(sent[1], "Official weather at LFPG, 2 reports: observed: -SHRA, lowest visibility 10 km.");
    const update = sent[2] ?? "";
    assert.equal(update.length, MAX_UPDATE_CHARS);
    assert.ok(update.endsWith("…\n\nShould I reject the voucher?"));
    assert.equal(logs.filter((l) => l.startsWith("🤔")).length, 1);
    assert.ok(!logs.some((l) => l.includes("no reason given")));
    assert.ok(logs.some((l) => l.startsWith("💬 full update:")));
  });
});

describe("legal mentions in the owner's update", () => {
  const evidence = [
    "compensation: 2339.6 km, 400 EUR due, not reducible because the alternative flight arrives 4 h after the scheduled arrival, Art. 7(2) limit 3 h",
    "law: read art7.3",
    "Demo Air case DA-141262, EUR 400 claimed",
  ];

  it("accepts articles and amounts the tools returned", () => {
    assert.deepEqual(uncheckedMentions("You are owed 400 EUR (EUR 400). Article 7(3) says cash; Art. 7(2) does not apply.", evidence), []);
  });

  it("names articles and amounts no tool returned", () => {
    assert.deepEqual(
      uncheckedMentions("Under Article 5(3) they must prove it, and you may also get €600 or 250 euros. Art. 14 too.", evidence),
      ["Article 5(3)", "Art. 14", "€600", "250 euros"],
    );
  });
});

describe("what a failed run tells the owner", () => {
  const FACTS = {
    passengerName: "Alex Doe", bookingRef: "AB12CD", flightNumber: "DA456", airline: "Demo Air", from: "FRA", to: "LIS",
    scheduledDeparture: "2026-11-24T06:30:00Z", scheduledArrival: "2026-11-24T09:30:00Z", noticeAt: "2026-11-24T04:00:00Z",
  };

  async function failAfterFiling(fileClaim: FileClaim) {
    const memory = openMemory(":memory:");
    const c = memory.createCase({ ...FACTS });
    const sent: string[] = [];
    // the model files the claim, then its next call fails
    const client = scripted([
      reply({ tool_calls: [{ function: { name: "compute_compensation", arguments: { operatedByEuCarrier: true } } }] }),
      reply({ tool_calls: [{ function: { name: "submit_claim_form", arguments: {} } }] }),
    ]);
    const actions: Actions = {
      airline: { name: "Demo Air", email: "claims@airline.example", formUrl: new URL("https://airline.example/claims") },
      agentInbox: "agent@agentmail.to",
      paused: () => false,
      fileClaim,
      tellOwner: () => Promise.resolve(),
      askOwner: () => Promise.resolve(),
      sendEmail: () => Promise.resolve(),
    };
    const runner = createRunner({
      memory, client, model: "m", actions, log: () => undefined, hold: (_n, w) => w(), maxRunsPerDay: 5,
      fetch: () => Promise.reject(new Error("network not allowed in tests")),
      notify: { send: (t) => { sent.push(t); return Promise.resolve(); }, typing: () => Promise.resolve() },
    });
    await runner.enqueue(c.id, { kind: "email_in", source: "owner forward", body: "cancelled" }, "Got it.");
    return sent.at(-1) ?? "";
  }

  it("never says nothing was sent after the claim form went out", async () => {
    const filed = await failAfterFiling((_u, _f, h) => {
      h.beforeSend();
      return Promise.resolve({ reference: "DA-141262", before: Buffer.from("b"), after: Buffer.from("a") });
    });
    assert.match(filed, /Your claim is filed \(case DA-141262\)/);
    assert.doesNotMatch(filed, /Nothing was sent/);
    const unknown = await failAfterFiling((_u, _f, h) => {
      h.beforeSend();
      return Promise.reject(new UnconfirmedClaim("no case number", []));
    });
    assert.match(unknown, /don't know if the airline got it/);
    assert.match(unknown, /\/filed/);
    assert.doesNotMatch(unknown, /Nothing was sent/);
  });

  it("says nothing was sent only when this run sent nothing", () => {
    const memory = openMemory(":memory:");
    const c = memory.createCase({});
    // an attempt from an earlier run does not count for this one
    memory.addEvent(c.id, "run_start", "email_in");
    memory.addEvent(c.id, "claim_attempt", "sending");
    memory.addEvent(c.id, "claim_refused", "booking reference is required");
    memory.addEvent(c.id, "run_start", "owner_message");
    assert.match(failureNote(memory, c.id), /Nothing was sent to the airline/);
    memory.addEvent(c.id, "claim_attempt", "sending");
    memory.addEvent(c.id, "claim_refused", "booking reference is required");
    assert.match(failureNote(memory, c.id), /did not take the claim, so nothing is filed/);
  });
});
