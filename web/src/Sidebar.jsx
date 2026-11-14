import React, { useMemo } from "react";
import { pairEcon, fmt, KIND_LABEL } from "./econ.js";

const TIERS = { 1: "Shared wall", 2: "No street", 3: "One street", 4: "Several streets" };

export default function Sidebar({ data, filters, setFilters, pairs, totals, tab, selectedId, onSelect, chains, chainsBusy, chainKey, onSelectChain }) {
  const srcLabel = (b) => (tab === "dc" ? (b.dc_measured ? "Data center · measured" : "Data center · est.") : KIND_LABEL[b.source]);
  const chainMode = filters.chainSize > 2;
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

  const rankedChains = useMemo(() => {
    const key = {
      tco2e: (c) => -c.m.tco2e,
      payback: (c) => (c.m.payback == null ? 1e9 : c.m.payback),
      dist: (c) => c.m.pipeM,
    }[filters.sort];
    return [...chains].sort((a, b) => key(a) - key(b)).slice(0, 80);
  }, [chains, filters.sort]);

  return (
    <aside className="sidebar">
      {totals && (
        <div className="summary-line">
          {fmt.int(totals.pairs)} pairs with positive value · est. <b>{fmt.big(totals.tco2e)}</b> tCO₂e/yr avoidable
        </div>
      )}
      <section>
        <h3>Pipeline</h3>
        <div className="row" style={{ marginTop: 0 }}>
          <span>Buildings on one pipe</span>
        </div>
        <div className="seg" title="2 = one source → one user. 3–6 = one source feeding a chain of users, building to building.">
          {[2, 3, 4, 5, 6].map((n) => (
            <button key={n} className={filters.chainSize === n ? "on" : ""} onClick={() => set("chainSize", n)}>
              {n === 2 ? "2 (pair)" : n}
            </button>
          ))}
        </div>
        <div className="row">
          <span>{chainMode ? "Max pipe run per hop" : "Max pipe run"}</span>
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

      <details className="more">
        <summary>More filters</summary>
      <section>
        <div className="row" style={{ marginTop: 0 }}>
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

      {tab === "commercial" && <section>
        <div className="row" style={{ marginTop: 0 }}><span>Heat source</span></div>
        <div className="chips">
          {Object.entries(KIND_LABEL).filter(([k]) => k !== "datacenter").map(([k, label]) => (
            <button key={k} className={`chip ${filters.kinds.includes(k) ? "on" : ""}`} onClick={() => toggle("kinds", k)}>
              {label}
            </button>
          ))}
        </div>
      </section>}
      </details>

      <section style={{ paddingBottom: 6 }}>
        <div className="row" style={{ margin: 0 }}>
          <h3 style={{ margin: 0 }}>
            {chainMode ? (chainsBusy ? "Searching…" : `${fmt.int(chains.length)} chains`) : `${fmt.int(pairs.length)} matches`}
          </h3>
          <div className="seg" style={{ width: 170 }}>
            {[["tco2e", "CO₂"], ["payback", "Payback"], ["dist", "Closest"]].map(([k, l]) => (
              <button key={k} className={filters.sort === k ? "on" : ""} onClick={() => set("sort", k)}>{l}</button>
            ))}
          </div>
        </div>
      </section>

      {chainMode && (
        <div className="list">
          {chainsBusy && <div className="note" style={{ padding: 12 }}>Growing {filters.chainSize}-building chains from every heat source…</div>}
          {!chainsBusy && rankedChains.map((c) => {
            const names = c.ids.map((id) => data.buildings.get(id).name);
            return (
              <div key={c.key} className={`item ${c.key === chainKey ? "sel" : ""}`} onClick={() => onSelectChain(c.key)}>
                <div className="names" title={names.join(" → ")}>
                  {names[0]}<span className="arrow">→</span>{names.slice(1).join(" → ")}
                </div>
                <div className="meta">
                  <span className={`badge t${Math.max(...c.hops.map((h) => h.tier))}`}>{Math.round(c.m.pipeM)} m pipe</span>
                  <span>{KIND_LABEL[c.kind]}</span>
                  <span>{fmt.big(c.m.tco2e)} t</span>
                  <span>{fmt.pct(c.m.coverage)} met</span>
                  <span title="Estimated simple payback">{c.m.payback ? `~${c.m.payback.toFixed(0)}y` : "—"}</span>
                </div>
              </div>
            );
          })}
          {!chainsBusy && !rankedChains.length && (
            <div className="note" style={{ padding: 12 }}>
              No {filters.chainSize}-building chains fit these filters. Try a longer max pipe run per hop or a lower overlap.
            </div>
          )}
        </div>
      )}

      {!chainMode && <div className="list">
        {ranked.map(({ p, e }) => {
          const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
          return (
            <div key={p.id} className={`item ${p.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(p.id)}>
              <div className="names" title={`${s.name} → ${k.name}`}>
                {s.name}<span className="arrow">→</span>{k.name}
              </div>
              <div className="meta">
                <span className={`badge t${p.tier}`}>{Math.round(p.dist_m)} m</span>
                <span>{srcLabel(s)}</span>
                <span>{fmt.big(e.tco2e)} t</span>
                <span>{fmt.pct(p[`coincidence_${filters.mode}`])}</span>
                <span title="Estimated simple payback">{e.payback ? `~${e.payback.toFixed(0)}y` : "—"}</span>
              </div>
            </div>
          );
        })}
        {!ranked.length && <div className="note" style={{ padding: 12 }}>No pairs match these filters.</div>}
      </div>}
    </aside>
  );
}
