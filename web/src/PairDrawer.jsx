import React, { useMemo, useState } from "react";
import HeatGrid from "./HeatGrid.jsx";
import PipeCard from "./PipeCard.jsx";
import { pairEcon, gridVal, demandAt, fmt, KIND_LABEL, FUEL_LABEL, MONTHS } from "./econ.js";

const TIER_NOTE = {
  1: "Buildings touch — pipe through the party wall, no easement",
  2: "Same tax block — private easement only, no street work",
  3: "Across one street — needs a NYC DOT revocable consent",
  4: "Longer run — multiple lots or streets",
};

function monthly(g, fn) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += fn(g, m * 24 + h);
    out.push(Math.round((s * 30.4) / 1000)); // MMBtu per month (approx)
  }
  return out;
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
      ll97_penalty_avoided_usd: Math.round(e.ll97), total_value_usd: Math.round(e.value), capex_usd: Math.round(e.capex),
      simple_payback_years: e.payback ? +e.payback.toFixed(1) : null },
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

Recovered heat could cover ${Math.round(f.link.share_of_sink_demand_covered * 100)}% of your ${f.link.serves} demand, avoiding about ${a.tco2e_avoided.toLocaleString()} tCO2e a year. That is roughly $${a.ll97_penalty_avoided_usd.toLocaleString()}/yr of LL97 penalty exposure at $268/t, plus $${(a.fuel_savings_usd - a.heat_pump_electricity_usd).toLocaleString()}/yr in net energy savings.

Estimated capital cost is $${(a.capex_usd / 1e6).toFixed(1)}M, with a simple payback of ${a.simple_payback_years ?? "n/a"} years. These are screening numbers from public data and need an engineering study to confirm.

