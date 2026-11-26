// Short human lines built from real tool data, so progress updates never depend on what the model writes.

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function afterTool(tool: string, ok: boolean, value: unknown): string | null {
  if (!ok) return null;
  const v = obj(value);
  if (tool === "get_metar") {
    const reports = Array.isArray(v.reports) ? v.reports.map(obj) : [];
    const at = typeof v.icao === "string" ? ` at ${v.icao}` : "";
    if (reports.length === 0) return `No official weather reports found${at} for that window.`;
    const phenomena = [...new Set(reports.flatMap((r) => (Array.isArray(r.phenomena) ? r.phenomena.map(String) : [])))];
    const vis = reports.map((r) => r.visibilityM).filter((x): x is number => typeof x === "number");
    const minVisKm = vis.length > 0 ? Math.min(...vis) / 1000 : null;
    const weather = phenomena.length > 0 ? `observed: ${phenomena.join(", ")}` : "no storm, snow or fog observed";
    return `Official weather${at}, ${String(reports.length)} reports: ${weather}${minVisKm === null ? "" : `, visibility at least ${String(minVisKm)} km`}.`;
  }
  if (tool === "compute_compensation") {
    if (v.inScope === false) return "This flight is outside EU Regulation 261/2004.";
    if (typeof v.exception === "string") return `The regulation's exception (${v.exception}) applies, so no compensation is due.`;
    return `${String(v.distanceKm)} km flight: ${String(v.compensationEur)} EUR is due.`;
  }
  return null;
}

function nums(rows: Record<string, unknown>[], key: string): number[] {
  return rows.map((r) => r[key]).filter((x): x is number => typeof x === "number");
}

// a case-file record of what a tool returned, so later runs reuse checked data instead of earlier prose
export function evidence(tool: string, value: unknown): string | null {
  const v = obj(value);
  if (tool === "get_metar") {
    const reports = Array.isArray(v.reports) ? v.reports.map(obj) : [];
    const window = `${String(v.icao)} ${String(v.from)} to ${String(v.to)}`;
    if (reports.length === 0) return `weather ${window}: no METAR reports`;
    const phenomena = [...new Set(reports.flatMap((r) => (Array.isArray(r.phenomena) ? r.phenomena.map(String) : [])))];
    const wind = nums(reports, "windKt");
    const gust = nums(reports, "gustKt");
    const vis = nums(reports, "visibilityM");
    const ceiling = nums(reports, "ceilingFt");
    const parts = [
      `${String(reports.length)} METAR reports`,
      `observed weather: ${phenomena.length > 0 ? phenomena.join(" ") : "none"}`,
      wind.length > 0 ? `max wind ${String(Math.max(...wind))} kt` : null,
      gust.length > 0 ? `max gust ${String(Math.max(...gust))} kt` : null,
      vis.length > 0 ? `min visibility ${String(Math.min(...vis))} m` : null,
      ceiling.length > 0 ? `lowest ceiling ${String(Math.min(...ceiling))} ft` : null,
      reports.some((r) => r.cumulonimbus === true) ? "cumulonimbus reported" : null,
    ];
    return `weather ${window}: ${parts.filter((p) => p !== null).join(", ")}`;
  }
  if (tool === "compute_compensation") {
    if (v.inScope === false) return "compensation: outside EU Regulation 261/2004";
    if (typeof v.exception === "string") return `compensation: exception ${v.exception} applies, nothing due`;
    const reducible = typeof v.reducibleToEur === "number" ? `, reducible to ${String(v.reducibleToEur)} EUR` : ", not reducible";
    return `compensation: ${String(v.distanceKm)} km, ${String(v.compensationEur)} EUR due${reducible}`;
  }
  if (tool === "get_law" && typeof v.ref === "string") return `law: read ${v.ref}`;
  return null;
}
