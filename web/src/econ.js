// Mirrors pipeline/economics.py so the sliders can re-price a pair live in the browser,
// plus a fuller installed-cost range (costRange) that the pipeline's equipment-only number lacks.
import { sizePipe } from "./pipe.js";

// Installed-cost assumptions, [low, base, high]. Screening values, shown to users in the
// "Cost breakdown & assumptions" section; replace with quotes for any real project.
export const COST = {
  tiePerKw: [200, 300, 500], // source tie-in: plate heat exchanger, pumps, controls, per kW of heat carried
  dhwPerKw: [200, 300, 500], // sink hot-water integration (tanks, piping), per kW delivered
  spacePerKw: [300, 400, 600], // sink space-heat integration on a hydronic system, per kW delivered
  steamPerUnit: [6000, 12000, 20000], // steam-heated buildings: per-apartment conversion to low-temp heat
  tankPerKwh: [20, 30, 60], // thermal storage, per kWh of heat stored
  soft: [0.25, 0.3, 0.4], // engineering, permits, construction management (share of hard cost)
  contingency: [0.15, 0.25, 0.35], // share of hard cost
};

// Pipe cost assumptions. The route's street crossings are real (NYC street centerline widths,
// DOT protected streets, MTA subway lines); the dollar rates below are assumptions.
export const PIPE = {
  // Trench cost for a supply+return pair in a paved urban area, by pipe size (DN in mm), EUR per metre.
  // Planning formula from the nPro district-energy tool: 7.96 x DN + 861.
  eurPerM: (dnMm) => 7.96 * dnMm + 861,
  usdPerEur: 1.08,
  nycFactor: 1.35, // NYC construction-cost premium over the formula's basis (assumption)
  privateBand: [0.8, 1, 1.3], // on private property (basements, yards, lot lines)
  streetMult: [2, 3, 4.5], // in a public street: traffic control, night work, crowded utilities, restoration
  sidewalkFt: 13, // sidewalk on each side of a crossed roadway
  crossingFixed: [40_000, 75_000, 150_000], // per street crossed: DOT permits, traffic plan, utility mark-out, test pits
  protectedMult: 1.5, // street repaved in the last 5 years: DOT requires wider restoration
};
// Installed heat-pump cost, $/kW of heat. Published data-center heat-recovery studies use
// EUR 250k-1M per MW (IEA Heat Pump Conference 2026); NYC installed costs sit at the top of that or above.
export const HP_USD_PER_KW = [900, 1500, 2100];

const tidy = (name) => String(name).replace(/\s+/g, " ").trim();
const namesOf = (link) => (link.xnames || []).map(tidy).join(" and ");

// Pipe line items for one link (a pair, or one hop of a chain), each with [low, base, high].
// link: { dist_m, tier, xn, xft, xnames, prot, sub, hwy }. Without crossing data (chain hops),
// the tier decides whether the run is in a street.
export function pipeCost(link, peakKw, A, pipeMult = 1) {
  const lohi = (f) => [0, 1, 2].map(f);
  const { nominalIn } = sizePipe(peakKw, A);
  const perFt = ((PIPE.eurPerM(nominalIn * 25.4) * PIPE.usdPerEur) / 3.28084) * PIPE.nycFactor * pipeMult;
  const distFt = link.dist_m * 3.28084;
  const known = link.xn != null;
  const xn = known ? link.xn : link.tier >= 4 ? 2 : link.tier === 3 ? 1 : 0;
  const streetFt = xn ? Math.min(distFt, known ? link.xft + 2 * PIPE.sidewalkFt * xn : distFt) : 0;
  const privateFt = distFt - streetFt + A.connection_ft;
  const prot = link.prot ? PIPE.protectedMult : 1;
  const items = [{
    label: `Pipe on private property (${Math.round(privateFt)} ft of ${nominalIn}″ supply + return)`,
    v: lohi((i) => privateFt * perFt * PIPE.privateBand[i]),
  }];
  if (xn) {
    const notes = [];
    if (link.prot) notes.push("Repaved in the last 5 years (DOT protected street): wider restoration, priced +50%.");
    if (link.sub) notes.push("A subway line runs along this street: needs MTA review, not priced.");
    if (link.hwy) notes.push("Crosses a highway, bridge or ramp: may not be buildable.");
    if (!known) notes.push("Street crossing assumed from distance; not checked against the street map.");
    items.push({
      label: `Pipe under ${namesOf(link) || (xn > 1 ? `${xn} streets` : "the street")} (${Math.round(streetFt)} ft in the street)`,
      v: lohi((i) => streetFt * perFt * PIPE.streetMult[i] * prot),
      note: notes.join(" ") || null,
    });
    items.push({
      label: `Street permits, traffic control, utility mark-out (${xn} crossing${xn > 1 ? "s" : ""})`,
      v: lohi((i) => xn * PIPE.crossingFixed[i]),
    });
  }
  const total = lohi((i) => items.reduce((s, x) => s + x.v[i], 0));
  return { items, total, nominalIn, privateFt, streetFt, xn, perFt };
}

