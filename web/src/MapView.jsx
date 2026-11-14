import React, { useEffect, useMemo, useState } from "react";
import Map, { useControl } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { demandAt, flowAt, KIND_LABEL, FUEL_LABEL } from "./econ.js";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const INITIAL = { longitude: -73.975, latitude: 40.735, zoom: 11.6, pitch: 45, bearing: -29 };
const LOOP = 1000;
const TRIP = 420;
const PARTICLES = 3;
const FLAGS = new URLSearchParams(window.location.search);
const LITE = FLAGS.has("lite"); // ?lite: no particle animation (for weak laptops / debugging)

function DeckOverlay(props) {
  const overlay = useControl(() => new MapboxOverlay({ ...props, interleaved: true }));
  overlay.setProps(props);
  return null;
}

function addContextBuildings(map) {
  if (map.getLayer("hm-3d")) return;
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "hm-3d",
      source: "openmaptiles",
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 12.5,
      paint: {
        "fill-extrusion-color": "#1b2130",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 12],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.9,
      },
    },
    firstSymbol,
  );
}

// A curved pipe-like path from source roof to sink roof, for the particle animation.
function arcPath(s, k) {
  const n = 24, path = [];
  const dx = (k.lon - s.lon) * 84000, dy = (k.lat - s.lat) * 111000;
  const dist = Math.hypot(dx, dy);
  const z0 = Math.min(s.height_m, 60) * 0.7, z1 = Math.min(k.height_m, 60) * 0.7;
  const lift = Math.max(12, dist * 0.3);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    path.push([s.lon + (k.lon - s.lon) * t, s.lat + (k.lat - s.lat) * t, z0 + (z1 - z0) * t + 4 * lift * t * (1 - t)]);
  }
  return path;
}

