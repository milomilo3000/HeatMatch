// The voice assistant's "intent": what the owner asked for, as filters the app can run.
// Claude produces it (POST /api/assistant); parseOffline is the no-AI fallback.

import { apiFetch } from "./api.js";

export const TYPE_LABEL = {
  hotel: "hotels", apartments: "apartment buildings", office: "office buildings", school: "schools",
  hospital: "hospitals and labs", grocery: "grocery and cold-storage buildings", gym: "gyms", data_center: "data centers",
};
const TYPE_MATCH = {
  hotel: ["Hotel"],
  apartments: ["Multifamily Housing", "Residence Hall/Dormitory", "Senior Living Community", "Residential Care Facility", "Other - Lodging/Residential"],
  office: ["Office", "Financial Office", "Medical Office", "Mixed Use Property"],
  school: ["K-12 School", "College/University"],
  hospital: ["Hospital (General Medical & Surgical)", "Laboratory"],
  grocery: ["Supermarket/Grocery Store", "Wholesale Club/Supercenter", "Refrigerated Warehouse"],
  gym: ["Fitness Center/Health Club/Gym"],
};
export const SORT_LABEL = { savings: "highest annual savings", payback: "shortest payback", cheapest: "cheapest to build", co2: "most CO₂ saved", closest: "closest", biggest: "most heat" };

// Does a partner building match the kinds the owner asked for?
export function matchesTypes(building, types) {
  if (!types?.length) return true;
  return types.some((t) => (t === "data_center" ? !!building.dc : TYPE_MATCH[t]?.includes(building.type)));
}

export function sortRows(rows, sort) {
  const key = {
    savings: (r) => -r.e.value,
    payback: (r) => r.e.payback ?? 1e9,
    cheapest: (r) => r.e.capex,
    co2: (r) => -r.e.tco2e,
    closest: (r) => r.p.dist_m,
    biggest: (r) => -r.e.mmbtu,
  }[sort] || ((r) => -r.e.value);
  return [...rows].sort((a, b) => key(a) - key(b));
}

export const EMPTY_INTENT = {
  anchor_text: null, my_role: "unknown", partner_types: [], max_distance_m: null, no_street_crossing: false,
  sort: "savings", heat_use: null, tab: null, clarify: null,
};

const PAYBACK = /\b(?:pay[- ]?back|pay(?:s|ing)? back|pay(?:s|ing)? for itself|break[- ]?even|(?:recoup|recover) (?:the |my |our |its )?(?:investment|upfront cost|initial cost)|make (?:our |my |the )?money back)\b/i;