const isNycha = (b) => /HOUSING AUTHORITY/i.test(b?.owner || "");

// Line items with low/base/high. pipeItems: from pipeCost (one or more links).
// sinks: [{ fuel, units, peakKw }] (one per heat user).
export function costRange({ pipeItems, peakKw, sinks, demandKbtuYr, storageHrs, mode, A }) {
  const lohi = (f) => [0, 1, 2].map(f);
  const items = [
    ...pipeItems,
    { label: "Heat pumps (sized for peak heat delivered)", v: lohi((i) => peakKw * HP_USD_PER_KW[i]) },
    { label: "Source tie-in (heat exchanger, pumps)", v: lohi((i) => peakKw * (1 - 1 / A.hp_cop) * COST.tiePerKw[i]) },
    {
      label: mode === "dhw" ? "Hot-water hookup at the user" : "Heating hookup at the user",
      v: lohi((i) => sinks.reduce((s, k) => {
        if (mode === "dhw") return s + k.peakKw * COST.dhwPerKw[i];
        if (k.fuel === "steam" && k.units > 0) return s + k.units * COST.steamPerUnit[i]; // steam → low-temp conversion
        return s + k.peakKw * COST.spacePerKw[i];
      }, 0)),
      note: mode === "all" && sinks.some((k) => k.fuel === "steam" && k.units > 0)
        ? "Steam-heated buildings need per-apartment conversion to low-temperature heat" : null,
    },
  ];
  if (storageHrs > 0)
    items.push({ label: `Storage tank (${storageHrs} h)`, v: lohi((i) => (demandKbtuYr / 8760 / 3.412) * storageHrs * COST.tankPerKwh[i]) });
  const hard = lohi((i) => items.reduce((s, x) => s + x.v[i], 0));
  items.push({ label: "Engineering, permits, management", v: lohi((i) => hard[i] * COST.soft[i]) });
  items.push({ label: "Contingency", v: lohi((i) => hard[i] * COST.contingency[i]) });
  const total = lohi((i) => items.reduce((s, x) => s + x.v[i], 0));
  return { items, low: total[0], base: total[1], high: total[2] };
}

export function pairEcon(pair, sink, A, opts) {
  const { mode = "all", storage = 0, elecPrice = A.elec_usd_per_kwh, pipeMult = 1, includeLL97 = true, quote } = opts;
  const m = pair[`matched_${mode}_${storage}`] || 0; // kBtu/yr useful heat delivered
  const peakKw = (pair[`peak_${mode}_${storage}`] || 0) / 3.412;
  const hpKwh = m / A.hp_cop / 3.412;
  const fuelUsd = m * (sink.usd_per_kbtu || 0);
  const elecUsd = hpKwh * elecPrice;
  const captured = m * (1 - 1 / A.hp_cop);
  const waterUsd = captured * A.tower_gal_per_kbtu * A.water_usd_per_gal;
  const t = m * (sink.t_per_kbtu || 0) - hpKwh * A.ll97_elec_t_per_kwh;
  // NYCHA follows LL97 Article 321 (no per-ton fines), so avoided tons carry no penalty value there.
  const nycha = isNycha(sink);
  const ll97 = nycha ? 0 : Math.max(t, 0) * A.ll97_usd_per_t;
  const pipe = pipeCost(pair, peakKw, A, pipeMult);
  const pipeUsd = pipe.total[1];
  const hpUsd = peakKw * HP_USD_PER_KW[1];
  const cost = costRange({
    pipeItems: pipe.items, peakKw, A, mode, storageHrs: storage, demandKbtuYr: pair[`demand_${mode}`] || 0,
    sinks: [{ fuel: sink.fuel, units: sink.units || 0, peakKw }],
  });
  // an owner's contractor quote replaces the modeled total (shown with a +/-10% band)
  if (quote > 0) Object.assign(cost, { low: quote * 0.9, base: quote, high: quote * 1.1, quoted: true });
  const energy = fuelUsd - elecUsd + waterUsd;
  const value = energy + (includeLL97 ? ll97 : 0);
  const pb = (c) => (value > 0 ? c / value : null);
  return {
    mmbtu: m / 1000, peakKw, hpMwh: hpKwh / 1000, fuelUsd, elecUsd, waterUsd, energy, ll97, value,
    tco2e: t, pipeUsd, hpUsd, cost, nycha,
    capex: cost.base, capexLow: cost.low, capexHigh: cost.high, capexEquip: pipeUsd + hpUsd,
    payback: pb(cost.base), paybackLow: pb(cost.low), paybackHigh: pb(cost.high),
  };
}

