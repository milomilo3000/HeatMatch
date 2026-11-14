import React, { useEffect, useMemo, useRef, useState } from "react";
import MapView from "./MapView.jsx";
import Sidebar from "./Sidebar.jsx";
import PairDrawer from "./PairDrawer.jsx";
import ChainDrawer from "./ChainDrawer.jsx";
import { buildIndex, findChains } from "./chain.js";
import TimeBar from "./TimeBar.jsx";
import { filterPairs, portfolio, computeFlowMax, fmt } from "./econ.js";

const DEFAULT_FILTERS = {
  maxDist: 60,
  minCoincidence: 0.4,
  tiers: [1, 2, 3, 4],
  kinds: ["datacenter", "refrigeration", "hospital", "office"],
  mode: "all",
  storage: 0,
  sort: "tco2e",
  chainSize: 2, // 2 = classic source→user pairs; 3–6 = pipeline chains
};

async function loadJSON(name) {
  const r = await fetch(`/data/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

export default function App() {
  const [data, setData] = useState(null);
  const [grids, setGrids] = useState(null);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState(null);
  const [hour, setHour] = useState(19);
  const [month, setMonth] = useState(0);
  const [chains, setChains] = useState([]);
  const [chainsBusy, setChainsBusy] = useState(false);
  const [chainKey, setChainKey] = useState(null);
  const mapRef = useRef(null);
  const bookmarkIdx = useRef(0);

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

  const filtered = useMemo(
    () => (data ? filterPairs(data.pairs, filters) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filters.maxDist, filters.minCoincidence, filters.tiers, filters.kinds, filters.mode],
  );
  const opts = { mode: filters.mode, storage: filters.storage };
  const totals = useMemo(
    () => (data ? portfolio(filtered, data.buildings, data.summary.assumptions, opts) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filtered, filters.mode, filters.storage],
  );

  const flowMax = useMemo(() => computeFlowMax(filtered, grids, filters.mode), [filtered, grids, filters.mode]);

  const selected = data && selectedId != null ? data.pairById.get(selectedId) : null;

  // --- pipeline chains: searched in the background whenever the chain size or filters change
  const index = useMemo(() => (data ? buildIndex(data.buildings) : null), [data]);
  useEffect(() => {
    setChainKey(null);
    if (!data || !grids || filters.chainSize < 3) { setChains([]); return; }
    setChainsBusy(true);
    const t = setTimeout(() => {
      setChains(findChains({ size: filters.chainSize, pairs: filtered, buildings: data.buildings, grids,
        A: data.summary.assumptions, filters, index }));
      setChainsBusy(false);
    }, 30); // let the "searching…" state paint first
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, grids, filtered, filters.chainSize]);
  const selectedChain = chainKey ? chains.find((c) => c.key === chainKey) : null;

  function selectChain(key) {
    const c = chains.find((x) => x.key === key);
    setSelectedId(null);
    setChainKey(key);
    if (!c || !mapRef.current) return;
    const bs = c.ids.map((id) => data.buildings.get(id));
    const lons = bs.map((b) => b.lon), lats = bs.map((b) => b.lat);
    const extentM = Math.max((Math.max(...lons) - Math.min(...lons)) * 84_300, (Math.max(...lats) - Math.min(...lats)) * 111_320, 60);
    mapRef.current.flyTo({
      center: [(Math.max(...lons) + Math.min(...lons)) / 2, (Math.max(...lats) + Math.min(...lats)) / 2],
      zoom: Math.max(15.9, Math.min(17.2, 17.6 - Math.log2(extentM / 60))), pitch: 52, bearing: -29, duration: 2400, essential: true,
    });
  }

  function selectPair(id, fly = true) {
    setChainKey(null);
    setSelectedId(id);
    const p = data?.pairById.get(id);
    if (!p || !fly || !mapRef.current) return;
    const s = data.buildings.get(p.s), k = data.buildings.get(p.k);
    const bearing = (Math.atan2(k.lon - s.lon, k.lat - s.lat) * 180) / Math.PI + 70;
    mapRef.current.flyTo({
      center: [(s.lon + k.lon) / 2, (s.lat + k.lat) / 2],
      zoom: p.dist_m > 80 ? 16.1 : 16.6, pitch: 58, bearing, duration: 2400, essential: true,
    });
  }

  // demo shortcuts: "c" cycles the Chelsea pairs (Con Ed's 85 10th Ave pilot, then the closer
  // 111 Eighth Ave source HeatMatch found), "o" zooms back out to the city
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT") return;
      const marks = data?.summary.bookmarks.chelsea || [];
      if (e.key === "c" && marks.length) {
        setFilters((f) => ({ ...f, maxDist: 150, tiers: [1, 2, 3, 4] }));
        selectPair(marks[bookmarkIdx.current++ % marks.length]);
      }
      if (e.key === "o" && mapRef.current) {
        setSelectedId(null);
        setChainKey(null);
        mapRef.current.flyTo({ center: [-73.975, 40.735], zoom: 11.6, pitch: 45, bearing: -29, duration: 2000 });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <div className="loading">Could not load data ({error}). Run <code>python symbiocity.py</code> first.</div>;
  if (!data) return <div className="loading">Loading NYC buildings…</div>;

  const s = data.summary;
  return (
    <div className="app">
      <div className="map-wrap">
        <MapView
          mapRef={mapRef}
          data={data}
          grids={grids}
          pairs={filtered}
          selected={selected}
          chain={selectedChain}
          onSelect={selectPair}
          hour={hour}
          month={month}
          mode={filters.mode}
          storage={filters.storage}
          flowMax={flowMax}
        />
      </div>

      <div className="topbar">
        <div className="brand">
          <h1>Heat<span>Match</span> NYC</h1>
          <p>Waste heat next door, matched by the hour</p>
        </div>
        <div className="stat">
          <div className="v">{fmt.int(s.counts.buildings_screened)}</div>
          <div className="l">buildings screened (LL84 {s.year})</div>
        </div>
        <div className="stat">
          <div className="v">{fmt.int(totals.pairs)}</div>
          <div className="l">viable pairs in view</div>
        </div>
        <div className="stat heat">
          <div className="v">{fmt.big(totals.mmbtu)}</div>
          <div className="l">MMBtu/yr waste heat reused</div>
        </div>
        <div className="stat good">
          <div className="v">{fmt.big(totals.tco2e)}</div>
          <div className="l">tCO₂e/yr avoided</div>
        </div>
        <div className="stat">
          <div className="v">{fmt.usd(totals.value)}</div>
          <div className="l">/yr incl. LL97 · energy alone {fmt.usd(totals.energy)}</div>
        </div>
      </div>

      <Sidebar
        data={data}
        filters={filters}
        setFilters={setFilters}
        pairs={filtered}
        selectedId={selectedId}
        onSelect={selectPair}
        chains={chains}
        chainsBusy={chainsBusy || (filters.chainSize > 2 && !grids)}
        chainKey={chainKey}
        onSelectChain={selectChain}
      />

      {selectedChain && (
        <ChainDrawer
          key={selectedChain.key}
          data={data}
          grids={grids}
          chain={selectedChain}
          filters={filters}
          hour={hour}
          month={month}
          onClose={() => setChainKey(null)}
        />
      )}

      {selected && (
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

      {!selected && !selectedChain && (
        <div className="legend">
          <span><i style={{ background: "var(--heat)" }} />rejects heat</span>
          <span><i style={{ background: "var(--cold)" }} />burns fuel for heat</span>
          <span><i style={{ background: "#ffd166" }} />heat flowing now</span>
        </div>
      )}

      <TimeBar
        hour={hour}
        setHour={setHour}
        month={month}
        setMonth={setMonth}
        pairs={filtered}
        grids={grids}
        mode={filters.mode}
        flowMax={flowMax}
      />
    </div>
  );
}
