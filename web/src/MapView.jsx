import React, { useEffect, useMemo, useState } from "react";
import Map, { useControl } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { KIND_LABEL, FUEL_LABEL } from "./econ.js";
import { nearestWalls, midpoint, footprintRadius } from "./pipe.js";
import { INITIAL } from "./mapCamera.js";

function shortLabel(name, max = 20) {
  const n = String(name || "").trim();
  if (n.length <= max) return n;
  return `${n.slice(0, max - 1)}…`;
}

function buildingKind(b, tab) {
  if (tab === "dc" && b.dc) return b.dc_measured ? "Data center · measured" : "Data center · est.";
  if (b.source) return KIND_LABEL[b.source] || b.type || "Heat source";
  return b.type || "Heat user";
}

function mapTag(b, tab) {
  return `${shortLabel(b.name)}\n${buildingKind(b, tab)}`;
}

const SRC_RGB = [255, 140, 40];
const SNK_RGB = [70, 165, 255];
const GREY = [70, 76, 92, 200];
const STYLE = "https://tiles.openfreemap.org/styles/dark";
const LOOP = 1000;
const TRIP = 420;
const PARTICLES = 3;
const LITE = new URLSearchParams(window.location.search).has("lite"); // ?lite: no animation
const ON_TOP = { depthCompare: "always", depthWriteEnabled: false };

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
      id: "hm-3d", source: "openmaptiles", "source-layer": "building", type: "fill-extrusion", minzoom: 12.5,
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

// Curved sky arc from source roof to sink roof (the yellow "heat flow" lines).
function arcPath(s, k) {
  const n = 24, path = [];
  const dist = Math.hypot((k.lon - s.lon) * 84000, (k.lat - s.lat) * 111000);
  const z0 = Math.min(s.height_m, 60) * 0.7, z1 = Math.min(k.height_m, 60) * 0.7;
  const lift = Math.max(12, dist * 0.3);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    path.push([s.lon + (k.lon - s.lon) * t, s.lat + (k.lat - s.lat) * t, z0 + (z1 - z0) * t + 4 * lift * t * (1 - t)]);
  }
  return path;
}

