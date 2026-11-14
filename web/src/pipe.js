// Geometry and sizing for the proposed pipe between a source and a sink building.
// Everything here is a screening estimate; constants are documented inline.

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

// --- geometry -------------------------------------------------------------

function toLocal([lon, lat], o) {
  return [(lon - o[0]) * mPerDegLon(o[1]), (lat - o[1]) * M_PER_DEG_LAT];
}
function toLonLat([x, y], o) {
  return [o[0] + x / mPerDegLon(o[1]), o[1] + y / M_PER_DEG_LAT];
}
function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

// Closest pair of points between two buildings' outlines (their nearest walls).
export function nearestWalls(bA, bB) {
  const o = [bA.lon, bA.lat];
  const ringsA = bA.polygons.map((r) => r.map((p) => toLocal(p, o)));
  const ringsB = bB.polygons.map((r) => r.map((p) => toLocal(p, o)));
  let best = { d: Infinity, a: null, b: null };
  const scan = (from, to, flip) => {
    for (const ra of from)
      for (const p of ra)
        for (const rb of to)
          for (let i = 0; i < rb.length - 1; i++) {
            const q = closestOnSegment(p, rb[i], rb[i + 1]);
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (d < best.d) best = flip ? { d, a: q, b: p } : { d, a: p, b: q };
          }
  };
  scan(ringsA, ringsB, false);
  scan(ringsB, ringsA, true);
  // buildings that touch: still draw a short stub so the connection is visible
  if (best.d < 2) {
    const dir = [bB.lon - bA.lon, bB.lat - bA.lat].map((v, i) => v * (i ? M_PER_DEG_LAT : mPerDegLon(bA.lat)));
    const n = Math.hypot(...dir) || 1;
    const mid = [(best.a[0] + best.b[0]) / 2, (best.a[1] + best.b[1]) / 2];
    best = { d: best.d, a: [mid[0] - (dir[0] / n) * 2, mid[1] - (dir[1] / n) * 2], b: [mid[0] + (dir[0] / n) * 2, mid[1] + (dir[1] / n) * 2] };
  }
  return { a: toLonLat(best.a, o), b: toLonLat(best.b, o), meters: best.d };
}

// Supply and return lines, side by side, offset sideways from the centerline.
export function pipeLines(route, offsetM = 1.3, z = 0.6) {
  const o = route.a;
  const A = toLocal(route.a, o), B = toLocal(route.b, o);
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const n = Math.hypot(dx, dy) || 1;
  const px = (-dy / n) * offsetM, py = (dx / n) * offsetM;
  const line = (s) => [toLonLat([A[0] + s * px, A[1] + s * py], o), toLonLat([B[0] + s * px, B[1] + s * py], o)].map((p) => [...p, z]);
  return { supply: line(1), ret: line(-1).reverse() }; // supply runs source→sink, return sink→source
}

export function midpoint(route, z = 6) {
  return [(route.a[0] + route.b[0]) / 2, (route.a[1] + route.b[1]) / 2, z];
}

// --- hydraulics ------------------------------------------------------------

export const LOOP = {
  supplyF: 85, // condenser water leaving the source's chiller / IT cooling (typical 85–95°F)
  returnF: 75, // back to the source after the heat pump has taken heat out (10°F range)
  velocityMps: 2.0, // design velocity for buried water mains (keeps pumping energy low)
  sizesIn: [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30, 36],
};

// Size a supply/return pipe for a given peak delivered heat (kW at the heat pump outlet).
export function sizePipe(deliveredKw, A) {
  const carriedKw = deliveredKw * (1 - 1 / A.hp_cop); // the rest comes from heat-pump electricity
  const dTK = ((LOOP.supplyF - LOOP.returnF) * 5) / 9;
  const m3s = (carriedKw * 1000) / (1000 * 4186 * dTK); // Q = ρ·V̇·cp·ΔT
  const dIn = Math.sqrt((4 * m3s) / (Math.PI * LOOP.velocityMps)) / 0.0254;
  const nominalIn = LOOP.sizesIn.find((s) => s >= dIn) ?? LOOP.sizesIn[LOOP.sizesIn.length - 1];
  return { deliveredKw, carriedKw, gpm: m3s * 15_850.3, nominalIn };
}

