import React from "react";
import { fmt, KIND_LABEL, FUEL_LABEL, TAB_LABEL } from "./econ.js";

const HEAT_USER_TYPES = [
  "Multifamily Housing", "Residence Hall/Dormitory", "Senior Living Community", "Residential Care Facility",
  "Other - Lodging/Residential", "Hotel", "Fitness Center/Health Club/Gym",
];

function roleLabel(building, entry, tab) {
  if (tab === "dc" && building?.dc) {
    return building.dc_measured ? "Data center · measured IT heat" : "Data center · estimated IT heat";
  }
  if (building?.source && building?.sink) return "Can give and use heat";
  if (building?.source) return `Gives away heat · ${(KIND_LABEL[building.source] || "source").toLowerCase()}`;
  if (building?.sink) return `Needs heat · ${FUEL_LABEL[building.fuel] || "fuel"}`;
  if (entry.role?.includes("s") && entry.role?.includes("k")) return "Can give and use heat";
  if (entry.role?.includes("d") || entry.role?.includes("s")) return tab === "dc" ? "Gives away heat" : "Gives away heat";
  if (entry.role?.includes("k")) return "Needs heat";
  return null;
}

export default function ResultsPanel({
  entry, building, partners, nearby, mode, setMode, selectedId, onSelect, onClose,
  tab, otherTabCount, onSwitchTab, intentChips, onClearIntent, onOwnerData, sortLabel,
}) {
  const role = roleLabel(building, entry, tab);
  const otherTab = tab === "dc" ? "commercial" : "dc";

  return (
    <aside className="results">
      <div className="you">
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <div className="eyebrow">Your building</div>
        <h2>{entry.name}</h2>
        <div className="muted">{entry.address}{entry.borough ? `, ${entry.borough}` : ""}</div>
        {role && <div className="role-pill">{role}</div>}
        {entry.part_of && (
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            Shown as part of {entry.part_of}
          </div>
        )}
        {building && onOwnerData && (
          building._owner ? (
            <div className="owner-row on">
              <span className="conf m">Using your data</span>
              <button type="button" onClick={onOwnerData}>Edit or reset</button>
            </div>
          ) : (
            <div className="owner-row">
              <button type="button" onClick={onOwnerData}>Own this building? Use your real energy numbers →</button>
            </div>
          )
        )}
      </div>

      {entry.id < 0 && (
        <div className="explain">
          <b>No match for this building.</b>{" "}
          {HEAT_USER_TYPES.includes(entry.type)
            ? "Its fuel use is below the threshold we screen."
            : "It isn’t recorded as a waste-heat source or a large heat user."}
        </div>
      )}

      {tab === "commercial" && entry.id >= 0 && (
        <div className="est-banner">
          <b>Estimates.</b> Cooling and refrigeration loads aren’t metered publicly — treat results as directional.
        </div>
      )}

      {entry.id >= 0 && (
        <>
          {intentChips && (
            <div className="intent-row">
              <span className="muted">You asked for:</span>
              {intentChips.map((c) => <span key={c} className="chip on">{c}</span>)}
              <button type="button" onClick={onClearIntent} aria-label="Clear the assistant's filter">clear</button>
            </div>
          )}

          <div className="list-head">
            {partners.length ? `${partners.length} partner${partners.length > 1 ? "s" : ""}` : "No partners"}
            {partners.length > 0 && sortLabel && <span>{sortLabel} first</span>}
          </div>

          <div className="partners">
            {partners.map(({ p, e, other, match, youAreSource }, i) => {
              const tone = match.label === "Strong" ? "hi" : match.label === "Worth a look" ? "mid" : "lo";
              return (
                <button
                  key={p.id}
                  className={`partner ${p.id === selectedId ? "sel" : ""}`}
                  onClick={() => onSelect(p.id)}
                >
                  <span className={`num ${youAreSource ? "snk" : "src"}`}>{i + 1}</span>
                  <span className="pbody">
                    <span className="pname">
                      {other.name}
                      {e.cost?.quoted && <span className="conf m">your quote</span>}
                    </span>
                    <span className="pstats pstats-2 pstats-lg">
                      <span className="stat-primary"><em>Payback</em>{fmt.yrRange(e.paybackLow, e.paybackHigh)}</span>
                      <span className="stat-primary"><em>Est. cost</em>{fmt.usdRange(e.capexLow, e.capexHigh)}</span>
                    </span>
                  </span>
                  <span className={`match-score s-${tone}`} title={`Heat match score ${match.score}/100 · ${match.label}`}>
                    <b>{match.score}</b>
                  </span>
                </button>
              );
            })}

            {!partners.length && (
              <div className="explain">
                <b>No partners found nearby.</b>
                {nearby.length > 0 && (
                  <>
                    <div className="eyebrow" style={{ marginTop: 14 }}>Closest opposite buildings</div>
                    {nearby.slice(0, 3).map(({ e: n, d }) => (
                      <div key={n.id} className="nearby">
                        <span>{n.name}</span>
                        <span>~{Math.round(d * 3.281)} ft</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {otherTabCount > 0 && (
            <button type="button" className="switch-tab" onClick={onSwitchTab}>
              {otherTabCount} more match{otherTabCount > 1 ? "es" : ""} in {TAB_LABEL[otherTab]} →
            </button>
          )}

          {partners.length > 0 && (
            <div className="foot">
              Screening estimates — not quotes.
              <details className="foot-opts">
                <summary>Options</summary>
                <div className="ctl" style={{ marginTop: 8 }}>
                  <span>Heat serves</span>
                  <div className="seg">
                    <button type="button" className={mode === "dhw" ? "on" : ""} onClick={() => setMode("dhw")}>Hot water</button>
                    <button type="button" className={mode === "all" ? "on" : ""} onClick={() => setMode("all")}>+ Heating</button>
                  </div>
                </div>
              </details>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
