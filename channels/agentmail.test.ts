import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyEmail } from "./agentmail.js";

const owners = new Set(["owner@example.com"]);

function received(from: string): unknown {
  return { event_type: "message.received", event_id: "e1", message: { inbox_id: "petitio@agentmail.to", from, subject: "s", text: "t" } };
}

function kind(from: string): string {
  return classifyEmail(received(from), "petitio@agentmail.to", owners).kind;
}

describe("sender check", () => {
  it("tells the owner from the configured airline, and the airline is never the owner", () => {
    const owner = classifyEmail(received("owner@example.com"), "petitio@agentmail.to", owners, "claims@airline.example");
    assert.equal(owner.kind === "accept" && owner.email.role, "owner");
    const airline = classifyEmail(received("Demo Air <Claims@Airline.example>"), "petitio@agentmail.to", owners, "claims@airline.example");
    assert.equal(airline.kind === "accept" && airline.email.role, "airline");
    assert.equal(classifyEmail(received("claims@airline.example"), "petitio@agentmail.to", owners).kind, "ignore");
    assert.equal(classifyEmail(received("claims@airline.example.evil"), "petitio@agentmail.to", owners, "claims@airline.example").kind, "ignore");
  });

  it("accepts the owner's own address, with or without a display name", () => {
    assert.equal(kind("owner@example.com"), "accept");
    assert.equal(kind("Owner Name <Owner@Example.com>"), "accept");
    assert.equal(kind("<owner@example.com>"), "accept");
  });

  it("never takes the owner's address from the display name", () => {
    assert.equal(kind('"<owner@example.com>" <attacker@evil.example>'), "ignore");
    assert.equal(kind("<owner@example.com> <attacker@evil.example>"), "ignore");
    assert.equal(kind("owner@example.com <attacker@evil.example>"), "ignore");
  });

  it("refuses ambiguous or multiple senders", () => {
    assert.equal(kind("attacker@evil.example, owner@example.com"), "ignore");
    assert.equal(kind("Owner <owner@example.com> trailing"), "ignore");
    assert.equal(kind("Owner <owner@example.com>>"), "ignore");
    assert.equal(kind("attacker@evil.example, <owner@example.com>"), "ignore");
    assert.equal(kind("group: attacker@evil.example, <owner@example.com>"), "ignore");
    assert.equal(kind("Attacker; <owner@example.com>"), "ignore");
    assert.equal(kind('"Evil" attacker@evil.example <owner@example.com>'), "ignore");
  });

  it("accepts the common display names of a real owner", () => {
    assert.equal(kind('"Last, First" <owner@example.com>'), "accept");
    assert.equal(kind("=?utf-8?Q?Jos=C3=A9?= <owner@example.com>"), "accept");
    assert.equal(kind("José Pérez <owner@example.com>"), "accept");
  });

  it("checks the address before folding its case", () => {
    const kate = new Set(["kate@example.com"]);
    assert.equal(classifyEmail(received("Kate <Kate@example.com>"), "petitio@agentmail.to", kate).kind, "ignore");
    assert.equal(classifyEmail(received("Kate <Kate@example.com>"), "petitio@agentmail.to", kate).kind, "accept");
  });
});
