// "Use my real numbers": an owner's own energy data replaces the public-data model for their
// building. Everything here runs in the browser and is saved only in this browser's localStorage.

import { gridVal, demandAt, srcKey } from "./econ.js";

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const KEY = "heatmatch.owner.v1";

// kBtu per unit
export const UNITS = {
  therms: { kbtu: 100, label: "therms" },
  ccf: { kbtu: 102.6, label: "ccf (100 cu ft of gas)" },
  MMBtu: { kbtu: 1000, label: "MMBtu / dekatherms" },
  kBtu: { kbtu: 1, label: "kBtu" },
  Mlb: { kbtu: 1194, label: "Mlb (1,000 lb of steam)" },
  gallons: { kbtu: 138.6, label: "gallons of heating oil" },
  kWh: { kbtu: 3.412, label: "kWh" },
  MWh: { kbtu: 3412, label: "MWh" },
};
export const FUEL_UNITS = { gas: ["therms", "ccf", "MMBtu", "kBtu"], steam: ["Mlb", "MMBtu", "kBtu"], oil: ["gallons", "MMBtu", "kBtu"] };
export const IT_HEAT_FACTOR = 1.2; // condenser heat = IT load + chiller work (same as the pipeline)

// --- storage ---------------------------------------------------------------------

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep it in memory only */ }
}
export const loadOwner = () => read(KEY);
export const saveOwner = (records) => write(KEY, records);

// --- turning a record into grids --------------------------------------------------

const monthSum = (arr, m) => { let s = 0; for (let h = 0; h < 24; h++) s += arr[m * 24 + h]; return s * DAYS[m]; };
const pack = (raw) => { const mx = Math.max(...raw, 0); return [mx > 0 ? raw.map((v) => (v / mx) * 999) : raw.map(() => 0), mx]; };

// record: { kind: "dc", itKw } or { kind: "sink", fuel, unit, monthly[12] (null = unknown), annual, pricePerUnit }
// Returns patches for the building and its grids, or { error }.
export function buildOverride(b, g, A, rec) {
  if (rec.kind === "dc") {
    if (!(rec.itKw > 0)) return { error: "Enter your average IT load." };
    const heatKbtu = rec.itKw * 8760 * 3.412 * IT_HEAT_FACTOR;
    const perHour = ((heatKbtu / 8760) * A.capture_eff) / (1 - 1 / A.hp_cop); // heat a heat pump can deliver
    return {
      building: { dc_heat_mmbtu: Math.round(heatKbtu / 1000), dc_measured: true },
      grid: { dc: new Array(288).fill(999), dc_max: perHour },
      summary: { yours: heatKbtu / 1000, model: b.dc_heat_mmbtu, what: "IT heat" },
    };
  }

  const fuel = A.fuels[rec.fuel];
  const unit = UNITS[rec.unit];
  if (!fuel || !unit) return { error: "Choose a fuel and a unit." };
  const months = (rec.monthly || []).map((v) => (v == null || v === "" || !isFinite(+v) ? null : Math.max(0, +v)));
  const known = months.map((v, m) => (v == null ? -1 : m)).filter((m) => m >= 0);
  if (!known.length && !(rec.annual > 0)) return { error: "Enter monthly amounts or an annual total." };

  // the model's own profile for this building, as raw kBtu/h by month and hour
  const dhw0 = Array.from({ length: 288 }, (_, i) => gridVal(g, "dhw", i));
  const space0 = Array.from({ length: 288 }, (_, i) => gridVal(g, "space", i));
  const model = DAYS.map((_, m) => monthSum(dhw0, m) + monthSum(space0, m)); // useful heat per month
  const modelTotal = model.reduce((a, c) => a + c, 0) || 1;

  // useful heat per month from the owner's fuel (fuel energy x boiler/steam efficiency)
  const toUseful = unit.kbtu * fuel.eff;
  let useful;
  if (known.length) {
    const ratio = known.reduce((s, m) => s + months[m] * toUseful, 0) / (known.reduce((s, m) => s + model[m], 0) || 1);
    useful = months.map((v, m) => (v == null ? model[m] * ratio : v * toUseful)); // unknown months follow the model's shape
  } else {
    useful = model.map((v) => (v / modelTotal) * rec.annual * toUseful);
  }

  // summer floor = hot water (runs all year); what's above it in winter = space heat
  const rate = [5, 6, 7].map((m) => useful[m] / DAYS[m]);
  const ref = 5 + rate.indexOf(Math.min(...rate));
  const dhwM = DAYS.map((_, m) => monthSum(dhw0, m));
  const dhw = useful.map((u, m) => Math.min(u, dhwM[ref] > 0 ? (useful[ref] * dhwM[m]) / dhwM[ref] : (useful[ref] / DAYS[ref]) * DAYS[m]));
  const space = useful.map((u, m) => u - dhw[m]);

  // keep each month's hour-by-hour shape from the model, rescaled to the owner's monthly totals
  const reshape = (base, totals) => {
    const out = new Array(288);
    for (let m = 0; m < 12; m++) {
      const s = monthSum(base, m);
      for (let h = 0; h < 24; h++) out[m * 24 + h] = s > 0 ? (base[m * 24 + h] * totals[m]) / s : totals[m] / (24 * DAYS[m]);
    }
    return out;
  };
  const [dhwG, dhwMax] = pack(reshape(dhw0, dhw));
  const [spaceG, spaceMax] = pack(reshape(space0, space));
  const fuelKbtu = useful.reduce((a, c) => a + c, 0) / fuel.eff;
  const price = rec.pricePerUnit > 0 ? rec.pricePerUnit / unit.kbtu : fuel.usd_per_kbtu;
  return {
    building: { fuel: rec.fuel, heat_kbtu: Math.round(fuelKbtu), usd_per_kbtu: price / fuel.eff, t_per_kbtu: fuel.t_per_kbtu / fuel.eff },
    grid: { dhw: dhwG, dhw_max: dhwMax, space: spaceG, space_max: spaceMax },
    summary: { yours: fuelKbtu / 1000, model: b.heat_kbtu / 1000, what: "heating fuel" },
  };
}

