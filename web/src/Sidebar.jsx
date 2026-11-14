import React, { useMemo } from "react";
import { pairEcon, fmt, KIND_LABEL } from "./econ.js";

const TIERS = { 1: "Shared wall", 2: "Same block", 3: "Across street", 4: "Further" };

export default function Sidebar({ data, filters, setFilters, pairs, selectedId, onSelect }) {
  const A = data.summary.assumptions;
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (k, v) =>
    setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  const ranked = useMemo(() => {
    const opts = { mode: filters.mode, storage: filters.storage };
    const rows = pairs.map((p) => ({ p, e: pairEcon(p, data.buildings.get(p.k), A, opts) }));
    const key = {
      tco2e: (r) => -r.e.tco2e,
      payback: (r) => (r.e.payback == null ? 1e9 : r.e.payback),
      dist: (r) => r.p.dist_m,
    }[filters.sort];
    return rows.sort((a, b) => key(a) - key(b)).slice(0, 80);
  }, [pairs, filters.sort, filters.mode, filters.storage, data, A]);

  return (
    <aside className="sidebar">
      <section>
        <h3>Distance</h3>
        <div className="row">
          <span>Max pipe run</span>
          <b>{filters.maxDist} m</b>
        </div>
        <input type="range" min={5} max={150} step={5} value={filters.maxDist}
          onChange={(e) => set("maxDist", +e.target.value)} />
        <div className="chips" style={{ marginTop: 6 }}>
          {[1, 2, 3, 4].map((t) => (
            <button key={t} className={`chip ${filters.tiers.includes(t) ? "on" : ""}`} onClick={() => toggle("tiers", t)}>
              {TIERS[t]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Timing</h3>
        <div className="row">
          <span>Min. hour-by-hour overlap</span>
          <b>{fmt.pct(filters.minCoincidence)}</b>
        </div>
        <input type="range" min={0} max={0.95} step={0.05} value={filters.minCoincidence}
          onChange={(e) => set("minCoincidence", +e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <span>Heat serves</span>
        </div>
        <div className="seg">
          <button className={filters.mode === "dhw" ? "on" : ""} onClick={() => set("mode", "dhw")}>Hot water only</button>
          <button className={filters.mode === "all" ? "on" : ""} onClick={() => set("mode", "all")}>Hot water + space heat</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span>Thermal storage tank</span>
        </div>
        <div className="seg">
          {A.storage_hours.map((h) => (
            <button key={h} className={filters.storage === h ? "on" : ""} onClick={() => set("storage", h)}>
              {h === 0 ? "None" : `${h} h`}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Heat source</h3>
        <div className="chips">
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <button key={k} className={`chip ${filters.kinds.includes(k) ? "on" : ""}`} onClick={() => toggle("kinds", k)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section style={{ paddingBottom: 6 }}>
        <div className="row" style={{ margin: 0 }}>
          <h3 style={{ margin: 0 }}>{fmt.int(pairs.length)} matches</h3>
          <div className="seg" style={{ width: 170 }}>
            {[["tco2e", "CO₂"], ["payback", "Payback"], ["dist", "Closest"]].map(([k, l]) => (
              <button key={k} className={filters.sort === k ? "on" : ""} onClick={() => set("sort", k)}>{l}</button>
            ))}
          </div>
        </div>
      </section>

      <div className="list">
        {ranked.map(({ p, e }) => {
          const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
          return (
            <div key={p.id} className={`item ${p.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(p.id)}>
              <div className="names" title={`${s.name} → ${k.name}`}>
                {s.name}<span className="arrow">→</span>{k.name}
              </div>
              <div className="meta">
                <span className={`badge t${p.tier}`}>{Math.round(p.dist_m)} m</span>
                <span>{KIND_LABEL[s.source]}</span>
                <span>{fmt.big(e.tco2e)} t</span>
                <span>{fmt.pct(p[`coincidence_${filters.mode}`])}</span>
                <span>{e.payback ? `${e.payback.toFixed(0)}y` : "—"}</span>
              </div>
            </div>
          );
        })}
        {!ranked.length && <div className="note" style={{ padding: 12 }}>No pairs match these filters.</div>}
      </div>
    </aside>
  );
}