export function filterPairs(pairs, f) {
  return pairs.filter(
    (p) =>
      p.dist_m <= f.maxDist &&
      p[`coincidence_${f.mode}`] >= f.minCoincidence &&
      f.tiers.includes(p.tier) &&
      f.kinds.includes(p._srcKind),
  );
}

// City-wide totals without double counting (same greedy rule as the pipeline).
export function portfolio(list, buildings, A, opts) {
  const left = new Map();
  const usedSinks = new Set();
  const out = { pairs: 0, mmbtu: 0, tco2e: 0, value: 0, energy: 0 };
  const ranked = list
    .map((p) => ({ p, e: pairEcon(p, buildings.get(p.k), A, opts) }))
    .sort((a, b) => b.e.tco2e - a.e.tco2e);
  for (const { p, e } of ranked) {
    if (e.value <= 0 || e.tco2e <= 0 || usedSinks.has(p.k)) continue;
    if (!left.has(p.s)) left.set(p.s, p.avail);
    const need = p[`matched_${opts.mode}_${opts.storage}`];
    const rem = left.get(p.s);
    if (rem <= 0 || need <= 0) continue;
    const f = Math.min(1, rem / need);
    left.set(p.s, rem - need * f);
    usedSinks.add(p.k);
    out.pairs += 1;
    out.mmbtu += e.mmbtu * f;
    out.tco2e += e.tco2e * f;
    out.value += e.value * f;
    out.energy += e.energy * f;
  }
  return out;
}

// 12x24 grids are stored 0..999 relative to their own max (kBtu/h).
export function gridVal(g, key, idx) {
  if (!g || !g[key]) return 0;
  return (g[key][idx] / 999) * g[`${key}_max`];
}

export function demandAt(g, mode, idx) {
  return gridVal(g, "dhw", idx) + (mode === "all" ? gridVal(g, "space", idx) : 0);
}

// Data-center pairs read the source's IT-heat grid ("dc"); commercial pairs its cooling grid ("src").
export const srcKey = (track) => (track === "dc" ? "dc" : "src");

// Heat that can move between a pair in one (month, hour) cell, kBtu/h.
export function flowAt(p, grids, mode, idx) {
  return Math.min(gridVal(grids[p.s], srcKey(p.track), idx), demandAt(grids[p.k], mode, idx));
}

// Each pair's peak hourly flow, so "flowing now" is relative to what that pair can do.
export function computeFlowMax(pairs, grids, mode) {
  const m = new Map();
  if (!grids) return m;
  for (const p of pairs) {
    let mx = 0;
    for (let i = 0; i < 288; i++) mx = Math.max(mx, flowAt(p, grids, mode, i));
    m.set(p.id, mx || 1);
  }
  return m;
}

export function demandMax(g, mode) {
  if (!g) return 1;
  let mx = 0;
  for (let i = 0; i < 288; i++) mx = Math.max(mx, demandAt(g, mode, i));
  return mx || 1;
}

export const fmt = {
  int: (x) => (x == null ? "–" : Math.round(x).toLocaleString("en-US")),
  usd: (x) => {
    if (x == null || !isFinite(x)) return "–";
    const a = Math.abs(x), s = x < 0 ? "−" : "";
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
    return `${s}$${a.toFixed(0)}`;
  },
  big: (x) => {
    if (x == null) return "–";
    if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
    if (Math.abs(x) >= 1e3) return `${(x / 1e3).toFixed(0)}k`;
    return Math.round(x).toString();
  },
  pct: (x) => (x == null ? "–" : `${Math.round(x * 100)}%`),
  yr: (x) => (x == null ? "n/a" : `${x.toFixed(1)} yr`),
  usdRange: (lo, hi) => `${fmt.usd(lo)}–${fmt.usd(hi).replace("$", "")}`,
  // payback range, capped so "never pays back" doesn't read as a precise number
  yrRange: (lo, hi) => {
    if (lo == null || hi == null) return "no payback";
    if (Math.round(lo) >= 40) return "40+ yr";
    return `${Math.round(lo)}–${hi > 40 ? "40+" : Math.round(hi)} yr`;
  },
};

export const TAB_LABEL = { dc: "Data centers", commercial: "Commercial" };

// How a source is described in a given track. Data centers say whether their heat is measured.
export function sourceLabel(b, track) {
  if (track === "dc") return `Data center · ${b.dc_measured ? "measured IT load" : "estimated from floor area"}`;
  return KIND_LABEL[b.source] || "Heat source";
}
export const KIND_LABEL = {
  datacenter: "Data center",
  refrigeration: "Refrigeration",
  hospital: "Hospital / lab",
  office: "Cooling tower",
};
export const FUEL_LABEL = { gas: "natural gas", steam: "Con Ed steam", oil: "heating oil" };
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
