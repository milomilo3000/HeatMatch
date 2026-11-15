import React, { useState } from "react";
import { apiFetch } from "./api.js";
import PipeCard from "./PipeCard.jsx";
import { pairEcon, gridVal, demandAt, srcKey, sourceLabel, fmt, FUEL_LABEL, MONTHS } from "./econ.js";
import { ROUTE, crossingText, routeLine } from "./pipe.js";
import { Savings } from "./ResultsPanel.jsx";

const TIER_SCORE = { 1: 1, 2: 0.85, 3: 0.6, 4: 0.3 };

const TIER_REASON = {
  1: { text: "Shares a wall: the easiest pipe run", tone: "good" },
  2: { text: "Same block: no street to dig up", tone: "good" },
  3: { text: "Crosses one street: needs a city permit", tone: "ok" },
  4: { text: "Crosses several streets: costlier pipe", tone: "bad" },
};

const COST_GROUPS = [
  ["pipe", "Pipe & street work"],
  ["equip", "Heat pump & equipment"],
  ["hookup", "Hookup inside the building"],
  ["soft", "Engineering & contingency"],
];

const routeNote = (pair) => `${crossingText(pair).replace(/^./, (c) => c.toUpperCase())}. ${ROUTE[pair.tier].permit}`;

function monthly(g, fn) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += fn(g, m * 24 + h);
    out.push(Math.round((s * 30.4) / 1000));
  }
  return out;
}

/** 0–100 screening score for planners: timing + coverage + connection ease + payback. */
export function heatMatchScore(pair, e, mode) {
  const coin = pair[`coincidence_${mode}`] || 0;
  const cov = pair[`coverage_${mode}`] || 0;
  const tier = TIER_SCORE[pair.tier] ?? 0.3;
  const pb = e.payback;
  const pay = pb == null ? 0 : pb <= 10 ? 1 : pb <= 20 ? 0.7 : pb <= 30 ? 0.4 : 0.15;
  const score = Math.round(100 * (0.3 * coin + 0.3 * cov + 0.2 * tier + 0.2 * pay));
  const label = score >= 70 ? "Strong" : score >= 45 ? "Worth a look" : "Weak";
  const pct = (x) => fmt.pct(x);
  const reasons = [
    coin >= 0.6 ? { text: `Heat is there when it's needed (${pct(coin)} of hours)`, tone: "good" }
      : coin >= 0.35 ? { text: `Heat is there some of the time it's needed (${pct(coin)})`, tone: "ok" }
      : { text: `Heat rarely lines up with need (${pct(coin)})`, tone: "bad" },
    cov >= 0.6 ? { text: `Covers most of its heat need (${pct(cov)})`, tone: "good" }
      : cov >= 0.3 ? { text: `Covers some of its heat need (${pct(cov)})`, tone: "ok" }
      : { text: `Covers little of its heat need (${pct(cov)})`, tone: "bad" },
    TIER_REASON[pair.tier] || TIER_REASON[4],
    pb == null ? { text: "Doesn't pay back on savings alone", tone: "bad" }
      : pb <= 12 ? { text: "Pays for itself fairly quickly", tone: "good" }
      : pb <= 20 ? { text: "Moderate payback time", tone: "ok" }
      : { text: "Slow to pay back (20+ years)", tone: "bad" },
  ];
  return { score, label, reasons };
}

export function buildFacts(data, grids, pair, filters, e) {
  const s = data.buildings.get(pair.s), k = data.buildings.get(pair.k);
  const gs = grids?.[pair.s], gk = grids?.[pair.k];
  return {
    source: { name: s.name, address: s.address, borough: s.borough, type: s.type, role: sourceLabel(s, pair.track),
      is_data_center: pair.track === "dc",
      owner: s.owner, cooling_towers: s.towers, data_center_share_of_electricity: s.dc_share },
    sink: { name: k.name, address: k.address, borough: k.borough, type: k.type, owner: k.owner,
      residential_units: k.units, heats_with: FUEL_LABEL[k.fuel] || k.fuel },
    link: { distance_m: pair.dist_m, tier: routeNote(pair), streets_crossed: pair.xnames || [], crosses_protected_street: !!pair.prot,
      subway_under_street: !!pair.sub, serves: filters.mode === "dhw" ? "domestic hot water" : "hot water and space heat",
      storage_hours: filters.storage, hour_overlap: pair[`coincidence_${filters.mode}`], share_of_sink_demand_covered: pair[`coverage_${filters.mode}`] },
    annual: { heat_reused_mmbtu: Math.round(e.mmbtu), tco2e_avoided: Math.round(e.tco2e), fuel_savings_usd: Math.round(e.fuelUsd),
      heat_pump_electricity_usd: Math.round(e.elecUsd), cooling_tower_water_savings_usd: Math.round(e.waterUsd),
      ll97_penalty_avoided_usd: Math.round(e.ll97), total_value_usd: Math.round(e.value),
      installed_cost_range_usd: [Math.round(e.capexLow), Math.round(e.capexHigh)],
      sink_is_nycha_article_321: e.nycha },
    monthly_mmbtu: gs && gk ? {
      months: MONTHS,
      source_heat_available: monthly(gs, (g, i) => gridVal(g, srcKey(pair.track), i)),
      sink_heat_demand: monthly(gk, (g, i) => demandAt(g, filters.mode, i)),
    } : null,
  };
}

