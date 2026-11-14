import React, { useMemo, useState } from "react";
import HeatGrid from "./HeatGrid.jsx";
import PipeCard from "./PipeCard.jsx";
import { pairEcon, gridVal, demandAt, fmt, KIND_LABEL, FUEL_LABEL, MONTHS } from "./econ.js";

const TIER_NOTE = {
  1: "Buildings touch — pipe through the party wall",
  2: "Same block — private easement only",
  3: "Across one street — needs a NYC DOT permit",
  4: "Longer run — multiple lots or streets",
};

const TIER_SCORE = { 1: 1, 2: 0.85, 3: 0.6, 4: 0.3 };

function monthly(g, fn) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += fn(g, m * 24 + h);
    out.push(Math.round((s * 30.4) / 1000));
  }
  return out;
}

const TIER_REASON = {
  1: "Shared wall — easiest pipe run",
  2: "Same block — short private run",
  3: "Across a street — needs a city permit",
  4: "Farther apart — longer, costlier pipe",
};

/** 0–100 screening score for planners: timing + coverage + connection ease + payback. */
export function heatMatchScore(pair, e, mode) {
  const coin = pair[`coincidence_${mode}`] || 0;
  const cov = pair[`coverage_${mode}`] || 0;
  const tier = TIER_SCORE[pair.tier] ?? 0.3;
  const pb = e.payback;
  const pay = pb == null ? 0 : pb <= 10 ? 1 : pb <= 20 ? 0.7 : pb <= 30 ? 0.4 : 0.15;
  const score = Math.round(100 * (0.3 * coin + 0.3 * cov + 0.2 * tier + 0.2 * pay));
  const label = score >= 70 ? "Strong" : score >= 45 ? "Worth a look" : "Weak";
  const reasons = [
    coin >= 0.6 ? `Good timing fit (${fmt.pct(coin)})` : coin >= 0.35 ? `Uneven timing fit (${fmt.pct(coin)})` : `Poor timing fit (${fmt.pct(coin)})`,
    cov >= 0.6 ? `Covers most heat need (${fmt.pct(cov)})` : cov >= 0.3 ? `Covers some heat need (${fmt.pct(cov)})` : `Covers little heat need (${fmt.pct(cov)})`,
    TIER_REASON[pair.tier] || TIER_REASON[4],
    pb == null || pb > 30 ? "Long payback weakens the case"
      : pb <= 12 ? "Payback looks competitive"
      : pb <= 20 ? "Payback is moderate"
      : "Payback is on the long side",
  ];
  return { score, label, reasons };
}

export function buildFacts(data, grids, pair, filters, e) {
  const s = data.buildings.get(pair.s), k = data.buildings.get(pair.k);
  const gs = grids?.[pair.s], gk = grids?.[pair.k];
  return {
    source: { name: s.name, address: s.address, borough: s.borough, type: s.type, role: KIND_LABEL[s.source],
      owner: s.owner, cooling_towers: s.towers, data_center_share_of_electricity: s.dc_share },
    sink: { name: k.name, address: k.address, borough: k.borough, type: k.type, owner: k.owner,
      residential_units: k.units, heats_with: FUEL_LABEL[k.fuel] || k.fuel },
    link: { distance_m: pair.dist_m, tier: TIER_NOTE[pair.tier], serves: filters.mode === "dhw" ? "domestic hot water" : "hot water and space heat",
      storage_hours: filters.storage, hour_overlap: pair[`coincidence_${filters.mode}`], share_of_sink_demand_covered: pair[`coverage_${filters.mode}`] },
    annual: { heat_reused_mmbtu: Math.round(e.mmbtu), tco2e_avoided: Math.round(e.tco2e), fuel_savings_usd: Math.round(e.fuelUsd),
      heat_pump_electricity_usd: Math.round(e.elecUsd), cooling_tower_water_savings_usd: Math.round(e.waterUsd),
      ll97_penalty_avoided_usd: Math.round(e.ll97), total_value_usd: Math.round(e.value),
      installed_cost_range_usd: [Math.round(e.capexLow), Math.round(e.capexHigh)],
      payback_range_years: e.paybackLow ? [+e.paybackLow.toFixed(1), +e.paybackHigh.toFixed(1)] : null,
      sink_is_nycha_article_321: e.nycha },
    monthly_mmbtu: gs && gk ? {
      months: MONTHS,
      source_heat_available: monthly(gs, (g, i) => gridVal(g, "src", i)),
      sink_heat_demand: monthly(gk, (g, i) => demandAt(g, filters.mode, i)),
    } : null,
  };
}