— HeatMatch NYC (screening estimate, not an engineering design)`;
}

export default function PairDrawer({ data, grids, pair, filters, setFilters, hour, month, onClose }) {
  const A = data.summary.assumptions;
  const s = data.buildings.get(pair.s), k = data.buildings.get(pair.k);
  const [elecPrice, setElecPrice] = useState(A.elec_usd_per_kwh);
  const [pipeMult, setPipeMult] = useState(1);
  const [includeLL97, setIncludeLL97] = useState(true);
  const [letter, setLetter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const e = pairEcon(pair, k, A, { mode: filters.mode, storage: filters.storage, elecPrice, pipeMult, includeLL97 });
  const gs = grids?.[pair.s], gk = grids?.[pair.k];

  const g = useMemo(() => {
    if (!gs || !gk) return null;
    const src = [], dem = [], match = [];
    for (let i = 0; i < 288; i++) {
      const a = gridVal(gs, "src", i), d = demandAt(gk, filters.mode, i);
      src.push(a); dem.push(d); match.push(Math.min(a, d));
    }
    // source on its own scale; demand and matched share one so "covered" reads at a glance
    return { src, dem, match, srcMax: Math.max(...src), demMax: Math.max(...dem) };
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
  return (
    <div className="drawer">
      <header>
        <button className="close" onClick={onClose}>×</button>
        <div className="party">
          <div className="src">
            <div className="who">{s.name}</div>
            <div className="sub">{KIND_LABEL[s.source]} · {s.type}</div>
            <div className="sub">{s.owner || "owner n/a"}</div>
          </div>
          <div className="mid">→</div>
          <div className="snk">
            <div className="who">{k.name}</div>
            <div className="sub">{k.type}{k.units ? ` · ${k.units} units` : ""} · {FUEL_LABEL[k.fuel]}</div>
            <div className="sub">{k.owner || "owner n/a"}</div>
          </div>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <span className={`badge t${pair.tier}`}>{Math.round(pair.dist_m)} m · {A.tier_label[pair.tier]}</span>
          <span className="note">{TIER_NOTE[pair.tier]}</span>
        </div>
      </header>

      <div className="block">
        <div className="kpis">
          <div className="kpi"><div className="v" style={{ color: "var(--heat)" }}>{fmt.int(e.mmbtu)}</div><div className="l">MMBtu/yr reused</div></div>
          <div className="kpi"><div className="v" style={{ color: "var(--good)" }}>{fmt.int(e.tco2e)}</div><div className="l">tCO₂e/yr avoided</div></div>
          <div className="kpi"><div className="v">{fmt.yr(e.payback)}</div><div className="l">simple payback</div></div>
        </div>
      </div>

      <PipeCard pair={pair} s={s} k={k} A={A} mode={filters.mode} storage={filters.storage} pipeMult={pipeMult} />

      <div className="block">
        <h4>When is the heat there, and when is it needed?</h4>
        {g ? (
          <div className="grids">
            <div>
              <div className="gridlbl"><span>Waste heat available · <b>{s.name}</b></span><span>{fmt.big(pair.avail / 1000)} MMBtu/yr</span></div>
              <HeatGrid values={g.src} vmax={g.srcMax} palette="heat" month={month} hour={hour} />
            </div>
            <div>
              <div className="gridlbl"><span>Heat demand ({modeLbl}) · <b>{k.name}</b></span><span>{fmt.big(pair[`demand_${filters.mode}`] / 1000)} MMBtu/yr</span></div>
              <HeatGrid values={g.dem} vmax={g.demMax} palette="cold" month={month} hour={hour} />
            </div>
            <div>
              <div className="gridlbl"><span>Matched in the same hour</span><span>{fmt.pct(pair[`coincidence_${filters.mode}`])} overlap · covers {fmt.pct(pair[`coverage_${filters.mode}`])} of demand</span></div>
              <HeatGrid values={g.match} vmax={g.demMax} palette="match" month={month} hour={hour} />
            </div>
            <div className="note">Rows = Jan→Dec, columns = midnight→11 pm. The white box is the hour on the time bar. Modeled from LL84 energy use × NREL hourly load shapes.</div>
          </div>
        ) : <div className="note">Loading hourly profiles…</div>}
      </div>

      <div className="block">
        <h4>Economics (per year)</h4>
        <div className="econ-row"><span>Fuel no longer bought ({FUEL_LABEL[k.fuel]})</span><span className="pos">+{fmt.usd(e.fuelUsd)}</span></div>
        <div className="econ-row"><span>Heat-pump electricity (COP {A.hp_cop})</span><span className="neg">−{fmt.usd(e.elecUsd)}</span></div>
        <div className="econ-row"><span>Cooling-tower water saved</span><span className="pos">+{fmt.usd(e.waterUsd)}</span></div>
        <div className="econ-row"><span>Energy + water net</span><span className={e.energy >= 0 ? "pos" : "neg"}>{fmt.usd(e.energy)}</span></div>
        <div className="econ-row">
          <label><input type="checkbox" checked={includeLL97} onChange={(ev) => setIncludeLL97(ev.target.checked)} /> LL97 penalty avoided (${A.ll97_usd_per_t}/t)</label>
          <span className="pos">+{fmt.usd(e.ll97)}</span>
        </div>
        <div className="econ-row total"><span>Annual value</span><span>{fmt.usd(e.value)}</span></div>
        <div className="econ-row"><span>Capex: pipe {fmt.usd(e.pipeUsd)} + heat pump {fmt.usd(e.hpUsd)}</span><span>{fmt.usd(e.capex)}</span></div>
        <div className="row" style={{ marginTop: 10 }}><span>Electricity price</span><b>${elecPrice.toFixed(2)}/kWh</b></div>
        <input type="range" min={0.1} max={0.3} step={0.01} value={elecPrice} onChange={(ev) => setElecPrice(+ev.target.value)} />
        <div className="row"><span>Pipe cost multiplier</span><b>{pipeMult.toFixed(1)}×</b></div>
        <input type="range" min={0.5} max={2.5} step={0.1} value={pipeMult} onChange={(ev) => setPipeMult(+ev.target.value)} />
        <div className="row"><span>Thermal storage</span></div>
        <div className="seg">
          {A.storage_hours.map((h) => (
            <button key={h} className={filters.storage === h ? "on" : ""} onClick={() => setFilters((f) => ({ ...f, storage: h }))}>
              {h === 0 ? "None" : `${h} h tank`}
            </button>
          ))}
        </div>
      </div>

      <div className="block">
        <h4>Proposal to both owners</h4>
        <button className="cta" onClick={draft} disabled={busy}>{busy ? "Drafting…" : letter ? "Redraft proposal" : "Draft proposal"}</button>
        {note && <div className="note" style={{ marginTop: 6 }}>{note}</div>}
        {letter && (
          <>
            <div className="letter">{letter}</div>
            <div className="btnrow">
              <button className="ghost" onClick={() => navigator.clipboard.writeText(letter)}>Copy</button>
              <button className="ghost" onClick={download}>Download .md</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