// --- re-scoring pairs ---------------------------------------------------------------

// A pair's heat numbers from the typical-day grids (month x hour), for both heat modes.
function gridScore(p, grids) {
  const gs = grids[p.s], gk = grids[p.k];
  const out = { avail: 0, dhw: { dem: 0, match: 0, peak: 0 }, all: { dem: 0, match: 0, peak: 0 } };
  for (let m = 0; m < 12; m++)
    for (let h = 0; h < 24; h++) {
      const i = m * 24 + h, a = gridVal(gs, srcKey(p.track), i);
      out.avail += a * DAYS[m];
      for (const mode of ["dhw", "all"]) {
        const d = demandAt(gk, mode, i), x = Math.min(a, d);
        out[mode].dem += d * DAYS[m];
        out[mode].match += x * DAYS[m];
        out[mode].peak = Math.max(out[mode].peak, x);
      }
    }
  return out;
}

// The pipeline scored each pair hour by hour over a full year. To apply an owner's data we scale
// those results by how much the typical-day score changes, which keeps that hourly detail.
function rescore(p, rawGrids, grids, storages) {
  const a = gridScore(p, rawGrids), b = gridScore(p, grids);
  const scale = (orig, was, now) => (was > 0 ? orig * (now / was) : now);
  const q = { ...p, _owner: true, _orig: p, avail: scale(p.avail, a.avail, b.avail) };
  for (const mode of ["dhw", "all"]) {
    q[`demand_${mode}`] = scale(p[`demand_${mode}`], a[mode].dem, b[mode].dem);
    const cap = Math.min(q.avail, q[`demand_${mode}`]);
    for (const h of storages) {
      q[`matched_${mode}_${h}`] = Math.min(cap, scale(p[`matched_${mode}_${h}`], a[mode].match, b[mode].match));
      q[`peak_${mode}_${h}`] = scale(p[`peak_${mode}_${h}`], a[mode].peak, b[mode].peak);
    }
    q[`coincidence_${mode}`] = cap > 0 ? Math.min(1, q[`matched_${mode}_0`] / cap) : 0;
    q[`coverage_${mode}`] = q[`demand_${mode}`] > 0 ? Math.min(1, q[`matched_${mode}_0`] / q[`demand_${mode}`]) : 0;
  }
  return q;
}

// Apply every saved owner record. Returns the same objects untouched when there is nothing to apply.
export function applyOwner(data, grids, records) {
  const ids = Object.keys(records || {}).map(Number).filter((id) => data?.buildings.has(id));
  if (!data || !grids || !ids.length) return { data, grids };
  const A = data.summary.assumptions;
  const buildings = new Map(data.buildings);
  const newGrids = { ...grids };
  const dcIds = new Set(), sinkIds = new Set();
  for (const id of ids) {
    const rec = records[id], b = data.buildings.get(id);
    const o = buildOverride(b, grids[id] || {}, A, rec);
    if (o.error) continue;
    buildings.set(id, { ...b, ...o.building, _owner: rec, _ownerSummary: o.summary });
    newGrids[id] = { ...grids[id], ...o.grid };
    (rec.kind === "dc" ? dcIds : sinkIds).add(id);
  }
  const pairs = data.pairs.map((p) =>
    (p.track === "dc" && dcIds.has(p.s)) || sinkIds.has(p.k) ? rescore(p, grids, newGrids, A.storage_hours) : p);
  return { data: { ...data, buildings, pairs, pairById: new Map(pairs.map((p) => [p.id, p])), raw: data }, grids: newGrids };
}

// --- offline CSV reading (when the AI reader isn't available) -------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Finds a date/month column and a usage column in a simple CSV and adds usage up by month.
export function parseCsvUsage(text) {
  const rows = text.trim().split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, "")));
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.toLowerCase());
  const usageCol = head.findIndex((h) => /usage|consumption|therm|ccf|kwh|mlb|quantity|used/.test(h));
  const dateCol = head.findIndex((h) => /month|date|from|start|period/.test(h));
  if (usageCol < 0 || dateCol < 0) return null;
  const monthly = new Array(12).fill(null);
  for (const r of rows.slice(1)) {
    const v = parseFloat(String(r[usageCol]).replace(/[$,]/g, ""));
    if (!isFinite(v)) continue;
    const d = String(r[dateCol]).toLowerCase();
    let m = MONTHS.findIndex((name) => d.includes(name));
    if (m < 0) { const dt = new Date(r[dateCol]); if (!isNaN(dt)) m = dt.getMonth(); }
    if (m >= 0) monthly[m] = (monthly[m] || 0) + v;
  }
  if (monthly.every((v) => v == null)) return null;
  const h = head[usageCol];
  const unit = /therm/.test(h) ? "therms" : /ccf/.test(h) ? "ccf" : /mlb/.test(h) ? "Mlb" : /mwh/.test(h) ? "MWh" : /kwh/.test(h) ? "kWh" : null;
  return { monthly, unit, notes: "Read without AI: months are taken from the first date column as written. Check every value." };
}