function templateLetters(f) {
  const a = f.annual;
  const common = `${f.source.name} (${f.source.address}) and ${f.sink.name} (${f.sink.address}) are ${Math.round(f.link.distance_m)} m apart. ${f.link.tier}.`;
  const netEnergy = a.fuel_savings_usd - a.heat_pump_electricity_usd;
  const energyImpact = netEnergy < 0
    ? `Heat-pump electricity would increase your net energy costs by about ${fmt.usd(-netEnergy)} per year.`
    : `After heat-pump electricity, we estimate you would save ${fmt.usd(netEnergy)} per year on energy.`;
  return `TO: ${f.source.owner || "Owner"} — ${f.source.name}
RE: Reducing cooling-tower costs

Sharing waste heat could save your building about ${fmt.usd(a.cooling_tower_water_savings_usd)} per year in cooling-tower water and chemical costs and could open a heat-sale income stream.

${common}

Your building (${f.source.role.toLowerCase()}) rejects heat to the sky through its cooling equipment. Your neighbor burns ${f.sink.heats_with} to make ${f.link.serves}. Public data (NYC LL84 2024, the DOHMH cooling-tower registry) shows the two loads overlap ${Math.round(f.link.hour_overlap * 100)}% hour by hour.

A heat link could move about ${a.heat_reused_mmbtu.toLocaleString()} MMBtu a year.

Next step: a 30-minute call and a joint feasibility study.

—

TO: ${f.sink.owner || "Owner"} — ${f.sink.name}
RE: Cutting your ${f.sink.heats_with} bill and LL97 exposure with your neighbor's waste heat

${energyImpact}${a.ll97_penalty_avoided_usd > 0 ? ` The link could also avoid about ${fmt.usd(a.ll97_penalty_avoided_usd)} per year in modeled LL97 penalties.` : ""}

${common}

Recovered heat could cover ${Math.round(f.link.share_of_sink_demand_covered * 100)}% of your ${f.link.serves} demand, avoiding about ${a.tco2e_avoided.toLocaleString()} tCO2e a year${a.sink_is_nycha_article_321 ? " (helping meet NYCHA's LL97 Article 321 obligations)" : ""}.

Estimated installed cost is ${fmt.usdRange(...a.installed_cost_range_usd)}. These are screening numbers from public data and need an engineering study to confirm.

— HeatMatch NYC (screening estimate, not an engineering design)`;
}

