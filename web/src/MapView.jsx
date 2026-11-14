import React, { useEffect, useMemo, useState } from "react";
import Map, { useControl } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { demandAt, flowAt, KIND_LABEL, FUEL_LABEL } from "./econ.js";
import { nearestWalls, pipeLines, midpoint, pipeSpec, footprintRadius } from "./pipe.js";

const SRC_RGB = [255, 140, 40];
const SNK_RGB = [70, 165, 255];
const DASH = [new PathStyleExtension({ dash: true })];



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

export default function MapView({ mapRef, data, grids, pairs, selected, chain, onSelect, hour, month, mode, storage, flowMax }) {
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

  // --- selection: a pair (2 buildings) or a pipeline chain (3–6). The chosen buildings get their own
  // layer, a ground halo and labels; every pipe segment is drawn at street level with flowing water.
  const sel = useMemo(() => {
    let ids, hops;
    if (chain) ({ ids, hops } = chain);
    else if (selected) {
      ids = [selected.s, selected.k];
      hops = [{ from: selected.s, to: selected.k, dist: selected.dist_m }];
    } else return null;
    const get = (id) => data.buildings.get(id);
    const A = data.summary.assumptions;
    const spec = chain ? chain.m.pipe : pipeSpec(selected, A, { mode, storage });
    const segs = hops.map((h, i) => {
      const route = nearestWalls(get(h.from), get(h.to));
      return { route, lines: pipeLines(route), dist: h.dist, n: i + 1 };
    });
    const flow = [];
    segs.forEach((g, i) => {
      for (let j = 0; j < 5; j++) {
        const off = (j * LOOP) / 5 + i * 90; // later hops lag, so heat visibly travels down the chain
        flow.push({ path: g.lines.supply, rgb: SRC_RGB, ts: [off, off + 200] });
        flow.push({ path: g.lines.ret, rgb: SNK_RGB, ts: [off + 60, off + 260] });
      }
    });
    const labels = ids.map((id, i) => {
      const b = get(id);
      // chains: compact numbered markers (S, 1, 2, …) that match the side panel; names live there.
      // Pairs have room for full labels.
      const text = chain ? (i === 0 ? " S " : ` ${i} `) : `${i === 0 ? "HEAT SOURCE" : "HEAT USER"}\n${b.name}`;
      return { pos: [b.lon, b.lat, (b.height_m || 10) + 10], text, rgb: i === 0 ? SRC_RGB : SNK_RGB, big: !!chain };
    });
    if (!chain) segs.forEach((g) => labels.push({ // chain hop distances are listed in the panel instead
      pos: midpoint(g.route, 5),
      offset: [0, -42], // float above the pipe so the pipe itself stays visible
      text: `${Math.round(g.dist)} m pipe · 2 × ${spec.nominalIn}″ · ${Math.round(spec.gpm).toLocaleString()} gpm`,
      rgb: [255, 230, 190],
    }));
    return {
      srcId: ids[0], ids: new Set(ids), segs, flow, labels,
      halos: ids.map((id, i) => ({ b: get(id), rgb: i === 0 ? SRC_RGB : SNK_RGB, r: footprintRadius(get(id)) })),
    };
  }, [selected, chain, data, mode, storage]);

  const basePolys = useMemo(() => (sel ? polys.filter((d) => !sel.ids.has(d.b.id)) : polys), [polys, sel]);
  const selPolys = useMemo(() => (sel ? polys.filter((d) => sel.ids.has(d.b.id)) : []), [polys, sel]);

  const trips = useMemo(() => {
    const out = [];
    for (const p of shown) {
      if (p === selected) continue; // the selected pair is drawn as a ground-level pipe instead
      const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
      const path = arcPath(s, k);
      for (let j = 0; j < PARTICLES; j++) {
        const off = (j * LOOP) / PARTICLES + ((p.id * 37) % 200);
        out.push({ p, path, ts: path.map((_, i) => off + (i / (path.length - 1)) * TRIP) });
      }
    }
    return out;
  }, [shown, data, selected]);

  const intensity = (b) => {
    const g = grids?.[b.id];
    if (!g) return 0.7;
    if (b.source && g.src) return g.src[idx] / 999;
    if (g.dhw) return demandAt(g, mode, idx) / ((g.dhw_max || 0) + (mode === "all" ? g.space_max || 0 : 0) || 1);
    return 0.5;
  };

  // With a selection, every other building fades to a muted grey so the chosen two stand out.
  const buildingColor = ({ b }) => {
    if (sel) return active.has(b.id) ? [62, 70, 88, 150] : [50, 56, 70, 110];
    if (!active.has(b.id)) return [70, 76, 92, 200];
    const v = Math.max(0.15, Math.min(1, intensity(b)));
    if (b.source) return [255, 70 + 90 * v, 20, 255].map((c, i) => (i < 3 ? c * (0.35 + 0.65 * v) : c));
    return [40, 120 + 40 * v, 255, 255].map((c, i) => (i < 3 ? c * (0.35 + 0.65 * v) : c));
  };
  const pulse = (time % 300) / 300; // 0→1 repeating, drives the halo rings
  const pickBuilding = ({ object }) => {
    const id = object?.b.id;
    const best = pairs.find((p) => p.s === id || p.k === id);
    if (best) onSelect(best.id);
  };

  const layers = [
    new PolygonLayer({
      id: "buildings",
      data: basePolys,
      getPolygon: (d) => d.poly,
      extruded: true,
      getElevation: (d) => (d.b.height_m || 10) + 1.2,
      getFillColor: buildingColor,
      material: { ambient: 0.45, diffuse: 0.6, shininess: 24 },
      pickable: true,
      autoHighlight: true, // hover feedback before clicking
      highlightColor: [255, 255, 255, 70],
      updateTriggers: { getFillColor: [idx, mode, active, !!sel, !!grids] },
      onClick: pickBuilding,
    }),
    sel && new PolygonLayer({
      id: "selected-buildings",
      data: selPolys,
      getPolygon: (d) => d.poly,
      extruded: true,
      wireframe: true, // white edges outline the chosen buildings
      getElevation: (d) => (d.b.height_m || 10) + 1.2,
      getFillColor: (d) => [...(d.b.id === sel.srcId ? SRC_RGB : SNK_RGB), 255],
      getLineColor: [255, 255, 255, 235],
      material: { ambient: 0.75, diffuse: 0.5, shininess: 40 },
      pickable: true,
      onClick: pickBuilding,
      updateTriggers: { getFillColor: [sel.srcId] },
    }),
    sel && new ScatterplotLayer({
      id: "selected-halo",
      data: [...sel.halos, ...sel.halos.map((h) => ({ ...h, phase: 0.5 }))],
      getPosition: (h) => [h.b.lon, h.b.lat, 0.3],
      getRadius: (h) => h.r + 4 + 14 * ((pulse + (h.phase || 0)) % 1),
      getLineColor: (h) => [...h.rgb, 150 * (1 - ((pulse + (h.phase || 0)) % 1))],
      stroked: true,
      filled: false,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      updateTriggers: { getRadius: [pulse], getLineColor: [pulse] },
    }),
    zoom < 14 &&
      new ScatterplotLayer({
        id: "hotspots",
        data: shown,
        getPosition: (p) => {
          const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
          return [(s.lon + k.lon) / 2, (s.lat + k.lat) / 2, 2];
        },
        // Soft, small glows: many overlap in dense areas, so keep each one faint and let
        // buildings in front hide them (normal depth test) instead of painting over the city.
        getRadius: (p) => 12 + Math.sqrt(Math.max(p.t_co2e, 0)) * 1.2,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 14,
        getFillColor: (p) => [255, 150 + 60 * flowNow(p), 40, 16 + 50 * flowNow(p)],
        stroked: false,
        opacity: sel ? 0.35 : Math.max(0.35, Math.min(1, (14 - zoom) / 1.5)),
        pickable: true,
        onClick: ({ object }) => object && onSelect(object.id),
        updateTriggers: { getFillColor: [idx, mode, flowMax] },
        parameters: { depthWriteEnabled: false },
      }),
    new PathLayer({
      id: "pipes",
      data: sel ? shown.filter((p) => p !== selected) : shown,
      getPath: (p) => arcPath(data.buildings.get(p.s), data.buildings.get(p.k)),
      getColor: (p) => [255, 160, 60, (sel ? 0.35 : 1) * (40 + 60 * flowNow(p))],
      getWidth: 1.2,
      widthUnits: "meters",
      widthMinPixels: 1,
      pickable: true,
      onClick: ({ object }) => object && onSelect(object.id),
      updateTriggers: { getColor: [idx, mode, !!sel, flowMax] },
    }),
    !LITE && new TripsLayer({
      id: "heat-flow",
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.ts,
      getColor: (d) => {
        const f = flowNow(d.p);
        return [255, 190 + 50 * f, 80 + 60 * f, f < 0.05 ? 0 : sel ? 70 : 255];
      },
      getWidth: (d) => 2 + 4 * flowNow(d.p),
      widthUnits: "meters",
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      trailLength: 160,
      currentTime: time,
      fadeTrail: true,
      updateTriggers: { getColor: [idx, mode, flowMax, !!sel], getWidth: [idx, mode, flowMax] },
    }),

    // --- the proposed pipe for the selected pair: supply (orange) and return (blue), at street level
    sel && new PathLayer({
      id: "pipe-route",
      data: sel.segs.flatMap((g) => [
        { path: g.lines.supply, rgb: SRC_RGB },
        { path: g.lines.ret, rgb: SNK_RGB },
      ]),
      getPath: (d) => d.path,
      getColor: (d) => [...d.rgb, 255],
      getWidth: 1.4,
      widthUnits: "meters",
      widthMinPixels: 5,
      capRounded: true,
      getDashArray: [3, 1.5],
      dashJustified: true,
      extensions: DASH,
      parameters: { depthCompare: "always", depthWriteEnabled: false },
    }),
    sel && !LITE && new TripsLayer({
      id: "pipe-flow",
      data: sel.flow,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.ts,
      getColor: (d) => [...d.rgb.map((c) => Math.min(255, c + 60)), 255],
      getWidth: 1.6,
      widthUnits: "meters",
      widthMinPixels: 5,
      capRounded: true,
      trailLength: 70,
      fadeTrail: true,
      currentTime: time,
      parameters: { depthCompare: "always", depthWriteEnabled: false },
    }),
    sel && new ScatterplotLayer({
      id: "pipe-ends",
      data: sel.segs.flatMap((g) => [g.route.a, g.route.b]),
      getPosition: (p) => [...p, 0.8],
      getRadius: 1.6,
      radiusMinPixels: 5,
      getFillColor: [255, 255, 255, 255],
      stroked: true,
      getLineColor: [20, 24, 32, 255],
      lineWidthMinPixels: 2,
      parameters: { depthCompare: "always", depthWriteEnabled: false },
    }),
    sel && new TextLayer({
      id: "selection-labels",
      data: sel.labels,
      getPosition: (d) => d.pos,
      getPixelOffset: (d) => d.offset || [0, 0],
      getText: (d) => d.text,
      getColor: (d) => [...d.rgb, 255],
      getSize: (d) => (d.big ? 17 : 13),
      sizeUnits: "pixels",
      fontFamily: "Inter, system-ui, sans-serif",
      fontWeight: 600,
      lineHeight: 1.25,
      characterSet: "auto",
      background: true,
      getBackgroundColor: [12, 15, 24, 225],
      backgroundPadding: [8, 5],
      getBorderColor: (d) => [...d.rgb, 200],
      getBorderWidth: (d) => (d.big ? 2 : 1),
      parameters: { depthCompare: "always", depthWriteEnabled: false },
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
