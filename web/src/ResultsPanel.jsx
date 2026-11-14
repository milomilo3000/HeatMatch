import React from "react";
import { fmt, KIND_LABEL, FUEL_LABEL, TAB_LABEL } from "./econ.js";

// mirrors SINK_TYPES in pipeline/config.py
const HEAT_USER_TYPES = [
  "Multifamily Housing", "Residence Hall/Dormitory", "Senior Living Community", "Residential Care Facility",
  "Other - Lodging/Residential", "Hotel", "Fitness Center/Health Club/Gym",
];
import { crossingText } from "./pipe.js";

function roleLine(b, avail, tab) {
  const parts = [];
  if (tab === "dc" && b.dc) {
    parts.push(`Data center: ~${fmt.big(b.dc_heat_mmbtu)} MMBtu/yr of IT heat, ${b._owner?.kind === "dc"
      ? "from the IT load you entered" : b.dc_measured
        ? "from its measured IT load (LL84)" : "estimated from its data-center floor area"}`);
  } else if (tab === "commercial" && b.source) {
    const towers = b.towers ? ` through ${b.towers} cooling tower${b.towers > 1 ? "s" : ""}` : "";
    parts.push(`${KIND_LABEL[b.source]}: rejects heat${towers}${avail ? ` (~${fmt.big(avail)} MMBtu/yr usable)` : ""}`);
  }
  if (b.sink) parts.push(`Burns ~${fmt.big(b.heat_kbtu / 1000)} MMBtu/yr of ${FUEL_LABEL[b.fuel] || "fossil fuel"} for heat and hot water`);
  return parts;
}

