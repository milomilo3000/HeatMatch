import React, { useEffect, useMemo, useState } from "react";
import { flowAt, MONTHS } from "./econ.js";

const fmtHour = (h) => `${((h + 11) % 12) + 1}:00`;
const ampm = (h) => (h < 12 ? "AM" : "PM");

export default function TimeBar({ hour, setHour, month, setMonth, pairs, grids, mode, flowMax }) {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setHour((h) => (h + 1) % 24), 650);
    return () => clearInterval(t);
  }, [playing, setHour]);

  const idx = month * 24 + hour;
  const now = useMemo(() => {
    if (!grids) return null;
    let flowing = 0;
    for (const p of pairs) {
      const v = flowAt(p, grids, mode, idx);
      if (v > 0.25 * (flowMax.get(p.id) || 1)) flowing += 1;
    }
    return { flowing };
  }, [pairs, grids, idx, mode, flowMax]);

  return (
    <div className="timebar">
      <button className="play" onClick={() => setPlaying((p) => !p)} title="Play a day">{playing ? "❚❚" : "▶"}</button>
      <div className="clock">
        {fmtHour(hour)}<span style={{ fontSize: 12, marginLeft: 3 }}>{ampm(hour)}</span>
        <small>typical {MONTHS[month]} day</small>
      </div>
      <div className="hours">
        <input type="range" min={0} max={23} value={hour} onChange={(e) => setHour(+e.target.value)} />
        <div className="ticks"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
      </div>
      <div className="seg" style={{ width: 230, flex: "none" }}>
        {[0, 3, 6, 9].map((m) => (
          <button key={m} className={month === m ? "on" : ""} onClick={() => setMonth(m)}>{MONTHS[m]}</button>
        ))}
      </div>
      <div className="flowing">
        {now
          ? <><b>{now.flowing.toLocaleString()}</b> matches active now</>
          : "Loading…"}
      </div>
    </div>
  );
}
