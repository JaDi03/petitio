import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { findAirport } from "./airports.js";
import { assessCancellation, band, greatCircleKm, type CancellationInput } from "./eu261.js";
import { LAW, isLawRef, type LawRef } from "./law.js";

const H = 3_600_000;
const D = 24 * H;
const dep = new Date("2026-11-20T08:00:00Z");
const arr = new Date("2026-11-20T10:00:00Z");

function input(over: Partial<CancellationInput> = {}): CancellationInput {
  return {
    from: "CDG",
    to: "MAD",
    operatedByEuCarrier: true,
    scheduledDeparture: dep,
    scheduledArrival: arr,
    noticeAt: new Date(dep.getTime() - 3 * D),
    ...over,
  };
}

describe("greatCircleKm", () => {
  it("measures one degree of latitude as about 111.19 km", () => {
    const a = { icao: "X", iata: "X", name: "", country: "", lat: 0, lon: 0 };
    const km = greatCircleKm(a, { ...a, lat: 1 });
    assert.ok(Math.abs(km - 111.19) < 0.01, String(km));
  });
});

describe("assessCancellation scope and bands", () => {
  it("short intra-EU flight with late notice is band (a), 250 EUR", () => {
    const r = assessCancellation(input());
    assert.equal(r.inScope, true);
    assert.equal(r.band, "a");
    assert.ok(r.distanceKm < 1500);
    assert.equal(r.compensationEur, 250);
    assert.equal(r.exception, null);
  });

  it("intra-EU flight over 1500 km is band (b), 400 EUR", () => {
    const r = assessCancellation(input({ from: "LIS", to: "BER" }));
    assert.equal(r.intraCommunity, true);
    assert.ok(r.distanceKm > 1500);
    assert.equal(r.band, "b");
    assert.equal(r.compensationEur, 400);
  });

  it("long flight from the EU to a third country is band (c), 600 EUR", () => {
    const r = assessCancellation(input({ from: "CDG", to: "JFK" }));
    assert.ok(r.distanceKm > 3500);
    assert.equal(r.band, "c");
    assert.equal(r.compensationEur, 600);
  });

  it("flight from a third country into the EU is covered only with a Community carrier", () => {
    assert.equal(assessCancellation(input({ from: "LOS", to: "CDG", operatedByEuCarrier: false })).inScope, false);
    const r = assessCancellation(input({ from: "LOS", to: "CDG", operatedByEuCarrier: true }));
    assert.equal(r.inScope, true);
    assert.equal(r.compensationEur, 600);
  });

  it("flight between two non-EU airports is out of scope", () => {
    const r = assessCancellation(input({ from: "LHR", to: "JFK" }));
    assert.equal(r.inScope, false);
    assert.equal(r.compensationEur, 0);
  });

  it("rejects an unknown airport", () => {
    assert.throws(() => assessCancellation(input({ from: "ZZZ" })), /unknown airport/);
  });
});

describe("assessCancellation Art. 5(1)(c) exceptions", () => {
  it("(i) notice of two weeks or more removes compensation", () => {
    const r = assessCancellation(input({ noticeAt: new Date(dep.getTime() - 14 * D) }));
    assert.equal(r.exception, "i");
    assert.equal(r.compensationEur, 0);
  });

  it("(ii) 7 to 14 days notice with close re-routing removes compensation", () => {
    const r = assessCancellation(
      input({
        noticeAt: new Date(dep.getTime() - 10 * D),
        reroute: { departure: new Date(dep.getTime() - 2 * H), arrival: new Date(arr.getTime() + 3.9 * H) },
      }),
    );
    assert.equal(r.exception, "ii");
  });

  it("(ii) does not apply when re-routing arrives four hours late or more", () => {
    const r = assessCancellation(
      input({
        noticeAt: new Date(dep.getTime() - 10 * D),
        reroute: { departure: dep, arrival: new Date(arr.getTime() + 4 * H) },
      }),
    );
    assert.equal(r.exception, null);
    assert.equal(r.compensationEur, 250);
    assert.equal(r.reducibleToEur, null);
  });

  it("(iii) under 7 days notice with very close re-routing removes compensation", () => {
    const r = assessCancellation(
      input({ reroute: { departure: new Date(dep.getTime() - 0.5 * H), arrival: new Date(arr.getTime() + 1 * H) } }),
    );
    assert.equal(r.exception, "iii");
  });

  it("(iii) does not apply when re-routing departs more than one hour early, and Art. 7(2) halves", () => {
    const r = assessCancellation(
      input({ reroute: { departure: new Date(dep.getTime() - 2 * H), arrival: new Date(arr.getTime() + 1.5 * H) } }),
    );
    assert.equal(r.exception, null);
    assert.equal(r.compensationEur, 250);
    assert.equal(r.reducibleToEur, 125);
    assert.ok(r.refs.includes("art7.2"));
  });
});