export default function ResultsPanel({
  entry, building, partners, nearby, maxDist, setMaxDist, mode, setMode, selectedId, onSelect, onClose,
  tab, otherTabCount, onSwitchTab, intentChips, onClearIntent, onOwnerData, sortLabel,
}) {
  const otherTab = tab === "dc" ? "commercial" : "dc";
  const avail = partners.find((r) => r.youAreSource)?.p.avail / 1000;
  return (
    <aside className="results">
      <div className="you">
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <div className="eyebrow">Your building</div>
        <h2>{entry.name}</h2>
        <div className="muted">{entry.address}{entry.borough ? `, ${entry.borough}` : ""}</div>
        {entry.part_of && (
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Benchmarked as part of <b style={{ color: "var(--text)" }}>{entry.part_of}</b>; results below are for that building.
          </div>
        )}
        {building && roleLine(building, avail, tab).map((l) => <div key={l} className="role-line">{l}</div>)}
        {building && onOwnerData && (
          building._owner ? (
            <div className="owner-row on">
              <span className="conf m">Using your data</span>
              <button onClick={onOwnerData}>Edit or reset</button>
            </div>
          ) : (
            <div className="owner-row">
              <button onClick={onOwnerData}>Own this building? Use your real energy numbers →</button>
            </div>
          )
        )}
        {!building && entry.id >= 0 && (
          <div className="role-line">
            {entry.role.includes("s") ? "Rejects heat (cooling tower, IT or refrigeration)" : `Burns ~${fmt.int(entry.fuel_mmbtu)} MMBtu/yr of fossil fuel for heat`}
          </div>
        )}
      </div>

      {entry.id < 0 && (
        <div className="explain">
          <b>Not a heat-sharing candidate.</b> HeatMatch pairs buildings that throw heat away (data centers,
          refrigeration, hospitals and labs, or any building with a registered cooling tower) with apartment buildings,
          hotels, dorms, senior housing and gyms that buy at least 1,000 MMBtu a year of gas, oil or steam.{" "}
          {HEAT_USER_TYPES.includes(entry.type)
            ? `This building buys about ${fmt.int(entry.fuel_mmbtu)} MMBtu a year, below that threshold.`
            : `This ${entry.type ? entry.type.toLowerCase() : "building"} isn't recorded as having a cooling tower or data center, and isn't a heat-user type HeatMatch models yet.`}
        </div>
      )}

      {tab === "commercial" && entry.id >= 0 && (
        <div className="est-banner">
          <b>Estimates.</b> Cooling and refrigeration loads aren't metered publicly, so the heat these buildings
          reject is modeled from assumed cooling shares. Treat results as directional.
        </div>
      )}

      {entry.id >= 0 && (
        <>
          <div className="controls">
            <div className="ctl">
              <span>Max pipe run</span>
              <div className="seg">
                {[60, 100, 150].map((d) => (
                  <button key={d} className={maxDist === d ? "on" : ""} onClick={() => setMaxDist(d)}>{d} m</button>
                ))}
              </div>
            </div>
            <div className="ctl">
              <span>Heat used for</span>
              <div className="seg">
                <button className={mode === "dhw" ? "on" : ""} onClick={() => setMode("dhw")}>Hot water</button>
                <button className={mode === "all" ? "on" : ""} onClick={() => setMode("all")}>+ Space heat</button>
              </div>
            </div>
          </div>

          {intentChips && (
            <div className="intent-row">
              <span className="muted">You asked for:</span>
              {intentChips.map((c) => <span key={c} className="chip on">{c}</span>)}
              <button onClick={onClearIntent} aria-label="Clear the assistant's filter">clear</button>
            </div>
          )}

          <div className="list-head">
            {partners.length ? `${partners.length} potential partner${partners.length > 1 ? "s" : ""}` : "No partners found"}
            {partners.length > 0 && <span>estimates · {sortLabel || "best payback"} first</span>}
          </div>

          <div className="partners">
            {partners.map(({ p, e, other, youAreSource }, i) => (
              <button key={p.id} className={`partner ${p.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(p.id)}>
                <span className={`num ${youAreSource ? "snk" : "src"}`}>{i + 1}</span>
                <span className="pbody">
                  <span className="pname">{other.name}{e.cost.quoted && <span className="conf m">your quote</span>}</span>
                  <span className="prole">
                    {youAreSource
                      ? "Can use your waste heat"
                      : tab === "dc" ? "Data center that can supply you heat" : `Can supply you heat (${KIND_LABEL[other.source]?.toLowerCase()})`}
                    {" · "}{Math.round(p.dist_m)} m, {crossingText(p)}
                    {tab === "dc" && !youAreSource && (
                      <span className={`conf ${other.dc_measured ? "m" : "e"}`}>{other.dc_measured ? "measured" : "estimated"}</span>
                    )}
                  </span>
                  <span className="pstats">
                    <span><em>Est. cost</em>{fmt.usdRange(e.capexLow, e.capexHigh)}</span>
                    <span><em>Est. value/yr</em>{fmt.usd(e.value)}</span>
                    <span><em>Est. payback</em>{fmt.yrRange(e.paybackLow, e.paybackHigh)}</span>
                    <span><em>Est. CO₂/yr</em>{fmt.big(e.tco2e)} t</span>
                  </span>
                </span>
              </button>
            ))}

            {!partners.length && (
              <div className="explain">
                No {tab === "dc" ? "data-center " : ""}partner within {maxDist} m passed the screen. A partner has to be
                close enough for a short pipe run and need heat in the same hours yours is available (or vice versa).
                {maxDist < 150 && (
                  <div style={{ marginTop: 8 }}>
                    <button className="ghost-btn" onClick={() => setMaxDist(150)}>Search up to 150 m</button>
                  </div>
                )}
                {nearby.length > 0 && (
                  <>
                    <div className="eyebrow" style={{ marginTop: 14 }}>Farther away (not modeled)</div>
                    {nearby.map(({ e: n, d }) => (
                      <div key={n.id} className="nearby"><span>{n.name}</span><span>{Math.round(d)} m</span></div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          {otherTabCount > 0 && (
            <button className="switch-tab" onClick={onSwitchTab}>
              {otherTabCount} more match{otherTabCount > 1 ? "es" : ""} in the {TAB_LABEL[otherTab]} tab →
            </button>
          )}
          {partners.length > 0 && (
            <div className="foot">
              Costs are installed-cost ranges (equipment, building hookup, engineering, contingency) from public data.
              Screening estimates, not quotes.
            </div>
          )}
        </>
      )}
    </aside>
  );
}