function templateLetters(f) {
  const a = f.annual;
  const common = `${f.source.name} (${f.source.address}) and ${f.sink.name} (${f.sink.address}) are ${Math.round(f.link.distance_m)} m apart. ${f.link.tier}.`;
  return `TO: ${f.source.owner || "Owner"} — ${f.source.name}
RE: Turning your cooling-tower heat into revenue

${common}

Your building (${f.source.role.toLowerCase()}) rejects heat to the sky through its cooling equipment. Your neighbor burns ${f.sink.heats_with} to make ${f.link.serves}. Public data (NYC LL84 2024, the DOHMH cooling-tower registry) shows the two loads overlap ${Math.round(f.link.hour_overlap * 100)}% hour by hour.

A heat link could move about ${a.heat_reused_mmbtu.toLocaleString()} MMBtu a year. On your side that cuts cooling-tower water and chemical use (about $${a.cooling_tower_water_savings_usd.toLocaleString()}/yr) and opens a heat-sale income stream.

Next step: a 30-minute call and a joint feasibility study.

—

TO: ${f.sink.owner || "Owner"} — ${f.sink.name}
RE: Cutting your ${f.sink.heats_with} bill and LL97 exposure with your neighbor's waste heat

${common}

Recovered heat could cover ${Math.round(f.link.share_of_sink_demand_covered * 100)}% of your ${f.link.serves} demand, avoiding about ${a.tco2e_avoided.toLocaleString()} tCO2e a year${a.sink_is_nycha_article_321 ? " (helping meet NYCHA's LL97 Article 321 obligations)" : `, roughly $${a.ll97_penalty_avoided_usd.toLocaleString()}/yr of LL97 penalty exposure at $268/t`}, plus $${(a.fuel_savings_usd - a.heat_pump_electricity_usd).toLocaleString()}/yr in net energy savings.

Estimated installed cost is $${(a.installed_cost_range_usd[0] / 1e6).toFixed(1)}M–$${(a.installed_cost_range_usd[1] / 1e6).toFixed(1)}M${a.payback_range_years ? `, with a simple payback of ${a.payback_range_years[0]}–${a.payback_range_years[1]} years` : ""}. These are screening numbers from public data and need an engineering study to confirm.

— HeatMatch NYC (screening estimate, not an engineering design)`;
}

