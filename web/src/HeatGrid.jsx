import React, { useEffect, useRef } from "react";

const PALETTES = {
  heat: [[20, 14, 10], [120, 40, 10], [255, 122, 26], [255, 214, 140]],
  cold: [[10, 14, 24], [20, 60, 130], [58, 160, 255], [190, 230, 255]],
  match: [[14, 16, 14], [70, 60, 10], [255, 209, 102], [255, 248, 210]],
};

function ramp(pal, t) {
  const x = Math.max(0, Math.min(0.9999, t)) * (pal.length - 1);
  const i = Math.floor(x), f = x - i;
  return pal[i].map((c, j) => Math.round(c + (pal[i + 1][j] - c) * f));
}

// 12 months (rows) x 24 hours (columns). values: 288 numbers in any unit; vmax: shared scale.
export default function HeatGrid({ values, vmax, palette = "heat", month, hour }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !values) return;
    const W = 24 * 12, H = 12 * 7;
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const cw = W / 24, ch = H / 12;
    const mx = vmax || Math.max(...values, 1e-9);
    for (let m = 0; m < 12; m++)
      for (let h = 0; h < 24; h++) {
        const [r, g, b] = ramp(PALETTES[palette], values[m * 24 + h] / mx);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(h * cw, m * ch, cw + 0.5, ch + 0.5);
      }
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(hour * cw + 0.75, 0.75, cw - 1.5, H - 1.5);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.strokeRect(0.75, month * ch + 0.75, W - 1.5, ch - 1.5);
  }, [values, vmax, palette, month, hour]);
  return <canvas ref={ref} className="heatgrid" />;
}
