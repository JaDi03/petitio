import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { afterTool, evidence } from "./narrate.js";
import { decodeMetar } from "./tools/weather.js";

describe("evidence", () => {
  it("records the station, window and observed values of a weather check", () => {
    const reports = [
      decodeMetar("2026-11-20T07:00:00Z", "LFPG 200700Z 23018KT 9999 BKN025 11/07 Q1001 TEMPO 24015G35KT"),
      decodeMetar("2026-11-20T07:30:00Z", "LFPG 200730Z 24016KT 6000 -SHRA BKN020 10/08 Q1000"),
    ];
    const line = evidence("get_metar", { icao: "LFPG", from: "2026-11-20T06:00:00Z", to: "2026-11-20T09:00:00Z", reports });
    assert.equal(line, "weather LFPG 2026-11-20T06:00:00Z to 2026-11-20T09:00:00Z: 2 METAR reports, observed weather: -SHRA, max wind 18 kt, min visibility 6000 m, lowest ceiling 2000 ft");
  });

  it("records the amount and whether it can be reduced", () => {
    assert.equal(evidence("compute_compensation", { inScope: true, exception: null, distanceKm: 1062.5, compensationEur: 250, reducibleToEur: null, reroute: null }), "compensation: 1062.5 km, 250 EUR due, not reducible because no alternative flight was given for this check");
    assert.equal(evidence("compute_compensation", { inScope: true, exception: null, distanceKm: 1062.5, compensationEur: 250, reducibleToEur: null, reroute: { lateByH: 5, limitH: 2 } }), "compensation: 1062.5 km, 250 EUR due, not reducible because the alternative flight arrives 5 h after the scheduled arrival, Art. 7(2) limit 2 h");
    assert.equal(evidence("compute_compensation", { inScope: true, exception: null, distanceKm: 1062.5, compensationEur: 250, reducibleToEur: 125, reroute: { lateByH: 1.5, limitH: 2 } }), "compensation: 1062.5 km, 250 EUR due, reducible to 125 EUR because the alternative flight arrives 1.5 h after the scheduled arrival, Art. 7(2) limit 2 h");
    assert.equal(evidence("record_facts", { ok: true }), null);
  });
});

describe("conditional compensation", () => {
  it("never states an amount as due while Art. 3(1)(b) is unconfirmed", () => {
    const value = { inScope: true, exception: null, distanceKm: 5837, compensationEur: 600, reducibleToEur: null, reroute: null, unconfirmed: "art3.1b" };
    const line = afterTool("compute_compensation", true, value) ?? "";
    const proof = evidence("compute_compensation", value) ?? "";
    for (const text of [line, proof]) {
      assert.match(text, /600 EUR/);
      assert.match(text, /Art\. 3\(1\)\(b\)/);
      assert.match(text, /not confirmed/);
      assert.match(text, /unless .*benefits or compensation .*assistance/);
    }
    assert.match(afterTool("compute_compensation", true, { ...value, unconfirmed: "art3.2x" }) ?? "", /not confirmed/);
  });
});