export default function PairDrawer({
  data, grids, pair, filters, setFilters, hour, month, onClose, onBack, focusEntry, embedded,
}) {
  const A = data.summary.assumptions;
  const s = data.buildings.get(pair.s), k = data.buildings.get(pair.k);
  const [elecPrice, setElecPrice] = useState(A.elec_usd_per_kwh);
  const [pipeMult, setPipeMult] = useState(1);
  const [letter, setLetter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // LL97 penalty savings always included in screening numbers
  const e = pairEcon(pair, k, A, { mode: filters.mode, storage: filters.storage, elecPrice, pipeMult, includeLL97: true });
  const match = heatMatchScore(pair, e, filters.mode);
  const coverage = pair[`coverage_${filters.mode}`] || 0;
  const gs = grids?.[pair.s], gk = grids?.[pair.k];
  const partner = focusEntry ? (focusEntry.id === s.id ? k : s) : null;
  const youGive = focusEntry ? focusEntry.id === s.id : null;

  const g = useMemo(() => {
    if (!gs || !gk) return null;
    const src = [], dem = [], matchVals = [];
    for (let i = 0; i < 288; i++) {
      const a = gridVal(gs, "src", i), d = demandAt(gk, filters.mode, i);
      src.push(a); dem.push(d); matchVals.push(Math.min(a, d));
    }
    return { src, dem, match: matchVals, srcMax: Math.max(...src), demMax: Math.max(...dem) };
  }, [gs, gk, filters.mode]);

  async function draft() {
    setBusy(true); setLetter(""); setNote("");
    const facts = buildFacts(data, grids, pair, filters, e);
    try {
      const r = await fetch("/api/proposal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(facts) });
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

  const modeLbl = filters.mode === "dhw" ? "hot water" : "hot water + space heat";
  // True energy net (fuel + water − heat-pump power). Can be negative when elec costs more than fuel saved.
  const energyNet = e.energy;
  const tone = match.label === "Strong" ? "hi" : match.label === "Worth a look" ? "mid" : "lo";

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

      {focusEntry && partner && (
        <div className="block pair-context">
          <div className="eyebrow">Your building</div>
          <div className="who-sm">{focusEntry.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {youGive
              ? (KIND_LABEL[s.source] || focusEntry.type || "Gives heat")
              : (focusEntry.type || FUEL_LABEL[k.fuel] || "Needs heat")}
          </div>
          <div className="pair-arrow">→</div>
          <div className="eyebrow">Partner</div>
          <div className="who-sm">{partner.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {youGive
              ? (partner.type || FUEL_LABEL[partner.fuel] || "Needs heat")
              : (KIND_LABEL[partner.source] || partner.type || "Gives heat")}
          </div>
        </div>
      )}

      <div className="block score-block">
        <div className="eyebrow">Heat match score</div>
        <div className="score-row">
          <div className={`score-ring s-${tone}`}>
            <b>{match.score}</b>
            <span>/100</span>
          </div>
          <div className="score-aside">
            <div className="score-label">{match.label}</div>
            <ul className="score-reasons">
              {match.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        </div>
      </div>

      <div className="block">
        <div className="eyebrow">Financial outlook</div>
        <div className="kpis two">
          <div className="kpi highlight"><div className="v">{fmt.yrRange(e.paybackLow, e.paybackHigh)}</div><div className="l">payback</div></div>
          <div className="kpi highlight"><div className="v">{fmt.usdRange(e.capexLow, e.capexHigh)}</div><div className="l">install cost</div></div>
          <div className="kpi"><div className="v" style={{ color: "var(--heat)" }}>{fmt.usd(e.value)}</div><div className="l">benefit / year</div></div>
          <div className="kpi">
            <div className={`v ${energyNet >= 0 ? "pos" : "neg"}`}>{fmt.usd(energyNet)}</div>
            <div className="l">{energyNet >= 0 ? "net energy save / yr" : "net energy cost / yr"}</div>
          </div>
        </div>
      </div>

      <div className="block">
        <div className="eyebrow">Environmental impact</div>
        <div className="kpis two">
          <div className="kpi highlight">
            <div className="v" style={{ color: "var(--good)" }}>{fmt.int(e.tco2e)} t</div>
            <div className="l">CO₂ avoided / year</div>
          </div>
          <div className="kpi">
            <div className="v">{fmt.big(e.mmbtu)}</div>
            <div className="l">heat reused / yr</div>
          </div>
        </div>
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
        <summary>Technical details</summary>
        <div className="block">
          <h4>How the pipe works</h4>
          <PipeCard pair={pair} s={s} k={k} A={A} mode={filters.mode} storage={filters.storage} pipeMult={pipeMult} />
        </div>
        <div className="block">
          <h4>When heat lines up</h4>
          {g ? (
            <div className="grids">
              <div>
                <div className="gridlbl"><span>Available</span><span>{fmt.big(pair.avail / 1000)}</span></div>
                <HeatGrid values={g.src} vmax={g.srcMax} palette="heat" month={month} hour={hour} />
              </div>
              <div>
                <div className="gridlbl"><span>Needed ({modeLbl})</span><span>{fmt.big(pair[`demand_${filters.mode}`] / 1000)}</span></div>
                <HeatGrid values={g.dem} vmax={g.demMax} palette="cold" month={month} hour={hour} />
              </div>
              <div>
                <div className="gridlbl"><span>Matched</span><span>{fmt.pct(coverage)} covered</span></div>
                <HeatGrid values={g.match} vmax={g.demMax} palette="match" month={month} hour={hour} />
              </div>
            </div>
          ) : <div className="note">Loading hourly profiles…</div>}
        </div>
        <div className="block">
          <h4>Cost line items</h4>
          {e.cost.items.map((it) => (
            <div key={it.label} className="econ-row">
              <span>{it.label}</span>
              <span>{fmt.usd(it.v[1])}</span>
            </div>
          ))}
          <div className="econ-row total"><span>Total (base)</span><span>{fmt.usd(e.capex)}</span></div>
          <div className="row" style={{ marginTop: 12 }}><span>Electricity price</span><b>${elecPrice.toFixed(2)}/kWh</b></div>
          <input type="range" min={0.1} max={0.3} step={0.01} value={elecPrice} onChange={(ev) => setElecPrice(+ev.target.value)} />
          <div className="row"><span>Pipe cost</span><b>{pipeMult.toFixed(1)}×</b></div>
          <input type="range" min={0.5} max={2.5} step={0.1} value={pipeMult} onChange={(ev) => setPipeMult(+ev.target.value)} />
          <div className="row"><span>Storage</span></div>
          <div className="seg">
            {A.storage_hours.map((h) => (
              <button key={h} className={filters.storage === h ? "on" : ""} onClick={() => setFilters((f) => ({ ...f, storage: h }))}>
                {h === 0 ? "None" : `${h} h`}
              </button>
            ))}
          </div>
          <div className="note" style={{ marginTop: 8 }}>Screening from public LL84 / NREL data — not an engineering quote.</div>
        </div>
      </details>
    </div>
  );
}