// kW of heat that must travel down the pipe at peak = waste-heat share of what the heat pump delivers.
export function pipeSpec(pair, A, opts) {
  const size = sizePipe((pair[`peak_${opts.mode}_${opts.storage}`] || 0) / 3.412, A);
  const lengthFt = pair.dist_m * 3.28084 + A.connection_ft;
  return { ...size, lengthM: pair.dist_m, lengthFt };
}

// Rough footprint radius in meters (centroid to farthest corner).
export function footprintRadius(b) {
  let r = 8;
  for (const ring of b.polygons)
    for (const [lon, lat] of ring)
      r = Math.max(r, Math.hypot((lon - b.lon) * mPerDegLon(b.lat), (lat - b.lat) * M_PER_DEG_LAT));
  return r;
}

// Chain hops between two heat users aren't checked against the street map (the pipeline only
// does that for source-user pairs), so their tier falls back to tax block + distance.
export function hopTier(a, b, meters) {
  if (meters <= 3) return 1;
  if (a.bbl && b.bbl && a.bbl.slice(0, 6) === b.bbl.slice(0, 6)) return 2;
  if (meters <= 40) return 3;
  return 4;
}

export const ROUTE = {
  1: { how: "through the shared party wall", permit: "No easement or street work: the buildings touch." },
  2: { how: "across the lot line on the same block", permit: "Private easement between the owners; no street opening." },
  3: { how: "under one street", permit: "NYC DOT revocable consent + street-opening permit; utility mark-out under the roadway." },
  4: { how: "under several streets", permit: "A DOT revocable consent and street-opening permit for each street: the hardest kind of run." },
};

const tidy = (name) => String(name).replace(/\s+/g, " ").trim();

// Short phrase for what the pipe route crosses, using real street names when the pipeline found them.
export function crossingText(link) {
  if (link.tier === 1) return "shares a wall";
  if (link.xn == null) return ["", "", "same block", "across one street", "across several streets"][link.tier];
  if (!link.xn) return "no street to cross";
  const names = (link.xnames || []).map(tidy);
  if (link.xn === 1) return `crosses ${names[0] || "one street"}`;
  return `crosses ${link.xn} streets${names.length ? ` (${names.slice(0, 2).join(", ")})` : ""}`;
}

// One plain line for judges: where the pipe goes and what that takes.
export function routeLine(link) {
  const names = (link.xnames || []).map(tidy);
  const ft = link.dist_m >= 1 ? `${Math.round(link.dist_m * 3.281)} ft` : null; // touching buildings: no length
  if (link.tier === 1) return { icon: "▥", where: "Through the shared wall", ft, need: "no street work" };
  if (!link.xn && link.tier <= 2) return { icon: "⇢", where: "Across the lot line", ft, need: "private easement, no street work" };
  const n = link.xn || (link.tier >= 4 ? 2 : 1);
  const where = names.length ? `Under ${names.slice(0, 2).join(" and ")}` : n > 1 ? `Under ${n} streets` : "Under the street";
  const extra = [link.prot && "recently repaved", link.sub && "subway below", link.hwy && "highway"].filter(Boolean);
  const need = `${n > 1 ? `${n} DOT street permits` : "needs a DOT street permit"}${extra.length ? ` · ${extra.join(", ")}` : ""}`;
  return { icon: "⛏", where, ft, need };
}

export function routeHow(link) {
  const names = (link.xnames || []).map(tidy);
  if (link.xn && names.length) return `under ${names.slice(0, 2).join(" and ")}`;
  return ROUTE[link.tier].how;
}
