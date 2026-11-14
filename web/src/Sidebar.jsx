import React, { useMemo } from "react";
import { pairEcon, fmt, KIND_LABEL } from "./econ.js";
import { Savings } from "./ResultsPanel.jsx";

const TIERS = { 1: "Wall", 2: "Block", 3: "Street", 4: "Farther" };
const ROUTE = { 1: "Wall", 2: "Block", 3: "Street", 4: "Farther" };

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
      savings: (r) => -r.e.value,
      dist: (r) => r.p.dist_m,
    }[filters.sort] || ((r) => -r.e.tco2e);
    return rows.sort((a, b) => key(a) - key(b)).slice(0, 80);
  }, [pairs, filters.sort, filters.mode, filters.storage, data, A]);

  const rankedChains = useMemo(() => {
    const key = {
      tco2e: (c) => -c.m.tco2e,
      savings: (c) => -c.m.value,
      dist: (c) => c.m.pipeM,
    }[filters.sort] || ((c) => -c.m.tco2e);
    return [...chains].sort((a, b) => key(a) - key(b)).slice(0, 80);
  }, [chains, filters.sort]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="eyebrow">Citywide</div>
        {totals ? (
          <h2 className="sidebar-title">
            {fmt.int(totals.pairs)} priority matches
          </h2>
        ) : (
          <h2 className="sidebar-title">City matches</h2>
        )}
        {totals && (
          <div className="summary-line plain">
            ~<b>{fmt.big(totals.tco2e)}</b> tons CO₂/year if built
          </div>
        )}
      </div>

      <section>
        <div className="row" style={{ marginTop: 0 }}>
          <span>Max distance</span>
          <b>~{Math.round(filters.maxDist * 3.281)} ft</b>
        </div>
        <input type="range" min={5} max={150} step={5} value={filters.maxDist}
          onChange={(e) => set("maxDist", +e.target.value)} />
        <div className="chips" style={{ marginTop: 8 }}>
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
            <span>Loop size</span>
          </div>
          <div className="seg" title="Pair = two buildings. Higher = multi-building heat loop.">
            {[2, 3, 4, 5, 6].map((n) => (
              <button key={n} className={filters.chainSize === n ? "on" : ""} onClick={() => set("chainSize", n)}>
                {n === 2 ? "Pair" : n}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span>Timing fit</span>
            <b>{fmt.pct(filters.minCoincidence)}</b>
          </div>
          <input type="range" min={0} max={0.95} step={0.05} value={filters.minCoincidence}
            onChange={(e) => set("minCoincidence", +e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <span>Heat serves</span>
          </div>
          <div className="seg">
            <button className={filters.mode === "dhw" ? "on" : ""} onClick={() => set("mode", "dhw")}>Hot water</button>
            <button className={filters.mode === "all" ? "on" : ""} onClick={() => set("mode", "all")}>+ Heating</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span>Storage</span>
          </div>
          <div className="seg">
            {A.storage_hours.map((h) => (
              <button key={h} className={filters.storage === h ? "on" : ""} onClick={() => set("storage", h)}>
                {h === 0 ? "None" : `${h} h`}
              </button>
            ))}
          </div>
          {tab === "commercial" && (
            <>
              <div className="row" style={{ marginTop: 8 }}><span>Source type</span></div>
              <div className="chips">
                {Object.entries(KIND_LABEL).filter(([k]) => k !== "datacenter").map(([k, label]) => (
                  <button key={k} type="button" className={`chip ${filters.kinds.includes(k) ? "on" : ""}`} onClick={() => toggle("kinds", k)}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </details>

      <section style={{ paddingBottom: 6 }}>
        <div className="row" style={{ margin: 0 }}>
          <h3 style={{ margin: 0 }}>
            {chainMode
              ? (chainsBusy ? "Searching…" : `${fmt.int(chains.length)} loops`)
              : `${fmt.int(pairs.length)} listed`}
          </h3>
          <div className="seg" style={{ width: 168 }}>
            {[["tco2e", "CO₂"], ["savings", "Savings"], ["dist", "Near"]].map(([k, l]) => (
              <button key={k} className={filters.sort === k ? "on" : ""} onClick={() => set("sort", k)}>{l}</button>
            ))}
          </div>
        </div>
      </section>

      {chainMode && (
        <div className="list">
          {chainsBusy && <div className="note" style={{ padding: 12 }}>Finding multi-building loops…</div>}
          {!chainsBusy && rankedChains.map((c) => {
            const names = c.ids.map((id) => data.buildings.get(id).name);
            return (
              <div key={c.key} className={`item ${c.key === chainKey ? "sel" : ""}`} onClick={() => onSelectChain(c.key)}>
                <div className="names" title={names.join(" → ")}>
                  {names[0]}<span className="arrow">→</span>{names.slice(1).join(" → ")}
                </div>
                <div className="meta">
                  <span>{fmt.usdRange(c.m.capexLow, c.m.capexHigh)}</span>
                  <Savings value={c.m.value} />
                  <span>{fmt.big(c.m.tco2e)} t CO₂/yr</span>
                </div>
              </div>
            );
          })}
          {!chainsBusy && !rankedChains.length && (
            <div className="note" style={{ padding: 12 }}>No loops fit. Widen distance in More filters.</div>
          )}
        </div>
      )}

      {!chainMode && (
        <div className="list">
          {ranked.map(({ p, e }) => {
            const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
            return (
              <div key={p.id} className={`item ${p.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(p.id)}>
                <div className="names" title={`${s.name} → ${k.name}`}>
                  {s.name}<span className="arrow">→</span>{k.name}
                </div>
                <div className="meta">
                  <span className={`badge t${p.tier}`}>{ROUTE[p.tier]}</span>
                  {tab !== "dc" && <span>{srcLabel(s)}</span>}
                  <span>{fmt.usdRange(e.capexLow, e.capexHigh)}</span>
                  <Savings value={e.value} />
                  <span>{fmt.big(e.tco2e)} t CO₂/yr</span>
                </div>
              </div>
            );
          })}
          {!ranked.length && (
            <div className="note" style={{ padding: 12 }}>No matches. Widen distance or open More filters.</div>
          )}
        </div>
      )}
    </aside>
  );
}
