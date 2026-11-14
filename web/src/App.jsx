import React, { useEffect, useMemo, useRef, useState } from "react";
import MapView, { INITIAL } from "./MapView.jsx";
import Sidebar from "./Sidebar.jsx";
import PairDrawer, { heatMatchScore } from "./PairDrawer.jsx";
import ChainDrawer from "./ChainDrawer.jsx";
import TimeBar from "./TimeBar.jsx";
import SearchBar from "./SearchBar.jsx";
import ResultsPanel from "./ResultsPanel.jsx";
import { buildIndex, findChains } from "./chain.js";
import { loadIndex, nearbyOpposite } from "./search.js";
import { filterPairs, portfolio, computeFlowMax, pairEcon } from "./econ.js";

const ALL_KINDS = ["datacenter", "refrigeration", "hospital", "office"];
const DEFAULT_FILTERS = {
  maxDist: 60,
  minCoincidence: 0.4,
  tiers: [1, 2, 3, 4],
  kinds: ALL_KINDS,
  mode: "all", // heat serves hot water + space heat
  storage: 0,
  sort: "tco2e",
  chainSize: 2, // 2 = source→user pairs; 3–6 = pipeline chains
};

async function loadJSON(name) {
  const r = await fetch(`/data/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

// A search-index-shaped entry for a building we already have on the map (map clicks).
const entryFromBuilding = (b) => ({
  id: b.id, name: b.name, address: b.address, borough: b.borough, type: b.type, lon: b.lon, lat: b.lat,
  role: `${b.source ? "s" : ""}${b.sink ? "k" : ""}`, has: 1,
});

export default function App() {
  const [data, setData] = useState(null);
  const [grids, setGrids] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState("search"); // "search" (default) | "all" (every candidate)
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [focus, setFocus] = useState(null); // the searched building (a search-index entry)
  const searchMaxDist = 150; // fixed partner search radius; no distance UI
  const [nearby, setNearby] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [hour, setHour] = useState(19);
  const [month, setMonth] = useState(0);
  const [chains, setChains] = useState([]);
  const [chainsBusy, setChainsBusy] = useState(false);
  const [chainKey, setChainKey] = useState(null);
  const mapRef = useRef(null);

  useEffect(() => {
    Promise.all([loadJSON("buildings.json"), loadJSON("pairs.json"), loadJSON("summary.json")])
      .then(([b, p, s]) => {
        const buildings = new Map(b.map((x) => [x.id, x]));
        for (const pair of p) pair._srcKind = buildings.get(pair.s)?.source;
        setData({ buildings, pairs: p, summary: s, pairById: new Map(p.map((x) => [x.id, x])) });
        loadJSON("grids.json").then(setGrids).catch(() => {});
      })
      .catch((e) => setError(String(e)));
  }, []);

  const A = data?.summary.assumptions;
  const searchMode = view === "search";

  // ---- all-candidates view
  const filtered = useMemo(
    () => (data ? filterPairs(data.pairs, filters) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filters.maxDist, filters.minCoincidence, filters.tiers, filters.kinds, filters.mode],
  );
  const totals = useMemo(
    () => (data ? portfolio(filtered, data.buildings, A, { mode: filters.mode, storage: filters.storage }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filtered, filters.mode, filters.storage],
  );

  // ---- search view: every candidate pair is drawn as a faint yellow arc; the searched building's partners pop
  const allPairs = useMemo(
    () => (data ? filterPairs(data.pairs, { ...DEFAULT_FILTERS, maxDist: 150, minCoincidence: 0, mode: filters.mode }) : []),
    [data, filters.mode],
  );
  const partnerRows = useMemo(() => {
    if (!data || !focus || focus.id < 0) return [];
    const opts = { mode: filters.mode, storage: filters.storage };
    return data.pairs
      .filter((p) => (p.s === focus.id || p.k === focus.id) && p.dist_m <= searchMaxDist)
      .map((p) => {
        const youAreSource = p.s === focus.id;
        const e = pairEcon(p, data.buildings.get(p.k), A, opts);
        return {
          p,
          youAreSource,
          other: data.buildings.get(youAreSource ? p.k : p.s),
          e,
          match: heatMatchScore(p, e, filters.mode),
        };
      })
      .sort((a, b) => b.match.score - a.match.score || (a.e.payback ?? 1e9) - (b.e.payback ?? 1e9));
  }, [data, A, focus, searchMaxDist, filters.mode, filters.storage]);
  const partnerPairs = useMemo(() => partnerRows.map((r) => r.p), [partnerRows]);

  useEffect(() => {
    setNearby([]);
    if (!focus || focus.id < 0 || partnerRows.length) return;
    loadIndex().then((ix) => setNearby(nearbyOpposite(ix, focus)));
  }, [focus, partnerRows.length]);

  const arcPairs = searchMode ? allPairs : filtered;
  const flowMax = useMemo(() => computeFlowMax(arcPairs, grids, filters.mode), [arcPairs, grids, filters.mode]);
  const selected = data && selectedId != null ? data.pairById.get(selectedId) : null;

  // ---- pipeline chains (all-candidates view only), searched in the background
  const index = useMemo(() => (data ? buildIndex(data.buildings) : null), [data]);
  useEffect(() => {
    setChainKey(null);
    if (!data || !grids || searchMode || filters.chainSize < 3) { setChains([]); return; }
    setChainsBusy(true);
    const t = setTimeout(() => {
      setChains(findChains({ size: filters.chainSize, pairs: filtered, buildings: data.buildings, grids, A, filters, index }));
      setChainsBusy(false);
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, grids, filtered, filters.chainSize, searchMode]);
  const selectedChain = chainKey ? chains.find((c) => c.key === chainKey) : null;

  // ---- camera
  function flyToPoints(points, opts = {}) {
    if (!mapRef.current || !points.length) return;
    const lons = points.map((p) => p.lon), lats = points.map((p) => p.lat);
    const extentM = Math.max((Math.max(...lons) - Math.min(...lons)) * 84_300, (Math.max(...lats) - Math.min(...lats)) * 111_320, 60);
    mapRef.current.flyTo({
      center: [(Math.max(...lons) + Math.min(...lons)) / 2, (Math.max(...lats) + Math.min(...lats)) / 2],
      zoom: Math.max(15.4, Math.min(17.2, 17.6 - Math.log2(extentM / 60))),
      pitch: 52, bearing: -29, duration: 2200, essential: true, ...opts,
    });
  }

  function pickEntry(entry) {
    setView("search");
    setSelectedId(null);
    setChainKey(null);
    setFocus(entry);
  }
  // frame the searched building together with its partners
  useEffect(() => {
    if (!focus || !data) return;
    const pts = [focus, ...partnerRows.slice(0, 8).map((r) => r.other)];
    flyToPoints(pts, partnerRows.length ? {} : { zoom: 16.4 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  function selectPair(id) {
    setChainKey(null);
    setSelectedId(id);
    const p = data?.pairById.get(id);
    if (!p) return;
    const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
    const bearing = (Math.atan2(k.lon - s.lon, k.lat - s.lat) * 180) / Math.PI + 70;
    flyToPoints([s, k], { zoom: p.dist_m > 80 ? 16.1 : 16.6, pitch: 58, bearing });
  }

  function selectChain(key) {
    const c = chains.find((x) => x.key === key);
    setSelectedId(null);
    setChainKey(key);
    if (c) flyToPoints(c.ids.map((id) => data.buildings.get(id)));
  }

  function clearFocus() {
    setFocus(null);
    setSelectedId(null);
    mapRef.current?.flyTo({ center: [INITIAL.longitude, INITIAL.latitude], zoom: INITIAL.zoom, pitch: INITIAL.pitch, bearing: INITIAL.bearing, duration: 1800 });
  }

  function switchView(next) {
    setView(next);
    setSelectedId(null);
    setChainKey(null);
    // all candidates is a city-wide view; going back to search re-frames the searched building
    if (next === "all") mapRef.current?.flyTo({ center: [INITIAL.longitude, INITIAL.latitude], zoom: INITIAL.zoom, pitch: INITIAL.pitch, bearing: INITIAL.bearing, duration: 1800 });
    else if (focus) flyToPoints([focus, ...partnerRows.slice(0, 8).map((r) => r.other)]);
  }

  // demo shortcuts: "c" = search for NYCHA Fulton Houses (Con Ed's Chelsea pilot site), "o" = back to the city
  useEffect(() => {
    function onKey(e) {
      if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || !data) return;
      if (e.key === "c") {
        const fultonId = data.pairById.get(data.summary.bookmarks.chelsea[0])?.k;
        const b = data.buildings.get(fultonId);
        if (b) pickEntry(entryFromBuilding(b));
      }
      if (e.key === "o") clearFocus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <div className="loading">Could not load data ({error}). Run <code>python symbiocity.py</code> first.</div>;
  if (!data) return <div className="loading">Loading NYC buildings…</div>;

  return (
    <div className={`app ${searchMode ? "is-search" : "is-all"}`}>
      <div className="map-wrap">
        <MapView
          mapRef={mapRef}
          data={data}
          grids={grids}
          pairs={arcPairs}
          mode={view}
          focus={searchMode ? focus : null}
          partners={searchMode ? partnerPairs : null}
          selected={selected}
          chain={searchMode ? null : selectedChain}
          onSelect={selectPair}
          onPickBuilding={(id) => pickEntry(entryFromBuilding(data.buildings.get(id)))}
          hour={hour}
          month={month}
          heatMode={filters.mode}
          storage={filters.storage}
          flowMax={flowMax}
        />
      </div>

      <header className="top">
        <div className="wordmark">Heat<span>Match</span><small>NYC</small></div>
        <div className="search-wrap">
          <SearchBar value={focus} onPick={pickEntry} onClear={clearFocus} />
          {searchMode && !focus && (
            <div className="search-hint">Find a heat-sharing partner for one building</div>
          )}
          {!searchMode && (
            <div className="search-hint">Citywide screening for planners</div>
          )}
        </div>
        <div className="mode-switch" role="group" aria-label="View mode">
          <button
            type="button"
            className={searchMode ? "on" : ""}
            onClick={() => switchView("search")}
            title="Find partners for one building"
          >
            My building
          </button>
          <button
            type="button"
            className={!searchMode ? "on" : ""}
            onClick={() => switchView("all")}
            title="Browse every match citywide"
          >
            Citywide
          </button>
        </div>
      </header>

      {searchMode && !focus && (
        <div className="empty-tip compact">
          <p>Search a building to see nearby partners worth contacting.</p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              const fultonId = data.pairById.get(data.summary.bookmarks.chelsea[0])?.k;
              const b = data.buildings.get(fultonId);
              if (b) pickEntry(entryFromBuilding(b));
            }}
          >
            Try Chelsea / Fulton example
          </button>
          <div className="empty-legend">
            <span><i className="lg-heat" /> Gives heat</span>
            <span><i className="lg-cold" /> Needs heat</span>
          </div>
        </div>
      )}

      {searchMode && focus && !selected && (
        <ResultsPanel
          entry={focus}
          building={focus.id >= 0 ? data.buildings.get(focus.id) : null}
          partners={partnerRows}
          nearby={nearby}
          mode={filters.mode}
          setMode={(m) => setFilters((f) => ({ ...f, mode: m }))}
          selectedId={selectedId}
          onSelect={selectPair}
          onClose={clearFocus}
        />
      )}

      {searchMode && focus && selected && (
        <PairDrawer
          key={selected.id}
          data={data}
          grids={grids}
          pair={selected}
          filters={filters}
          setFilters={setFilters}
          hour={hour}
          month={month}
          focusEntry={focus}
          embedded
          onBack={() => setSelectedId(null)}
          onClose={clearFocus}
        />
      )}

      {!searchMode && (
        <Sidebar
          data={data}
          filters={filters}
          setFilters={setFilters}
          pairs={filtered}
          totals={totals}
          selectedId={selectedId}
          onSelect={selectPair}
          chains={chains}
          chainsBusy={chainsBusy || (filters.chainSize > 2 && !grids)}
          chainKey={chainKey}
          onSelectChain={selectChain}
        />
      )}

      {!searchMode && selected && (
        <PairDrawer
          key={selected.id}
          data={data}
          grids={grids}
          pair={selected}
          filters={filters}
          setFilters={setFilters}
          hour={hour}
          month={month}
          onClose={() => setSelectedId(null)}
        />
      )}

      {!searchMode && selectedChain && (
        <ChainDrawer key={selectedChain.key} data={data} grids={grids} chain={selectedChain} filters={filters}
          hour={hour} month={month} onClose={() => setChainKey(null)} />
      )}

      {!searchMode && !selected && !selectedChain && (
        <div className="map-legend">
          <div className="eyebrow">Map index</div>
          <div className="legend-row"><i className="lg-heat" /> Gives heat</div>
          <div className="legend-row"><i className="lg-cold" /> Needs heat</div>
        </div>
      )}

      {searchMode && focus && !selected && (
        <div className="map-legend">
          <div className="legend-row"><i className="lg-heat" /> Gives heat</div>
          <div className="legend-row"><i className="lg-cold" /> Needs heat</div>
          <div className="note">Click a partner to focus just that match</div>
        </div>
      )}

      {!searchMode && (
        <TimeBar hour={hour} setHour={setHour} month={month} setMonth={setMonth} pairs={filtered}
          grids={grids} mode={filters.mode} flowMax={flowMax} />
      )}
    </div>
  );
}
