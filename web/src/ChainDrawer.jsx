import React, { useMemo } from "react";
import HeatGrid from "./HeatGrid.jsx";
import { scoreChain } from "./chain.js";
import { ROUTE, LOOP } from "./pipe.js";
import { fmt, KIND_LABEL, FUEL_LABEL } from "./econ.js";

const TIER_SHORT = { 1: "Shared wall", 2: "Same block", 3: "Across one street", 4: "Further" };

export default function ChainDrawer({ data, grids, chain, filters, hour, month, onClose }) {
  const A = data.summary.assumptions;
  const get = (id) => data.buildings.get(id);
  const src = get(chain.ids[0]);
  // recompute with grids for the charts (same numbers as the list, plus 12x24 series)
  const m = useMemo(
    () => scoreChain(chain.ids, chain.hops, { grids, buildings: data.buildings, A, mode: filters.mode }, true),
    [chain, grids, data, A, filters.mode],
  );
  const vmax = Math.max(...m.grids.src, ...m.grids.dem);
  const demMax = Math.max(...m.grids.dem);
  const used = m.mmbtu / Math.max(1, m.srcMmbtu);
  const modeLbl = filters.mode === "dhw" ? "hot water" : "hot water + space heat";

  return (
    <div className="drawer">
      <header>
        <button className="close" onClick={onClose}>×</button>
        <div className="note" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>
          Pipeline chain · {chain.ids.length} buildings · {Math.round(m.pipeM)} m of pipe
        </div>
        <div style={{ marginTop: 6, fontWeight: 600, lineHeight: 1.35 }}>
          <span style={{ color: "var(--heat)" }}>{src.name}</span>
          {chain.ids.slice(1).map((id) => (
            <span key={id}><span style={{ color: "var(--muted)" }}> → </span><span style={{ color: "var(--cold)" }}>{get(id).name}</span></span>
          ))}
        </div>
      </header>

      <div className="block">
        <div className="kpis">
          <div className="kpi"><div className="v" style={{ color: "var(--heat)" }}>{fmt.int(m.mmbtu)}</div><div className="l">MMBtu/yr reused</div></div>
          <div className="kpi"><div className="v" style={{ color: "var(--good)" }}>{fmt.int(m.tco2e)}</div><div className="l">tCO₂e/yr avoided</div></div>
          <div className="kpi"><div className="v">{fmt.yrRange(m.paybackLow, m.paybackHigh)}</div><div className="l">simple payback</div></div>
        </div>
      </div>

      <div className="block">
        <h4>The route, stop by stop</h4>
        <ol className="stops">
          <li className="stop src">
            <span className="dot">S</span>
            <div>
              <b>{src.name}</b>
              <div className="note">{KIND_LABEL[src.source]} · {fmt.int(m.srcMmbtu)} MMBtu/yr of usable waste heat · {src.owner || "owner n/a"}</div>
            </div>
          </li>
          {chain.hops.map((h, i) => {
            const b = get(h.to);
            const u = m.users[i];
            return (
              <React.Fragment key={h.to}>
                <li className="hop">
                  <span className={`badge t${h.tier}`}>{Math.round(h.dist)} m</span>
                  <span className="note">{TIER_SHORT[h.tier]}: {ROUTE[h.tier].permit}</span>
                </li>
                <li className="stop">
                  <span className="dot">{i + 1}</span>
                  <div>
                    <b>{b.name}</b>
                    <div className="note">
                      {b.type}{b.units ? ` · ${b.units} units` : ""} · burns {FUEL_LABEL[b.fuel] || b.fuel} · {b.owner || "owner n/a"}
                    </div>
                    <div className="share">
                      <div className="bar"><i style={{ width: `${Math.round(Math.min(1, u.coverage) * 100)}%` }} /></div>
                      <span>gets {fmt.int(u.mmbtu)} MMBtu/yr · {fmt.pct(u.coverage)} of its {modeLbl}</span>
                    </div>
                  </div>
                </li>
              </React.Fragment>
            );
          })}
        </ol>
      </div>

      <div className="block">
        <h4>How a chain works</h4>
        <ol className="pipe-steps">
          <li>
            <b>One loop.</b> A single insulated supply/return pipe pair leaves {src.name}, visits each building in
            order, and comes back. The first hop carries the most heat, so it is the largest pipe: 2 × {m.pipe.nominalIn}″,
            ~{fmt.int(m.pipe.gpm)} gpm at peak. Later hops can step down in size.
          </li>
          <li>
            <b>A heat pump at every stop.</b> Each building's heat pump pulls heat out of the loop and lifts it to ~140°F.
            The water leaves the source at ~{LOOP.supplyF}°F and gets a little cooler at each stop, returning at ~{LOOP.returnF}°F.
          </li>
          <li>
            <b>Fair sharing, hour by hour.</b> Each hour the source's heat is split across the stops in proportion to
            what each one needs. When there isn't enough, every stop gets the same fraction, and its existing boiler or
            steam covers the rest.
          </li>
          <li>
            <b>Why chain at all?</b> One building rarely uses all of a big source's heat. This chain puts{" "}
            <b>{fmt.pct(used)}</b> of the source's usable waste heat to work and meets <b>{fmt.pct(m.coverage)}</b> of
            the combined demand ({fmt.pct(m.coincidence)} hour-by-hour overlap).
          </li>
        </ol>
      </div>

      <div className="block">
        <h4>Supply vs. the whole chain's demand</h4>
        <div className="grids">
          <div>
            <div className="gridlbl"><span>Waste heat available · <b>{src.name}</b></span><span>{fmt.big(m.srcMmbtu)} MMBtu/yr</span></div>
            <HeatGrid values={m.grids.src} vmax={vmax} palette="heat" month={month} hour={hour} />
          </div>
          <div>
            <div className="gridlbl"><span>Combined demand of {chain.ids.length - 1} stops ({modeLbl})</span><span>{fmt.big(m.demMmbtu)} MMBtu/yr</span></div>
            <HeatGrid values={m.grids.dem} vmax={demMax} palette="cold" month={month} hour={hour} />
          </div>
          <div>
            <div className="gridlbl"><span>Matched in the same hour</span><span>covers {fmt.pct(m.coverage)} of demand</span></div>
            <HeatGrid values={m.grids.match} vmax={demMax} palette="match" month={month} hour={hour} />
          </div>
        </div>
      </div>

      <div className="block">
        <h4>Economics (per year)</h4>
        <div className="econ-row"><span>Fuel no longer bought (all stops)</span><span className="pos">+{fmt.usd(m.fuelUsd)}</span></div>
        <div className="econ-row"><span>Heat-pump electricity (COP {A.hp_cop})</span><span className="neg">−{fmt.usd(m.elecUsd)}</span></div>
        <div className="econ-row"><span>Cooling-tower water saved</span><span className="pos">+{fmt.usd(m.waterUsd)}</span></div>
        <div className="econ-row"><span>LL97 penalty avoided (${A.ll97_usd_per_t}/t)</span><span className="pos">+{fmt.usd(m.ll97)}</span></div>
        <div className="econ-row total"><span>Annual value</span><span>{fmt.usd(m.value)}</span></div>
        <div className="econ-row total"><span>Estimated installed cost ({Math.round(m.pipeM)} m of pipe)</span><span>{fmt.usdRange(m.capexLow, m.capexHigh)}</span></div>
        {m.cost.items.map((it) => (
          <div key={it.label} className="econ-row"><span className="note">{it.label}</span><span className="note">{fmt.usd(it.v[1])}</span></div>
        ))}
        <div className="note" style={{ marginTop: 6 }}>
          Estimated from typical-day (month × hour) profiles, without a storage tank. Pipe routes are drawn wall to
          wall; a real loop would follow the street grid. Line items show the base case.
        </div>
      </div>
    </div>
  );
}