export default function MapView({ mapRef, data, grids, pairs, selected, onSelect, hour, month, mode, flowMax }) {
  const [time, setTime] = useState(0);
  const [zoom, setZoom] = useState(INITIAL.zoom);

  useEffect(() => {
    if (LITE) return;
    let raf, last = performance.now();
    const tick = (now) => {
      setTime((t) => (t + (now - last) * 0.12) % LOOP);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const idx = month * 24 + hour;
  const active = useMemo(() => {
    const ids = new Set();
    for (const p of pairs) { ids.add(p.s); ids.add(p.k); }
    return ids;
  }, [pairs]);

  const polys = useMemo(() => {
    const out = [];
    for (const b of data.buildings.values()) for (const poly of b.polygons) out.push({ b, poly });
    return out;
  }, [data]);

  const flowNow = (p) => (grids ? flowAt(p, grids, mode, idx) / (flowMax.get(p.id) || 1) : 0.6);

  const shown = useMemo(() => {
    const list = pairs.slice(0, 2500);
    if (selected && !list.includes(selected)) list.push(selected);
    return list;
  }, [pairs, selected]);

  const trips = useMemo(() => {
    const out = [];
    for (const p of shown) {
      const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
      const path = arcPath(s, k);
      for (let j = 0; j < PARTICLES; j++) {
        const off = (j * LOOP) / PARTICLES + ((p.id * 37) % 200);
        out.push({ p, path, ts: path.map((_, i) => off + (i / (path.length - 1)) * TRIP) });
      }
    }
    return out;
  }, [shown, data]);

  const intensity = (b) => {
    const g = grids?.[b.id];
    if (!g) return 0.7;
    if (b.source && g.src) return g.src[idx] / 999;
    if (g.dhw) return demandAt(g, mode, idx) / ((g.dhw_max || 0) + (mode === "all" ? g.space_max || 0 : 0) || 1);
    return 0.5;
  };

  const selIds = selected ? new Set([selected.s, selected.k]) : null;
  const buildingColor = ({ b }) => {
    const dim = selIds && !selIds.has(b.id);
    if (!active.has(b.id)) return [70, 76, 92, dim ? 120 : 200];
    const v = Math.max(0.15, Math.min(1, intensity(b)));
    const a = dim ? 90 : 255;
    const isSrc = selected ? selected.s === b.id : !!b.source;
    if (isSrc) return [255, 70 + 90 * v, 20, a].map((c, i) => (i < 3 ? c * (0.35 + 0.65 * v) : c));
    return [40, 120 + 40 * v, 255, a].map((c, i) => (i < 3 ? c * (0.35 + 0.65 * v) : c));
  };

  const layers = [
    new PolygonLayer({
      id: "buildings",
      data: polys,
      getPolygon: (d) => d.poly,
      extruded: true,
      getElevation: (d) => (d.b.height_m || 10) + 1.2,
      getFillColor: buildingColor,
      material: { ambient: 0.45, diffuse: 0.6, shininess: 24 },
      pickable: true,
      updateTriggers: { getFillColor: [idx, mode, active, selected?.id, !!grids] },
      onClick: ({ object }) => {
        const id = object?.b.id;
        const best = pairs.find((p) => p.s === id || p.k === id);
        if (best) onSelect(best.id);
      },
    }),
    zoom < 14.5 &&
      new ScatterplotLayer({
        id: "hotspots",
        data: shown,
        getPosition: (p) => {
          const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
          return [(s.lon + k.lon) / 2, (s.lat + k.lat) / 2, 2];
        },
        getRadius: (p) => 30 + Math.sqrt(Math.max(p.t_co2e, 0)) * 3,
        radiusMinPixels: 2,
        getFillColor: (p) => [255, 150 + 60 * flowNow(p), 40, 60 + 150 * flowNow(p)],
        stroked: false,
        pickable: true,
        onClick: ({ object }) => object && onSelect(object.id),
        updateTriggers: { getFillColor: [idx, mode, flowMax] },
        parameters: { depthTest: false },
      }),
    new PathLayer({
      id: "pipes",
      data: shown,
      getPath: (p) => arcPath(data.buildings.get(p.s), data.buildings.get(p.k)),
      getColor: (p) => (selected?.id === p.id ? [255, 220, 150, 200] : [255, 160, 60, 40 + 60 * flowNow(p)]),
      getWidth: (p) => (selected?.id === p.id ? 3 : 1.2),
      widthUnits: "meters",
      widthMinPixels: 1,
      pickable: true,
      onClick: ({ object }) => object && onSelect(object.id),
      updateTriggers: { getColor: [idx, mode, selected?.id, flowMax], getWidth: [selected?.id] },
    }),
    !LITE && new TripsLayer({
      id: "heat-flow",
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.ts,
      getColor: (d) => {
        const f = flowNow(d.p);
        return [255, 190 + 50 * f, 80 + 60 * f, f < 0.05 ? 0 : 255];
      },
      getWidth: (d) => (selected?.id === d.p.id ? 7 : 2 + 4 * flowNow(d.p)),
      widthUnits: "meters",
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      trailLength: 160,
      currentTime: time,
      fadeTrail: true,
      updateTriggers: { getColor: [idx, mode, flowMax], getWidth: [idx, mode, selected?.id, flowMax] },
    }),
  ].filter(Boolean);

  const tooltip = ({ object }) => {
    const b = object?.b;
    if (!b) return null;
    const role = b.source ? `${KIND_LABEL[b.source]} — rejects heat` : `Heats with ${FUEL_LABEL[b.fuel] || "fossil fuel"}`;
    return { html: `<b>${b.name}</b><br/>${b.type}<br/><span style="opacity:.75">${role}</span>`, className: "tooltip",
      style: { background: "#0e121c", border: "1px solid rgba(255,255,255,.12)", borderRadius: "8px", padding: "8px 10px", color: "#e8ecf3" } };
  };

  return (
    <Map
      ref={mapRef}
      mapLib={maplibregl}
      mapStyle={STYLE}
      initialViewState={INITIAL}
      onLoad={(e) => addContextBuildings(e.target)}
      onStyleData={(e) => e.target.isStyleLoaded() && addContextBuildings(e.target)}
      onZoomEnd={(e) => setZoom(e.viewState.zoom)}
      maxPitch={75}
      antialias
      attributionControl={{ compact: true }}
    >
      <DeckOverlay layers={layers} getTooltip={tooltip} />
    </Map>
  );
}