export default function MapView({
  mapRef, data, pairs, mode, tab, focus, partners, selected, chain, onReady, onSelect, onPickBuilding,
  hoverId, onHoverBuilding, heatMode,
}) {
  const [time, setTime] = useState(0);
  const [zoom, setZoom] = useState(INITIAL.zoom);
  const searchMode = mode === "search";
  const isSrc = (b) => (tab === "dc" ? !!b.dc : !!b.source);

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

  const get = (id) => data.buildings.get(id);
  // annual strength of a match (share of the user's heat need it covers), not the hour: investors look at the year
  const flowNow = (p) => Math.max(0.15, Math.min(1, p[`coverage_${heatMode}`] || 0));

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

  // Arcs: when a pair is selected, show only that link. With a search focus, show its partners.
  // Otherwise citywide arcs (capped).
  const shown = useMemo(() => {
    if (selected) return [selected];
    if (searchMode && partners?.length) return partners;
    return pairs.slice(0, 1800);
  }, [pairs, partners, selected, searchMode]);
  const partnerSet = useMemo(() => new Set((partners || []).map((p) => p.id)), [partners]);
  const focusId = focus && focus.id >= 0 && get(focus.id) ? focus.id : null;
  const emphasized = (p) => (selected ? p === selected : focusId != null ? partnerSet.has(p.id) : true);

  // Orange = gives heat (source). Blue = needs heat (sink).
  // Search: light your building + all partners. After a partner click: only that pair.
  const hl = useMemo(() => {
    const items = [], segs = [];
    const seg = (from, to, dist) => segs.push({ route: nearestWalls(get(from), get(to)), dist });
    if (searchMode && focus && focusId != null && selected) {
      const partnerId = selected.s === focusId ? selected.k : selected.s;
      const youGiveHeat = focusId === selected.s;
      const partnerGivesHeat = partnerId === selected.s;
      const fb = get(focusId), pb = get(partnerId);
      // Name + building type; offsets keep close buildings from stacking
      items.push({
        id: focusId,
        rgb: youGiveHeat ? SRC_RGB : SNK_RGB,
        text: mapTag(fb, tab),
        halo: true,
        side: "focus",
      });
      items.push({
        id: partnerId,
        rgb: partnerGivesHeat ? SRC_RGB : SNK_RGB,
        text: mapTag(pb, tab),
        halo: true,
        side: "partner",
      });
      seg(selected.s, selected.k, selected.dist_m);
    } else if (searchMode && focus && focusId != null) {
      const fb = get(focusId);
      items.push({
        id: focusId,
        rgb: isSrc(fb) ? SRC_RGB : SNK_RGB,
        text: mapTag(fb, tab),
        halo: true,
        side: "focus",
      });
      (partners || []).forEach((p, i) => {
        const other = p.s === focusId ? p.k : p.s;
        if (other === focusId || items.some((it) => it.id === other)) return;
        const partnerGivesHeat = p.s === other;
        const ob = get(other);
        items.push({
          id: other,
          rgb: partnerGivesHeat ? SRC_RGB : SNK_RGB,
          text: `${i + 1}\n${shortLabel(ob.name, 16)}`,
          big: true,
          halo: true,
          side: "partner",
          idx: i,
        });
      });
    } else if (selected && !chain) {
      items.push({ id: selected.s, rgb: SRC_RGB, text: mapTag(get(selected.s), tab), halo: true, side: "west" });
      items.push({ id: selected.k, rgb: SNK_RGB, text: mapTag(get(selected.k), tab), halo: true, side: "east" });
      seg(selected.s, selected.k, selected.dist_m);
    } else if (chain) {
      chain.ids.forEach((id, i) => items.push({ id, rgb: i ? SNK_RGB : SRC_RGB, text: i ? `${i}` : "S", big: true, halo: true, idx: i }));
      chain.hops.forEach((h) => seg(h.from, h.to, h.dist));
    }
    // Push labels apart in screen space so close buildings don't stack
    const labels = items.map((it) => {
      const b = get(it.id);
      let offset = [0, -18];
      if (items.length >= 2 && (it.side === "focus" || it.side === "partner" || it.side === "west" || it.side === "east")) {
        const other = items.find((x) => x.id !== it.id);
        if (other) {
          const ob = get(other.id);
          const east = b.lon >= ob.lon;
          offset = [east ? 72 : -72, it.side === "focus" || it.side === "west" ? -52 : 36];
        }
      } else if (it.idx != null) {
        const ang = (it.idx * 2.2) % 6.28;
        offset = [Math.round(Math.cos(ang) * 42), Math.round(Math.sin(ang) * 28) - 12];
      }
      // search candidates are labeled only while hovered (on the map or in the list)
      const hoverOnly = searchMode && !selected && it.side === "partner";
      return { id: it.id, hoverOnly, pos: [b.lon, b.lat, (b.height_m || 10) + 10], text: it.text, rgb: it.rgb, big: it.big, offset };
    });
    if (selected && !chain)
      segs.forEach((g) => labels.push({
        pos: midpoint(g.route, 5), offset: [0, 44], rgb: [255, 226, 180],
        text: `~${Math.round(g.dist * 3.281)} ft`,
      }));
    return {
      items, segs, labels,
      color: new globalThis.Map(items.map((it) => [it.id, it.rgb])),
      halos: items.filter((it) => it.halo).map((it) => ({ b: get(it.id), rgb: it.rgb, r: footprintRadius(get(it.id)) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMode, focus, focusId, partners, selected, chain, data, tab]);

  const anyHl = hl.items.length > 0;
  const labels = useMemo(() => hl.labels.filter((l) => !l.hoverOnly || l.id === hoverId), [hl, hoverId]);
  const onHover = ({ object }) => onHoverBuilding?.(object?.b.id ?? null);
  const basePolys = useMemo(() => (anyHl ? polys.filter((d) => !hl.color.has(d.b.id)) : polys), [polys, hl, anyHl]);
  const hlPolys = useMemo(() => (anyHl ? polys.filter((d) => hl.color.has(d.b.id)) : []), [polys, hl, anyHl]);

  const trips = useMemo(() => {
    if (LITE) return [];
    const out = [];
    for (const p of shown) {
      const path = arcPath(get(p.s), get(p.k));
      for (let j = 0; j < PARTICLES; j++) {
        const off = (j * LOOP) / PARTICLES + ((p.id * 37) % 200);
        out.push({ p, path, ts: path.map((_, i) => off + (i / (path.length - 1)) * TRIP) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, data]);

  const intensity = () => 0.8; // fixed: the citywide map shows who gives / needs heat, not a time of day

  // Search: grey city (highlights handled separately). Citywide: sources orange, users blue.
  const buildingColor = ({ b }) => {
    if (searchMode) return anyHl ? [56, 62, 78, 170] : GREY;
    if (anyHl) return active.has(b.id) ? [62, 70, 88, 150] : [50, 56, 70, 110];
    if (!active.has(b.id)) return GREY;
    const v = Math.max(0.15, Math.min(1, intensity(b)));
    const base = isSrc(b) ? [255, 70 + 90 * v, 20] : [40, 120 + 40 * v, 255];
    return [...base.map((c) => c * (0.35 + 0.65 * v)), 255];
  };

  const pulse = (time % 300) / 300; // halo rings
  const breathe = 0.5 + 0.5 * Math.sin((time / LOOP) * Math.PI * 2 * 1.5); // slow glow on the ground pipe

  function onBuildingClick({ object }) {
    const id = object?.b.id;
    if (id == null) return;
    if (searchMode) {
      const p = (partners || []).find((x) => x.s === id || x.k === id);
      if (p && focusId != null && id !== focusId) return onSelect(p.id);
      return onPickBuilding(id);
    }
    const best = pairs.find((p) => p.s === id || p.k === id);
    if (best) onSelect(best.id);
  }

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
      autoHighlight: true,
      highlightColor: [255, 255, 255, 70],
      onHover,
      updateTriggers: { getFillColor: [active, anyHl, searchMode, tab] },
      onClick: onBuildingClick,
    }),
    anyHl && new PolygonLayer({
      id: "highlighted-buildings",
      data: hlPolys,
      getPolygon: (d) => d.poly,
      extruded: true,
      wireframe: true,
      getElevation: (d) => (d.b.height_m || 10) + 1.2,
      getFillColor: (d) => [...hl.color.get(d.b.id), 255],
      getLineColor: [255, 255, 255, 235],
      material: { ambient: 0.75, diffuse: 0.5, shininess: 40 },
      pickable: true,
      onHover,
      onClick: onBuildingClick,
      updateTriggers: { getFillColor: [hl] },
    }),
    hl.halos.length > 0 && new ScatterplotLayer({
      id: "halos",
      data: [...hl.halos, ...hl.halos.map((h) => ({ ...h, phase: 0.5 }))],
      getPosition: (h) => [h.b.lon, h.b.lat, 0.3],
      getRadius: (h) => h.r + 4 + 14 * ((pulse + (h.phase || 0)) % 1),
      getLineColor: (h) => [...h.rgb, 150 * (1 - ((pulse + (h.phase || 0)) % 1))],
      stroked: true,
      filled: false,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      updateTriggers: { getRadius: [pulse], getLineColor: [pulse] },
    }),
    !searchMode && zoom < 14 && new ScatterplotLayer({
      id: "hotspots",
      data: shown,
      getPosition: (p) => [(get(p.s).lon + get(p.k).lon) / 2, (get(p.s).lat + get(p.k).lat) / 2, 2],
      getRadius: (p) => 12 + Math.sqrt(Math.max(p.t_co2e, 0)) * 1.2,
      radiusMinPixels: 1.5,
      radiusMaxPixels: 14,
      getFillColor: (p) => [255, 150 + 60 * flowNow(p), 40, 16 + 50 * flowNow(p)],
      opacity: anyHl ? 0.35 : Math.max(0.35, Math.min(1, (14 - zoom) / 1.5)),
      pickable: true,
      onClick: ({ object }) => object && onSelect(object.id),
      updateTriggers: { getFillColor: [heatMode] },
      parameters: { depthWriteEnabled: false },
    }),

    // --- sky arcs + flying particles (kept as-is; the selected/partner arcs are emphasized)
    new PathLayer({
      id: "arcs",
      data: shown,
      getPath: (p) => arcPath(get(p.s), get(p.k)),
      getColor: (p) => (p === selected ? [255, 210, 120, 230] : [255, 160, 60, (emphasized(p) ? 1 : 0.18) * (40 + 60 * flowNow(p))]),
      getWidth: (p) => (p === selected ? 2.6 : 1.2),
      widthUnits: "meters",
      widthMinPixels: 1,
      pickable: true,
      onClick: ({ object }) => object && onSelect(object.id),
      updateTriggers: { getColor: [heatMode, selected, partnerSet, focusId], getWidth: [selected] },
    }),
    !LITE && new TripsLayer({
      id: "heat-flow",
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.ts,
      getColor: (d) => {
        const f = flowNow(d.p);
        const a = emphasized(d.p) ? 255 : 45;
        return [255, 190 + 50 * f, 80 + 60 * f, f < 0.05 ? 0 : a];
      },
      getWidth: (d) => (d.p === selected ? 6 : 2 + 4 * flowNow(d.p)),
      widthUnits: "meters",
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      trailLength: 160,
      currentTime: time,
      fadeTrail: true,
      updateTriggers: { getColor: [heatMode, partnerSet, focusId, selected], getWidth: [heatMode, selected] },
    }),

    // --- the proposed pipe at street level: one solid line with a soft, slowly breathing glow
    hl.segs.length > 0 && new PathLayer({
      id: "pipe-glow",
      data: hl.segs,
      getPath: (g) => [[...g.route.a, 0.5], [...g.route.b, 0.5]],
      getColor: [255, 196, 110, 40 + 70 * breathe],
      getWidth: 6,
      widthUnits: "meters",
      widthMinPixels: 10,
      capRounded: true,
      updateTriggers: { getColor: [breathe] },
      parameters: ON_TOP,
    }),
    hl.segs.length > 0 && new PathLayer({
      id: "pipe-core",
      data: hl.segs,
      getPath: (g) => [[...g.route.a, 0.6], [...g.route.b, 0.6]],
      getColor: [255, 222, 160, 255],
      getWidth: 1.6,
      widthUnits: "meters",
      widthMinPixels: 3.5,
      capRounded: true,
      parameters: ON_TOP,
    }),
    hl.segs.length > 0 && new ScatterplotLayer({
      id: "pipe-ends",
      data: hl.segs.flatMap((g) => [g.route.a, g.route.b]),
      getPosition: (p) => [...p, 0.8],
      getRadius: 1.4,
      radiusMinPixels: 4,
      getFillColor: [255, 255, 255, 255],
      stroked: true,
      getLineColor: [20, 24, 32, 255],
      lineWidthMinPixels: 1.5,
      parameters: ON_TOP,
    }),

    // a searched building that isn't modeled (no footprint in our data) still gets a pin
    searchMode && focus && focusId == null && new ScatterplotLayer({
      id: "focus-pin",
      data: [focus],
      getPosition: (e) => [e.lon, e.lat, 1],
      getRadius: 10,
      radiusMinPixels: 8,
      getFillColor: [255, 255, 255, 230],
      stroked: true,
      getLineColor: [12, 15, 24, 255],
      lineWidthMinPixels: 3,
      parameters: ON_TOP,
    }),

    (labels.length > 0 || (searchMode && focus && focusId == null)) && new TextLayer({
      id: "labels",
      data: focusId == null && searchMode && focus
        ? [{ pos: [focus.lon, focus.lat, 12], offset: [0, -24], text: focus.name, rgb: [235, 238, 245] }]
        : labels,
      getPosition: (d) => d.pos,
      getPixelOffset: (d) => d.offset || [0, 0],
      getText: (d) => d.text,
      getColor: (d) => [...d.rgb, 255],
      getSize: (d) => (d.big ? 16 : 13),
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
      parameters: ON_TOP,
    }),
  ].filter(Boolean);

  const tooltip = ({ object }) => {
    const b = object?.b;
    if (!b) return null;
    if (labels.some((l) => l.hoverOnly && l.id === b.id)) return null; // its label already shows
    const role = tab === "dc" && b.dc
      ? `Data center: ~${Math.round(b.dc_heat_mmbtu).toLocaleString()} MMBtu/yr of IT heat (${b.dc_measured ? "measured" : "estimated"})`
      : isSrc(b)
        ? `Gives away heat (${KIND_LABEL[b.source] || "source"})`
        : `Needs heat (${FUEL_LABEL[b.fuel] || "fossil fuel"})`;
    return {
      text: `${b.name}\n${b.type}\n${role}`,
      style: { background: "#0e121c", border: "1px solid rgba(255,255,255,.12)", borderRadius: "8px", padding: "8px 10px", color: "#e8ecf3", fontFamily: "Inter, sans-serif", fontSize: "12px", whiteSpace: "pre-line" },
    };
  };

  return (
    <Map
      ref={mapRef}
      mapLib={maplibregl}
      mapStyle={STYLE}
      initialViewState={INITIAL}
      onLoad={(e) => {
        addContextBuildings(e.target);
        onReady();
      }}
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
