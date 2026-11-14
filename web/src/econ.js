// Mirrors pipeline/economics.py so the sliders can re-price a pair live in the browser.

export function pairEcon(pair, sink, A, opts) {
  const { mode = "all", storage = 0, elecPrice = A.elec_usd_per_kwh, pipeMult = 1, includeLL97 = true } = opts;
  const m = pair[`matched_${mode}_${storage}`] || 0; // kBtu/yr useful heat delivered
  const peakKw = (pair[`peak_${mode}_${storage}`] || 0) / 3.412;
  const hpKwh = m / A.hp_cop / 3.412;
  const fuelUsd = m * (sink.usd_per_kbtu || 0);
  const elecUsd = hpKwh * elecPrice;
  const captured = m * (1 - 1 / A.hp_cop);
  const waterUsd = captured * A.tower_gal_per_kbtu * A.water_usd_per_gal;
  const t = m * (sink.t_per_kbtu || 0) - hpKwh * A.ll97_elec_t_per_kwh;
  const ll97 = Math.max(t, 0) * A.ll97_usd_per_t;
  const pipeFt = pair.dist_m * 3.28084 + A.connection_ft;
  const pipeUsd = pipeFt * A.pipe_usd_per_ft[pair.tier] * pipeMult;
  const hpUsd = peakKw * A.hp_usd_per_kw;
  const capex = pipeUsd + hpUsd;
  const energy = fuelUsd - elecUsd + waterUsd;
  const value = energy + (includeLL97 ? ll97 : 0);
  return {
    mmbtu: m / 1000, peakKw, hpMwh: hpKwh / 1000, fuelUsd, elecUsd, waterUsd, energy, ll97, value,
    tco2e: t, pipeUsd, hpUsd, capex, payback: value > 0 ? capex / value : null,
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

// Heat that can move between a pair in one (month, hour) cell, kBtu/h.
export function flowAt(p, grids, mode, idx) {
  return Math.min(gridVal(grids[p.s], "src", idx), demandAt(grids[p.k], mode, idx));
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
};

export const KIND_LABEL = {
  datacenter: "Data center",
  refrigeration: "Refrigeration",
  hospital: "Hospital / lab",
  office: "Cooling tower",
};
export const FUEL_LABEL = { gas: "natural gas", steam: "Con Ed steam", oil: "heating oil" };
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