describe("boundaries", () => {
  it("Art. 7(1) bands at 1500 and 3500 km, intra-EU over 3500 km stays (b)", () => {
    assert.equal(band(1500, false), "a");
    assert.equal(band(1500.4, false), "b");
    assert.equal(band(3500, false), "b");
    assert.equal(band(3500.1, false), "c");
    assert.equal(band(4000, true), "b");
  });

  it("exactly 7 days of notice falls under (ii), not (iii)", () => {
    const r = assessCancellation(
      input({
        noticeAt: new Date(dep.getTime() - 7 * D),
        reroute: { departure: new Date(dep.getTime() - 1.5 * H), arrival: new Date(arr.getTime() + 3 * H) },
      }),
    );
    assert.equal(r.exception, "ii");
  });

  it("just under 14 days without re-routing keeps compensation", () => {
    const r = assessCancellation(input({ noticeAt: new Date(dep.getTime() - 14 * D + 1) }));
    assert.equal(r.exception, null);
    assert.equal(r.compensationEur, 250);
  });

  it("(iii) needs arrival less than two hours late; exactly two hours keeps compensation", () => {
    const r = assessCancellation(
      input({ reroute: { departure: new Date(dep.getTime() - H), arrival: new Date(arr.getTime() + 2 * H) } }),
    );
    assert.equal(r.exception, null);
    assert.equal(r.reducibleToEur, 125);
  });

  it("Art. 7(2) uses the band window: (c) allows four hours", () => {
    const r = assessCancellation(
      input({ to: "JFK", reroute: { departure: new Date(dep.getTime() - 3 * H), arrival: new Date(arr.getTime() + 4 * H) } }),
    );
    assert.equal(r.compensationEur, 600);
    assert.equal(r.reducibleToEur, 300);
  });

  it("rejects invalid dates", () => {
    assert.throws(() => assessCancellation(input({ noticeAt: new Date("not a date") })), /invalid date/);
  });
});

describe("Art. 3(1)(b) third-country departures", () => {
  it("marks the benefits condition as unconfirmed when unknown", () => {
    const r = assessCancellation(input({ from: "LOS", to: "CDG" }));
    assert.equal(r.inScope, true);
    assert.equal(r.unconfirmed, "art3.1b");
  });

  it("is out of scope when benefits were received in the third country", () => {
    const r = assessCancellation(input({ from: "LOS", to: "CDG", receivedBenefitsInThirdCountry: true }));
    assert.equal(r.inScope, false);
  });

  it("is confirmed when no benefits were received", () => {
    const r = assessCancellation(input({ from: "LOS", to: "CDG", receivedBenefitsInThirdCountry: false }));
    assert.equal(r.unconfirmed, null);
    assert.equal(r.compensationEur, 600);
  });
});

describe("law references", () => {
  const official = readFileSync(new URL("./regulation-261-2004.txt", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("every quoted passage appears word for word in the official text", () => {
    for (const ref of Object.keys(LAW) as LawRef[]) {
      for (const part of LAW[ref].split("[...]")) {
        const needle = part.replace(/\s+/g, " ").trim();
        assert.ok(official.includes(needle), `${ref}: "${needle.slice(0, 60)}..." not found`);
      }
    }
  });

  it("a full compensation result cites Art. 7 passages that exist", () => {
    const r = assessCancellation(
      input({ reroute: { departure: new Date(dep.getTime() - 2 * H), arrival: new Date(arr.getTime() + H) } }),
    );
    assert.equal(r.exception, null);
    assert.ok(r.refs.includes("art7.1") && r.refs.includes("art7.2"));
    for (const ref of r.refs) assert.ok(isLawRef(ref), ref);
  });

  it("airport lookup accepts IATA and ICAO codes", () => {
    assert.equal(findAirport("cdg")?.icao, "LFPG");
    assert.equal(findAirport("LFPG")?.iata, "CDG");
  });
});
