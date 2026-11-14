// Offline building search over every LL84 2024 property (web/public/data/search.json).

const WORDS = {
  avenue: "ave", av: "ave", street: "st", str: "st", east: "e", west: "w", north: "n", south: "s",
  place: "pl", boulevard: "blvd", road: "rd", drive: "dr", parkway: "pkwy", square: "sq", lane: "ln",
  terrace: "ter", court: "ct", plaza: "plz", the: "",
};
const ORDINALS = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8",
  ninth: "9", tenth: "10", eleventh: "11", twelfth: "12",
};

export function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((w) => ORDINALS[w] ?? WORDS[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .filter(Boolean);
}

let cache = null;
export async function loadIndex() {
  if (cache) return cache;
  const r = await fetch("/data/search.json");
  const { cols, rows } = await r.json();
  cache = rows.map((row) => {
    const e = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    e.nameT = norm(e.name);
    e.addrT = norm(e.address);
    return e;
  });
  return cache;
}

// A query word matches a building word by prefix, except finished numbers ("111 ...") must match
// exactly, so "111" doesn't pull in "1115". The last word may still be mid-typing.
const wordMatch = (w, t, last) => (/^\d+$/.test(t) && !last ? w === t : w.startsWith(t));
const startsWith = (tokens, q) => q.every((t, i) => tokens[i] && wordMatch(tokens[i], t, i === q.length - 1));
const containsAll = (tokens, q) => q.every((t, i) => tokens.some((w) => wordMatch(w, t, i === q.length - 1)));

// Rank: name starts with the query > address starts with it > every word appears somewhere.
// Prefer buildings that have partners, then screened buildings, then the rest.
export function searchIndex(index, query, limit = 8) {
  const q = norm(query);
  if (!q.length) return [];
  const hits = [];
  for (const e of index) {
    let score = 0;
    if (startsWith(e.nameT, q)) score = 3;
    else if (startsWith(e.addrT, q)) score = 2.5;
    else if (containsAll([...e.nameT, ...e.addrT], q)) score = 1;
    if (!score) continue;
    score += e.has ? 0.5 : e.id >= 0 ? 0.2 : 0;
    hits.push({ e, score });
  }
  hits.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  // the same building can appear under several filings: keep one row per HeatMatch building
  const seen = new Set();
  const out = [];
  for (const { e } of hits) {
    const key = e.id >= 0 ? `id${e.id}` : `${e.name}|${e.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

// Closest screened buildings with the opposite role (for "no partner passed the screen").
export function nearbyOpposite(index, entry, radiusM = 400, limit = 5) {
  const want = entry.role.includes("s") ? "k" : "s";
  const out = [];
  for (const e of index) {
    if (e.id < 0 || e.id === entry.id || !e.role.includes(want)) continue;
    const d = Math.hypot((e.lon - entry.lon) * 84_300, (e.lat - entry.lat) * 111_320);
    if (d <= radiusM) out.push({ e, d });
  }
  out.sort((a, b) => a.d - b.d);
  const seen = new Set();
  return out.filter(({ e }) => !seen.has(e.id) && seen.add(e.id)).slice(0, limit);
}

export const ROLE_LABEL = { s: "Heat source", k: "Heat user", sk: "Source + user", "": "Not a candidate" };
