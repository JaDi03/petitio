import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatResponse, Message } from "ollama";

import type { ChatClient } from "./loop.js";
import { openMemory } from "./memory/store.js";
import { MAX_UPDATE_CHARS, createRunner } from "./runner.js";

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
      reply({ content: "x".repeat(MAX_UPDATE_CHARS + 200) }),
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
    assert.equal(sent[1], "Official weather at LFPG, 2 reports: observed: -SHRA, visibility at least 10 km.");
    const update = sent[2] ?? "";
    assert.equal(update.length, MAX_UPDATE_CHARS);
    assert.ok(update.endsWith("…"));
    assert.equal(logs.filter((l) => l.startsWith("🤔")).length, 1);
    assert.ok(!logs.some((l) => l.includes("no reason given")));
    assert.ok(logs.some((l) => l.startsWith("💬 full update:")));
  });
});
