import React from "react";
import { pipeSpec, ROUTE, LOOP } from "./pipe.js";
import { fmt } from "./econ.js";

// "How this pipe works": a schematic plus the four physical steps, with this pair's numbers.
export default function PipeCard({ pair, s, k, A, mode, storage, pipeMult }) {
  const p = pipeSpec(pair, A, { mode, storage, pipeMult });
  const route = ROUTE[pair.tier];
  const use = mode === "dhw" ? "hot-water tank" : "hot-water tank + heating loop";
  const short = (t, n = 22) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

  return (
    <div className="block">
      <h4>How this pipe works</h4>
      <svg viewBox="0 0 380 150" className="pipe-svg" role="img" aria-label="Pipe schematic">
        {/* source building */}
        <rect x="6" y="18" width="110" height="114" rx="8" className="pv-box pv-src" />
        <text x="61" y="36" className="pv-title pv-t-src">{short(s.name, 16)}</text>
        <rect x="18" y="48" width="86" height="28" rx="5" className="pv-unit" />
        <text x="61" y="66" className="pv-small">cooling / IT heat</text>
        <rect x="18" y="88" width="86" height="28" rx="5" className="pv-unit pv-hx" />
        <text x="61" y="106" className="pv-small">heat exchanger</text>
        <line x1="61" y1="76" x2="61" y2="88" className="pv-link" />

        {/* pipe pair */}
        <line x1="116" y1="96" x2="264" y2="96" className="pv-supply" />
        <line x1="264" y1="112" x2="116" y2="112" className="pv-return" />
        <text x="190" y="88" className="pv-small pv-t-src">{LOOP.supplyF}°F →</text>
        <text x="190" y="127" className="pv-small pv-t-snk">← {LOOP.returnF}°F</text>
        <text x="190" y="60" className="pv-big">{Math.round(p.lengthM)} m</text>
        <text x="190" y="74" className="pv-small">2 × {p.nominalIn}″ insulated pipes</text>

        {/* sink building */}
        <rect x="264" y="18" width="110" height="114" rx="8" className="pv-box pv-snk" />
        <text x="319" y="36" className="pv-title pv-t-snk">{short(k.name, 16)}</text>
        <rect x="276" y="88" width="86" height="28" rx="5" className="pv-unit pv-hp" />
        <text x="319" y="106" className="pv-small">heat pump → 140°F</text>
        <rect x="276" y="48" width="86" height="28" rx="5" className="pv-unit" />
        <text x="319" y="66" className="pv-small">{mode === "dhw" ? "hot-water tank" : "tank + heating"}</text>
        <line x1="319" y1="88" x2="319" y2="76" className="pv-link" />
      </svg>

      <ol className="pipe-steps">
        <li>
          <b>Capture.</b> A plate heat exchanger taps {s.name}'s condenser-water loop: the heat it now sends
          to its cooling towers. The two buildings' water never mixes.
        </li>
        <li>
          <b>Carry.</b> ~{fmt.int(p.gpm)} gpm of {LOOP.supplyF}°F water flows {route.how} through a pair of
          insulated {p.nominalIn}″ pipes ({Math.round(p.lengthM)} m), carrying up to {fmt.int(p.carriedKw)} kW of waste heat.
          It returns at {LOOP.returnF}°F, which also cools the source, so its towers work less.
        </li>
        <li>
          <b>Lift.</b> A water-source heat pump in {k.name}'s plant room raises it to ~140°F. At COP {A.hp_cop},
          every 1 kWh of electricity plus {(A.hp_cop - 1).toFixed(1)} units of waste heat gives {A.hp_cop} units of usable heat
          (peak {fmt.int(p.deliveredKw)} kW delivered).
        </li>
        <li>
          <b>Use.</b> The heat feeds the {use}. The existing {k.fuel === "steam" ? "steam service" : "boiler"} stays as
          backup for cold snaps and for hours when the source is idle.
        </li>
      </ol>

      <div className="econ-row"><span>Route</span><span>{route.how}</span></div>
      <div className="econ-row"><span>Permits</span><span style={{ maxWidth: 230, textAlign: "right" }}>{route.permit}</span></div>
      <div className="econ-row"><span>Peak flow · pipe size</span><span>{fmt.int(p.gpm)} gpm · 2 × {p.nominalIn}″</span></div>
      <div className="econ-row"><span>Pipe cost ({fmt.int(p.lengthFt)} ft incl. connections)</span><span>{fmt.usd(p.costUsd)}</span></div>
      <div className="note" style={{ marginTop: 6 }}>
        Route drawn wall-to-wall in a straight line; a real run would follow the street grid. Pipe sized for {LOOP.velocityMps} m/s
        at a {LOOP.supplyF - LOOP.returnF}°F temperature drop.
      </div>
    </div>
  );
}
