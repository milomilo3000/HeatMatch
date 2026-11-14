// Pipeline chains: one heat source feeding N-1 heat users along a single supply/return loop
// that runs building -> building. Every hop must respect the max-distance and tier filters.
//
// Scoring uses the 12-month x 24-hour "typical day" grids (avg kBtu/h per month-hour), so it is
// an estimate. The two-building pair numbers elsewhere come from the full 8,760-hour simulation.

import { nearestWalls, footprintRadius, hopTier, sizePipe } from "./pipe.js";
import { gridVal, demandAt, costRange, pipeCost, srcKey, HP_USD_PER_KW } from "./econ.js";

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CELL = 0.002; // ~170 m x 220 m spatial index cells
const BEAM = 3; // partial chains kept per step for each source
const CANDIDATES = 6; // nearest heat users tried from each chain end

// --- spatial index of heat users ----------------------------------------------

export function buildIndex(buildings) {
  const cells = new Map();
  const radius = new Map();
  for (const b of buildings.values()) {
    radius.set(b.id, footprintRadius(b));
    if (!b.sink) continue;
    const key = `${Math.floor(b.lon / CELL)},${Math.floor(b.lat / CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(b);
  }
  return { cells, radius, cache: new Map() };
}

// Heat users whose nearest wall is within maxDist of building b, nearest first.
function neighbors(b, maxDist, index) {
  const key = `${b.id}|${maxDist}`;
  if (index.cache.has(key)) return index.cache.get(key);
  const out = [];
  const cx = Math.floor(b.lon / CELL), cy = Math.floor(b.lat / CELL);
  const rb = index.radius.get(b.id);
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (const o of index.cells.get(`${cx + dx},${cy + dy}`) || []) {
        if (o.id === b.id) continue;
        const centroid = Math.hypot((o.lon - b.lon) * 84_300, (o.lat - b.lat) * 111_320);
        if (centroid - rb - index.radius.get(o.id) > maxDist) continue; // cheap prefilter
        const d = nearestWalls(b, o).meters;
        if (d <= maxDist) out.push({ b: o, dist: d, tier: hopTier(b, o, d) });
      }
  out.sort((x, y) => x.dist - y.dist);
  index.cache.set(key, out);
  return out;
}

// --- scoring --------------------------------------------------------------------

// Hour by hour, the source's heat is shared across every user on the loop. When demand
// exceeds supply, each user gets the same fraction of its own demand.
export function scoreChain(ids, hops, ctx, withGrids = false) {
  const { grids, buildings, A, mode, track } = ctx;
  const gs = grids[ids[0]];
  const sinks = ids.slice(1);
  const alloc = new Float64Array(sinks.length);
  const dem = new Float64Array(sinks.length);
  let matched = 0, srcTot = 0, demTot = 0, peak = 0;
  const G = withGrids ? { src: [], dem: [], match: [] } : null;
  for (let m = 0; m < 12; m++)
    for (let h = 0; h < 24; h++) {
      const i = m * 24 + h, days = DAYS[m];
      const a = gridVal(gs, srcKey(track), i);
      let D = 0;
      const ds = sinks.map((k) => demandAt(grids[k], mode, i));
      for (const d of ds) D += d;
      const mt = Math.min(a, D);
      matched += mt * days; srcTot += a * days; demTot += D * days;
      peak = Math.max(peak, mt);
      if (D > 0) ds.forEach((d, j) => { alloc[j] += (mt * d) / D * days; dem[j] += d * days; });
      if (G) { G.src.push(a); G.dem.push(D); G.match.push(mt); }
    }

  // economics: same formulas as econ.pairEcon, summed over the users on the loop
  let fuelUsd = 0, tFuel = 0;
  sinks.forEach((k, j) => {
    const b = buildings.get(k);
    fuelUsd += alloc[j] * (b.usd_per_kbtu || 0);
    tFuel += alloc[j] * (b.t_per_kbtu || 0);
  });
  const hpKwh = matched / A.hp_cop / 3.412;
  const elecUsd = hpKwh * A.elec_usd_per_kwh;
  const waterUsd = matched * (1 - 1 / A.hp_cop) * A.tower_gal_per_kbtu * A.water_usd_per_gal;
  const tco2e = tFuel - hpKwh * A.ll97_elec_t_per_kwh;
  // LL97 value only for users that face per-ton fines (NYCHA follows Article 321 instead)
  let tFined = 0;
  sinks.forEach((k, j) => {
    const b = buildings.get(k);
    if (!/HOUSING AUTHORITY/i.test(b.owner || "")) tFined += alloc[j] * (b.t_per_kbtu || 0);
  });
  const finedShare = tFuel > 0 ? tFined / tFuel : 0;
  const ll97 = Math.max(tco2e, 0) * finedShare * A.ll97_usd_per_t;
  const pipeM = hops.reduce((s, x) => s + x.dist, 0);
  // every hop is priced like a pair's pipe (sized for the chain's peak; real street crossings where known)
  const pipeItems = hops.flatMap((x, i) => pipeCost({ ...x, dist_m: x.dist }, peak / 3.412, A).items
    .map((it) => ({ ...it, label: `Hop ${i + 1}: ${it.label}` })));
  const pipeUsd = pipeItems.reduce((s, it) => s + it.v[1], 0);
  const hpUsd = (peak / 3.412) * HP_USD_PER_KW[1];
  const energy = fuelUsd - elecUsd + waterUsd;
  const value = energy + ll97;
  const cost = costRange({
    pipeItems, peakKw: peak / 3.412, A, mode, storageHrs: 0, demandKbtuYr: demTot,
    sinks: sinks.map((k, j) => {
      const b = buildings.get(k);
      return { fuel: b.fuel, units: b.units || 0, peakKw: (peak / 3.412) * (alloc[j] / Math.max(matched, 1)) };
    }),
  });
  const capex = cost.base;
  return {
    mmbtu: matched / 1000, srcMmbtu: srcTot / 1000, demMmbtu: demTot / 1000,
    coincidence: matched / Math.max(1, Math.min(srcTot, demTot)),
    coverage: matched / Math.max(1, demTot),
    users: sinks.map((k, j) => ({ id: k, mmbtu: alloc[j] / 1000, coverage: alloc[j] / Math.max(1, dem[j]) })),
    fuelUsd, elecUsd, waterUsd, energy, ll97, value, tco2e, pipeM, pipeUsd, hpUsd, capex,
    cost, capexLow: cost.low, capexHigh: cost.high,
    payback: value > 0 ? capex / value : null, peakKw: peak / 3.412,
    paybackLow: value > 0 ? cost.low / value : null, paybackHigh: value > 0 ? cost.high / value : null,
    pipe: sizePipe(peak / 3.412, A), grids: G,
  };
}

// --- search ----------------------------------------------------------------------

// For every source that appears in the filtered pairs, grow the best chain of exactly `size`
// buildings with a small beam search (keeps the BEAM best partial chains by tCO2e each step).
export function findChains({ size, pairs, buildings, grids, A, filters, index, track }) {
  const ctx = { grids, buildings, A, mode: filters.mode, track };
  // source→user hops reuse the pair's real street-crossing data
  const known = new Map(pairs.map((p) => [`${p.s}-${p.k}`, p]));
  const link = (from, n) => {
    const p = known.get(`${from}-${n.b.id}`);
    return p
      ? { from, to: n.b.id, dist: n.dist, tier: p.tier, xn: p.xn, xft: p.xft, xnames: p.xnames, prot: p.prot, sub: p.sub, hwy: p.hwy }
      : { from, to: n.b.id, dist: n.dist, tier: n.tier };
  };
  const sources = [...new Set(pairs.map((p) => p.s))];
  const out = [];
  for (const sId of sources) {
    const src = buildings.get(sId);
    const kind = track === "dc" ? "datacenter" : src.source;
    if (!grids[sId]?.[srcKey(track)] || !filters.kinds.includes(kind)) continue;
    let beams = [{ ids: [sId], hops: [] }];
    for (let step = 1; step < size; step++) {
      const next = [];
      const seen = new Set();
      for (const st of beams) {
        const last = buildings.get(st.ids[st.ids.length - 1]);
        let tried = 0;
        for (const n of neighbors(last, filters.maxDist, index)) {
          if (tried >= CANDIDATES) break;
          if (st.ids.includes(n.b.id) || n.b.id === sId || !grids[n.b.id]) continue;
          const hop = link(last.id, n);
          if (!filters.tiers.includes(hop.tier)) continue;
          if (step === 1 && n.b.owner && src.owner && n.b.owner === src.owner) continue; // same owner: not a deal
          if (src.source === "hospital" && n.b.sink === "hospital" && track !== "dc") continue; // one medical campus
          tried++;
          const ids = [...st.ids, n.b.id];
          const sig = [ids[0], ...ids.slice(1).sort()].join(",");
          if (seen.has(sig)) continue;
          seen.add(sig);
          const hops = [...st.hops, hop];
          next.push({ ids, hops, m: scoreChain(ids, hops, ctx) });
        }
      }
      next.sort((x, y) => y.m.tco2e - x.m.tco2e);
      beams = next.slice(0, BEAM);
      if (!beams.length) break;
    }
    const best = beams[0];
    if (best && best.ids.length === size && best.m.coincidence >= filters.minCoincidence && best.m.tco2e > 0)
      out.push({ key: best.ids.join("-"), ids: best.ids, hops: best.hops, m: best.m, kind, track });
  }
  return out;
}