export function asksForPayback(text) {
  const match = PAYBACK.exec(text);
  if (!match) return false;
  const before = text.slice(0, match.index);
  return !/\b(?:not|ignore|without|skip|omit|no|(?:do not|don't|don’t) (?:mention|include|show|use|rank by))\s+(?:the\s+)?$/i.test(before);
}

// --- offline fallback: understands common phrasings only -----------------------------------

const TYPE_WORDS = [
  ["hotel", /hotel|motel|inn\b/], ["apartments", /apartment|residential|condo|co-?op|housing|dorm|senior/],
  ["office", /office/], ["school", /school|college|universit|campus/], ["hospital", /hospital|clinic|lab\b|labs\b/],
  ["grocery", /grocer|supermarket|cold storage|refrigerat/], ["gym", /gym|fitness|pool/], ["data_center", /data ?cent(er|re)s?/],
];

export function parseOffline(text, previous, focusName) {
  const t = ` ${text.toLowerCase()} `;
  const it = { ...EMPTY_INTENT, ...(previous || {}), clarify: null };
  if (it.sort === "payback") it.sort = "savings";
  const mine = /\b(i (own|run|manage|operate|have)|my|our|we (own|run|have))\b/.test(t);

  // "... at/for <building or address> ..." up to the next clause
  const at = text.match(/\b(?:at|for|near|around|of)\s+((?:\d+[\w-]*\s+)?[A-Za-z0-9 .'-]{3,40}?)(?=,|\.|$| and | to | within | that | find | looking | who | which )/i);
  if (at && /\d|street|st\b|ave|avenue|place|plaza|broadway|houses|tower|center|building/i.test(at[1])) it.anchor_text = at[1].trim();

  const types = TYPE_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k);
  const ownsDc = /\b(my|our|own|run|operate)\b[^.]*data ?cent/.test(t) || /waste heat|excess heat|spare heat|give (away )?heat/.test(t);
  if (ownsDc) it.my_role = "data_center";
  else if (/heating bill|need heat|want heat|cut (my|our) (gas|steam|heating)|supply (me|us)/.test(t)) it.my_role = "heat_user";
  const wanted = types.filter((k) => !(k === "data_center" && it.my_role === "data_center"));
  if (wanted.length) it.partner_types = /\b(too|also|as well|and also)\b/.test(t) && previous ? [...new Set([...(previous.partner_types || []), ...wanted])] : wanted;
  if (/data ?cent/.test(t)) it.tab = "dc";

  const m = t.match(/(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot)\b/);
  if (m) it.max_distance_m = /^(ft|feet|foot)$/.test(m[2]) ? +m[1] * 0.3048 : +m[1];
  else if (/next door|adjacent|adjoining/.test(t)) it.max_distance_m = 30;
  else if (/across the street/.test(t)) it.max_distance_m = 40;
  else if (/(couple|few|two) (of )?blocks/.test(t)) it.max_distance_m = 150;
  else if (/\bblock\b/.test(t) && !/same block/.test(t)) it.max_distance_m = 100;
  if (it.max_distance_m != null) it.max_distance_m = Math.max(5, Math.min(150, it.max_distance_m));

  if (/same block|without crossing|no street|not cross|don'?t cross|avoid (the )?street/.test(t)) it.no_street_crossing = true;
  if (/cheap|lowest cost|least expensive|low cost/.test(t)) it.sort = "cheapest";
  else if (/closest|nearest/.test(t)) it.sort = "closest";
  else if (/carbon|co2|green|emission|climate/.test(t)) it.sort = "co2";
  else if (/most heat|biggest|largest/.test(t)) it.sort = "biggest";
  else if (/\b(best|sav(?:e|es|ing|ings)|makes (?:the most )?sense)\b/.test(t) && !/\b(?:fastest|shortest|quickest|soonest)\b/.test(t)) it.sort = "savings";
  else if (asksForPayback(text) && /\b(?:fastest|shortest|quickest|soonest|rank|sort|order)\b/.test(t)) it.sort = "payback";
  if (/hot water/.test(t) && !/space heat|heating/.test(t)) it.heat_use = "dhw";
  else if (/space heat|heating/.test(t)) it.heat_use = "all";

  if (!it.anchor_text && !focusName && !previous && !mine && !wanted.length && it.max_distance_m == null)
    it.clarify = "Tell me which building is yours and what kind of neighbors you're looking for, for example: “I run the data center at 111 Eighth Avenue, find hotels within a block.”";
  return it;
}

// Ask the AI for an intent; fall back to the offline parser if it can't be reached.
export async function getIntent({ text, tab, focusName, previous }) {
  const includePayback = asksForPayback(text);
  try {
    const r = await apiFetch("/api/assistant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, tab, focus_name: focusName, previous }),
    });
    if (!r.ok) throw new Error(`assistant ${r.status}`);
    const intent = { ...EMPTY_INTENT, ...(await r.json()) };
    if (intent.sort === "payback" && !includePayback) intent.sort = "savings";
    return { intent, offline: false, includePayback };
  } catch {
    return { intent: parseOffline(text, previous, focusName), offline: true, includePayback };
  }
}

// --- wording for the spoken reply ------------------------------------------------------------

const money = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)} million` : x >= 1e3 ? `${Math.round(x / 1000)} thousand` : String(Math.round(x)));
export const sayCost = (lo, hi) => `${money(lo)} to ${money(hi)} dollars`;
export function saySavings(value) {
  if (value < 0) return `adds an estimated ${money(-value)} dollars in net costs per year`;
  if (value === 0) return "has no estimated annual net savings";
  return `has estimated net savings of ${money(value)} dollars per year`;
}

export function sayPayback(lo, hi) {
  if (lo == null || hi == null) return "There is no estimated payback at today's prices.";
  if (Math.round(lo) >= 40) return "The estimated payback is more than 40 years.";
  return `The estimated payback is ${Math.round(lo)} to ${hi > 40 ? "more than 40" : Math.round(hi)} years.`;
}

export function describeFilter(intent) {
  const parts = [];
  parts.push(intent.partner_types?.length ? intent.partner_types.map((t) => TYPE_LABEL[t]).join(" + ") : "any building type");
  if (intent.max_distance_m != null) parts.push(`within ${Math.round(intent.max_distance_m)} m`);
  if (intent.no_street_crossing) parts.push("no street crossing");
  parts.push(SORT_LABEL[intent.sort] || SORT_LABEL.savings);
  return parts;
}
