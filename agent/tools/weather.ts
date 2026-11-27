import { z } from "zod";

import { findAirport } from "../knowledge/eu261/airports.js";
import { defineTool } from "./tool.js";

// Iowa Environmental Mesonet ASOS/METAR archive: https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help
const IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const MAX_WINDOW_H = 48;
const MAX_REPORTS = 100;

export interface DecodedMetar {
  time: string;
  raw: string;
  windKt: number | null;
  gustKt: number | null;
  visibilityM: number | null;
  // lowest visibility in one direction, reported after the prevailing value (e.g. "0650 0300")
  minVisibilityM: number | null;
  phenomena: string[];
  ceilingFt: number | null;
  cumulonimbus: boolean;
  // TEMPO/BECMG trend: what forecasters expected might happen, not what was observed
  forecastTrend: string | null;
}

const WX = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+$/;
const WX_DESCRIPTOR_ONLY = /^(\+|-|VC)?(TS|SH)$/;

export function decodeMetar(time: string, raw: string): DecodedMetar {
  const out: DecodedMetar = { time, raw, windKt: null, gustKt: null, visibilityM: null, minVisibilityM: null, phenomena: [], ceilingFt: null, cumulonimbus: false, forecastTrend: null };
  // TEMPO and BECMG groups are forecasts, not observations
  const trendAt = raw.search(/\s(?:TEMPO|BECMG)\b/);
  const observed = (trendAt === -1 ? raw : raw.slice(0, trendAt)).replace(/\sNOSIG\b.*$/, "");
  if (trendAt !== -1) out.forecastTrend = raw.slice(trendAt).trim();
  for (const tok of observed.split(/\s+/).slice(2)) {
    const wind = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(tok);
    if (wind) {
      out.windKt = Number(wind[2]);
      out.gustKt = wind[3] ? Number(wind[3]) : null;
      continue;
    }
    if (tok === "CAVOK") {
      out.visibilityM = 10000;
      continue;
    }
    if (/^\d{4}$/.test(tok) && out.visibilityM === null) {
      out.visibilityM = tok === "9999" ? 10000 : Number(tok);
      continue;
    }
    const minVis = /^(\d{4})(?:N|NE|E|SE|S|SW|W|NW)?$/.exec(tok);
    if (minVis && out.visibilityM !== null && out.minVisibilityM === null) {
      out.minVisibilityM = Number(minVis[1]);
      continue;
    }
    const cloud = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(tok);
    if (cloud) {
      const base = Number(cloud[2]) * 100;
      if ((cloud[1] === "BKN" || cloud[1] === "OVC" || cloud[1] === "VV") && (out.ceilingFt === null || base < out.ceilingFt)) {
        out.ceilingFt = base;
      }
      if (cloud[3] === "CB") out.cumulonimbus = true;
      continue;
    }
    if (WX.test(tok) || WX_DESCRIPTOR_ONLY.test(tok)) out.phenomena.push(tok);
  }
  return out;
}

function parseCsv(text: string, icao: string): { time: string; raw: string }[] {
  const rows: { time: string; raw: string }[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [station, valid, ...rest] = line.split(",");
    const raw = rest.join(",").trim();
    if (station !== icao || !valid || !raw || raw === "M") continue;
    rows.push({ time: `${valid.replace(" ", "T")}:00Z`, raw });
  }
  return rows;
}

const iso = z.iso.datetime();

export const getMetar = defineTool({
  name: "get_metar",
  description:
    "Get the official airport weather observations (METAR) for an ICAO airport between two UTC times (at most 48 hours). Returns raw reports and the decoded OBSERVED wind, gusts, visibility, ceiling and weather phenomena such as TS (thunderstorm), SN (snow) or FG (fog). forecastTrend holds TEMPO/BECMG text: a forecast of what might happen, never an observation.",
  schema: z
    .object({
      icao: z.string().regex(/^[A-Z]{3,4}$/).describe("ICAO airport code, for example LFPG (a known IATA code such as CDG also works)"),
      from: iso,
      to: iso,
    })
    .strict()
    .refine((a) => Date.parse(a.to) > Date.parse(a.from), { error: "to must be after from" })
    .refine((a) => Date.parse(a.to) - Date.parse(a.from) <= MAX_WINDOW_H * 3_600_000, { error: "window over 48 hours" }),
  async run({ icao: code, from, to }, ctx) {
    // the weather archive only knows ICAO stations, so a 3-letter code must be one we know
    const icao = code.length === 4 ? code : findAirport(code)?.icao;
    if (!icao) throw new Error(`unknown IATA code ${code}: use the 4-letter ICAO code`);
    const url = new URL(IEM_URL);
    const params: [string, string][] = [
      ["station", icao], ["data", "metar"], ["sts", from], ["ets", to], ["tz", "Etc/UTC"], ["format", "onlycomma"],
      ["latlon", "no"], ["missing", "M"], ["trace", "T"], ["direct", "no"], ["report_type", "3"], ["report_type", "4"],
    ];
    for (const [k, v] of params) url.searchParams.append(k, v);
    const res = await ctx.fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`weather archive HTTP ${String(res.status)}`);
    const reports = parseCsv(await res.text(), icao).slice(0, MAX_REPORTS).map((r) => decodeMetar(r.time, r.raw));
    return { icao, from, to, source: "Iowa Environmental Mesonet METAR archive", count: reports.length, reports };
  },
});