export default function PairDrawer({
  data, grids, pair, filters, setFilters, hour, month, onClose, onBack, focusEntry, embedded,
}) {
  const A = data.summary.assumptions;
  const s = data.buildings.get(pair.s), k = data.buildings.get(pair.k);
  const [letter, setLetter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // LL97 penalty savings always included in screening numbers
  const opts = { mode: filters.mode, storage: filters.storage, includeLL97: true };
  const e = pairEcon(pair, k, A, opts);
  const before = pair._owner && data.raw ? pairEcon(pair._orig, data.raw.buildings.get(pair.k), A, opts) : null;
  const match = heatMatchScore(pair, e, filters.mode);
  const partner = focusEntry ? (focusEntry.id === s.id ? k : s) : null;
  const youGive = focusEntry ? focusEntry.id === s.id : null;

  async function draft() {
    setBusy(true); setLetter(""); setNote("");
    const facts = buildFacts(data, grids, pair, filters, e);
    try {
      const r = await apiFetch("/api/proposal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(facts) });
      if (r.status === 401) {
        setLetter(templateLetters(facts));
        setNote("Template shown. Use Demo login to unlock AI drafting.");
        return;
      }
      if (!r.ok || !r.body) throw new Error(`API ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        setLetter(text);
      }
      if (!text.trim()) throw new Error("empty response");
    } catch (err) {
      setLetter(templateLetters(facts));
      setNote(`Template letter shown (AI drafting unavailable: ${err.message}).`);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([letter], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `heatmatch-${s.name}-${k.name}.md`.replace(/[^\w.-]+/g, "_");
    a.click();
  }

  const tone = match.label === "Strong" ? "hi" : match.label === "Worth a look" ? "mid" : "lo";
  const other = partner || k;
  const otherRole = (partner ? !youGive : false) ? sourceLabel(other, pair.track) : (other.type || FUEL_LABEL[other.fuel] || "Needs heat");
  const route = routeLine(pair);
  const breakdown = [
    { label: `${FUEL_LABEL[k.fuel] || "Fuel"} saved`, v: e.fuelUsd },
    { label: "Heat-pump electricity", v: -e.elecUsd },
    { label: "Cooling-tower water saved", v: e.waterUsd },
    { label: e.nycha ? "LL97 fines avoided (NYCHA: n/a)" : "LL97 fines avoided", v: e.ll97 },
  ];
  const signed = (v) => <span className={v >= 0 ? "pos" : "neg"}>{v >= 0 ? "+" : "−"}{fmt.usd(Math.abs(v))}</span>;
  const groups = COST_GROUPS.map(([key, label]) => ({
    label, v: e.cost.items.filter((it) => (it.group || "soft") === key).reduce((t, it) => t + it.v[1], 0),
  })).filter((x) => x.v > 0);
  const MARK = { good: "✓", ok: "~", bad: "✗" };

  return (
    <div className={`drawer compact-drawer ${embedded ? "drawer-embedded" : ""}`}>
      <header className="drawer-min-head">
        {onBack ? (
          <button type="button" className="back-btn" onClick={onBack}>← Partners</button>
        ) : (
          <div className="eyebrow">Match details</div>
        )}
        <button className="close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="block pair-title">
        <div className="pt-row">
          <div>
            {!focusEntry && <div className="muted pt-from">{s.name} →</div>}
            <h3>{other.name}</h3>
            <div className="muted pt-sub">{otherRole} · {route.ft ? `${route.ft} away` : "next door"}</div>
          </div>
          <span className={`match-score s-${tone}`} title={`Heat match score ${match.score}/100 · ${match.label}`}>
            <b>{match.score}</b>
          </span>
        </div>
        <div className="why">
          <div className="why-head">Why {match.score}: <b className={`rec-${tone}`}>{match.label.toLowerCase()}</b></div>
          {match.reasons.map((r) => (
            <div key={r.text} className={`why-row t-${r.tone}`}><i>{MARK[r.tone]}</i>{r.text}</div>
          ))}
        </div>
      </div>

      <div className="block">
        <div className="kpis">
          <div className="kpi"><div className="v">{fmt.usdRange(e.capexLow, e.capexHigh)}</div><div className="l">est. cost</div></div>
          <div className="kpi"><div className="v"><Savings value={e.value} suffix="" /></div><div className="l">est. savings / yr</div></div>
          <div className="kpi"><div className="v pos">{fmt.int(e.tco2e)} t</div><div className="l">CO₂ avoided / yr</div></div>
        </div>
        <div className="note" style={{ marginTop: 6 }}>Screening estimates from public data, not quotes.</div>
        {before && (
          <div className="before-after">
            <span className="conf m">Using your data</span> Public-data model said {fmt.usdRange(before.capexLow, before.capexHigh)},
            {" "}{fmt.usd(before.value)}/yr savings.
          </div>
        )}
      </div>

      <div className="block">
        <h4>How it connects</h4>
        <div className="route-line">
          <span className="ri" aria-hidden="true">{route.icon}</span>
          <span><b>{route.where}</b>{route.ft && ` · ${route.ft}`}<br /><span className="muted">{route.need}</span></span>
        </div>
        <PipeCard compact pair={pair} s={s} k={k} A={A} mode={filters.mode} storage={filters.storage} />
      </div>

      <div className="block cta-block">
        <button className="cta" onClick={draft} disabled={busy}>
          {busy ? "Drafting…" : letter ? "Redraft outreach letters" : "Draft outreach letters"}
        </button>
        {note && <div className="note" style={{ marginTop: 6 }}>{note}</div>}
        {letter && (
          <>
            <div className="letter">{letter}</div>
            <div className="btnrow">
              <button className="ghost" onClick={() => navigator.clipboard.writeText(letter)}>Copy</button>
              <button className="ghost" onClick={download}>Download</button>
            </div>
          </>
        )}
      </div>

      <details className="acc">
        <summary>Savings &amp; cost breakdown</summary>
        <div className="block">
          <h4>Savings per year</h4>
          {breakdown.map((r) => (
            <div key={r.label} className="econ-row"><span>{r.label}</span>{signed(r.v)}</div>
          ))}
          <div className="econ-row total"><span>Net savings</span>{signed(e.value)}</div>
        </div>
        <div className="block">
          <h4>Installed cost (estimate)</h4>
          {groups.map((x) => (
            <div key={x.label} className="econ-row"><span>{x.label}</span><span>{fmt.usd(x.v)}</span></div>
          ))}
          <div className="econ-row total">
            <span>Total</span>
            <span>{fmt.usdRange(e.capexLow, e.capexHigh)}</span>
          </div>
        </div>
      </details>
    </div>
  );
}
