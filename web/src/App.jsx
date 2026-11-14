import React, { useEffect, useMemo, useRef, useState } from "react";
import MapView, { INITIAL } from "./MapView.jsx";
import Sidebar from "./Sidebar.jsx";
import PairDrawer from "./PairDrawer.jsx";
import ChainDrawer from "./ChainDrawer.jsx";
import TimeBar from "./TimeBar.jsx";
import SearchBar from "./SearchBar.jsx";
import ResultsPanel from "./ResultsPanel.jsx";
import { buildIndex, findChains } from "./chain.js";
import { loadIndex, nearbyOpposite, searchIndex } from "./search.js";
import OwnerDataPanel from "./OwnerDataPanel.jsx";
import AssistantPanel from "./AssistantPanel.jsx";
import { applyOwner, loadOwner, saveOwner, loadQuotes, saveQuotes } from "./owner.js";
import { getIntent, matchesTypes, sortRows, describeFilter, sayCost, sayPayback, TYPE_LABEL, SORT_LABEL } from "./intent.js";
import { filterPairs, portfolio, computeFlowMax, pairEcon, fmt } from "./econ.js";

const COMMERCIAL_KINDS = ["refrigeration", "hospital", "office"];
const DEFAULT_FILTERS = {
  maxDist: 60,
  minCoincidence: 0.4,
  tiers: [1, 2, 3, 4],
  kinds: COMMERCIAL_KINDS, // commercial-tab source filter (the data-center tab has one kind)
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
  role: `${b.dc ? "d" : ""}${b.source ? "s" : ""}${b.sink ? "k" : ""}`, has_dc: 1, has_com: 1,
});

export default function App() {
  const [rawData, setData] = useState(null);
  const [rawGrids, setGrids] = useState(null);
  const [error, setError] = useState(null);
  // owner-entered data (kept in this browser only) replaces the public-data model for those buildings
  const [owner, setOwner] = useState(loadOwner);
  const [quotes, setQuotes] = useState(loadQuotes);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const { data, grids } = useMemo(() => applyOwner(rawData, rawGrids, owner), [rawData, rawGrids, owner]);
  // voice assistant
  const [askOpen, setAskOpen] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [askLog, setAskLog] = useState([]);
  const [intent, setIntent] = useState(null); // the assistant's current filter on the partner list
  const [muted, setMuted] = useState(false);
  const pendingReply = useRef(null);
  const [tab, setTab] = useState("dc"); // "dc" (data centers, the main product) | "commercial" (estimate-heavy)
  const [view, setView] = useState("search"); // "search" (default) | "all" (every candidate)
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [focus, setFocus] = useState(null); // the searched building (a search-index entry)
  const [searchMaxDist, setSearchMaxDist] = useState(100);
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
        for (const pair of p) pair._srcKind = pair.track === "dc" ? "datacenter" : buildings.get(pair.s)?.source;
        setData({ buildings, pairs: p, summary: s, pairById: new Map(p.map((x) => [x.id, x])) });
        loadJSON("grids.json").then(setGrids).catch(() => {});
      })
      .catch((e) => setError(String(e)));
  }, []);

  const A = data?.summary.assumptions;
  const searchMode = view === "search";

  // ---- the active tab's pairs (each pair belongs to one track)
  const tabPairs = useMemo(() => (data ? data.pairs.filter((p) => p.track === tab) : []), [data, tab]);
  const kinds = useMemo(() => (tab === "dc" ? ["datacenter"] : filters.kinds), [tab, filters.kinds]);

  // ---- all-candidates view
  const filtered = useMemo(
    () => filterPairs(tabPairs, { ...filters, kinds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabPairs, filters.maxDist, filters.minCoincidence, filters.tiers, kinds, filters.mode],
  );
  const totals = useMemo(
    () => (data ? portfolio(filtered, data.buildings, A, { mode: filters.mode, storage: filters.storage }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filtered, filters.mode, filters.storage],
  );

  // ---- search view: every candidate pair is drawn as a faint yellow arc; the searched building's partners pop
  const allPairs = useMemo(
    () => filterPairs(tabPairs, { ...DEFAULT_FILTERS, kinds: ["datacenter", ...COMMERCIAL_KINDS], maxDist: 150, minCoincidence: 0, mode: filters.mode }),
    [tabPairs, filters.mode],
  );
  const partnerRows = useMemo(() => {
    if (!data || !focus || focus.id < 0) return [];
    const opts = { mode: filters.mode, storage: filters.storage };
    const maxDist = Math.min(searchMaxDist, intent?.max_distance_m ?? Infinity);
    const rows = tabPairs
      .filter((p) => (p.s === focus.id || p.k === focus.id) && p.dist_m <= maxDist)
      .map((p) => {
        const youAreSource = p.s === focus.id;
        return { p, youAreSource, other: data.buildings.get(youAreSource ? p.k : p.s),
          e: pairEcon(p, data.buildings.get(p.k), A, { ...opts, quote: quotes[p.id] }) };
      })
      // the assistant's request narrows the list: building types, and "don't cross a street"
      .filter((r) => !intent || (matchesTypes(r.other, intent.partner_types) && (!intent.no_street_crossing || r.p.tier <= 2)));
    return intent ? sortRows(rows, intent.sort) : rows.sort((a, b) => (a.e.payback ?? 1e9) - (b.e.payback ?? 1e9) || b.e.value - a.e.value);
  }, [data, A, tabPairs, focus, searchMaxDist, filters.mode, filters.storage, intent, quotes]);
  const partnerPairs = useMemo(() => partnerRows.map((r) => r.p), [partnerRows]);
  // partners the searched building has in the *other* tab (offer to switch)
  const otherTab = tab === "dc" ? "commercial" : "dc";
  const otherTabCount = useMemo(() => {
    if (!data || !focus || focus.id < 0) return 0;
    return data.pairs.filter((p) => p.track === otherTab && (p.s === focus.id || p.k === focus.id) && p.dist_m <= searchMaxDist).length;
  }, [data, focus, otherTab, searchMaxDist]);

  useEffect(() => {
    setNearby([]);
    if (!focus || focus.id < 0 || partnerRows.length) return;
    loadIndex().then((ix) => setNearby(nearbyOpposite(ix, focus, tab)));
  }, [focus, partnerRows.length, tab]);

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
      setChains(findChains({ size: filters.chainSize, pairs: filtered, buildings: data.buildings, grids, A, filters: { ...filters, kinds }, index, track: tab }));
      setChainsBusy(false);
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, grids, filtered, filters.chainSize, searchMode, tab]);
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

  function pickEntry(entry, keepIntent = false) {
    setView("search");
    setSelectedId(null);
    setChainKey(null);
    if (!keepIntent) setIntent(null); // a manual search clears the assistant's filter
    setFocus(entry);
  }

  // ---- owner data
  function applyOwnerRecord(id, rec) {
    setOwner((cur) => { const next = { ...cur }; if (rec) next[id] = rec; else delete next[id]; saveOwner(next); return next; });
    setOwnerOpen(false);
  }
  function setQuote(pairId, value) {
    setQuotes((cur) => { const next = { ...cur }; if (value > 0) next[pairId] = value; else delete next[pairId]; saveQuotes(next); return next; });
  }

  // ---- voice assistant: the AI turns the request into filters; the app runs the search on its own data
  async function ask(text) {
    setAskLog((l) => [...l, { who: "you", text }]);
    setAskBusy(true);
    const { intent: it, offline } = await getIntent({ text, tab, focusName: focus?.name, previous: intent });
    setAskBusy(false);
    if (it.clarify) return say(it.clarify, { offline });

    let entry = focus;
    if (it.anchor_text) {
      const hits = searchIndex(await loadIndex(), it.anchor_text, 6);
      const wantTab = it.tab || (it.my_role === "data_center" ? "dc" : null);
      entry = hits.find((h) => (wantTab === "dc" ? h.has_dc : wantTab === "commercial" ? h.has_com : h.has_dc || h.has_com)) || hits[0] || null;
      if (!entry) return say(`I couldn't find a benchmarked building matching “${it.anchor_text}”. Try the street address.`, { offline });
    }
    if (!entry) return say("Which building is yours? Tell me its name or street address.", { offline });

    const nextTab = it.tab || (entry.has_dc ? "dc" : entry.has_com ? "commercial" : tab);
    if (nextTab !== tab) setTab(nextTab);
    if (it.heat_use) setFilters((f) => ({ ...f, mode: it.heat_use }));
    setSearchMaxDist(150);
    setIntent(it);
    pendingReply.current = { offline, chips: describeFilter(it) };
    if (!focus || entry.id !== focus.id) pickEntry(entry, true);
    else { setView("search"); setSelectedId(null); }
  }

  function say(text, extra = {}) {
    setAskLog((l) => [...l, { who: "bot", text, ...extra }]);
    if (muted || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  // once the filtered partner list is ready, answer from the real results
  useEffect(() => {
    const pending = pendingReply.current;
    if (!pending || !intent || !focus || !data) return;
    pendingReply.current = null;
    const kinds = intent.partner_types.length ? intent.partner_types.map((t) => TYPE_LABEL[t]).join(" or ") : "buildings";
    const where = `${intent.max_distance_m != null ? `within ${Math.round(intent.max_distance_m)} meters of` : "near"} ${focus.name}`;
    if (focus.id < 0) return say(`${focus.name} isn't a heat-sharing candidate in the public data, so I have no partners to show for it.`, pending);
    if (!partnerRows.length)
      return say(`I didn't find any ${kinds} ${where}${intent.no_street_crossing ? " without crossing a street" : ""}. Try a wider distance or other building types.`, pending);
    const best = partnerRows[0];
    say(`I found ${partnerRows.length} ${partnerRows.length === 1 ? kinds.replace(/s\b/g, "") : kinds} ${where}. `
      + `The ${SORT_LABEL[intent.sort] === "best payback" ? "best payback" : SORT_LABEL[intent.sort]} is ${best.other.name}, ${Math.round(best.p.dist_m)} meters away: `
      + `an estimated ${sayCost(best.e.capexLow, best.e.capexHigh)} to build, ${sayPayback(best.e.paybackLow, best.e.paybackHigh)}.`, pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerRows, intent, focus]);
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
    setIntent(null);
    setSelectedId(null);
    mapRef.current?.flyTo({ center: [INITIAL.longitude, INITIAL.latitude], zoom: INITIAL.zoom, pitch: INITIAL.pitch, bearing: INITIAL.bearing, duration: 1800 });
  }

  function switchTab(next) {
    setTab(next);
    setSelectedId(null);
    setChainKey(null);
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
        if (b) { setTab("dc"); setSearchMaxDist(150); pickEntry(entryFromBuilding(b)); }
      }
      if (e.key === "o") clearFocus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <div className="loading">Could not load data ({error}). Run <code>python symbiocity.py</code> first.</div>;
  if (!data) return <div className="loading">Loading NYC buildings…</div>;

  const P = data.summary.portfolio;
  const hint = tab === "dc"
    ? <>{fmt.int(P.dc.sources_with_partner)} NYC data centers have a neighbor that could use their waste heat. Try “111 Eighth Avenue” or press <kbd>c</kbd></>
    : <>Hotels, grocery stores, offices and hospitals. Estimate-based matches. Try “1515 Broadway”</>;

  return (
    <div className={`app ${searchMode ? "is-search" : "is-all"} tab-${tab}`}>
      <div className="map-wrap">
        <MapView
          mapRef={mapRef}
          data={data}
          grids={grids}
          pairs={arcPairs}
          mode={view}
          tab={tab}
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
        <div className="brand-row">
          <div className="wordmark">Heat<span>Match</span><small>NYC</small></div>
          <div className="tabs" role="tablist" aria-label="Analysis">
            <button role="tab" aria-selected={tab === "dc"} className={tab === "dc" ? "on" : ""} onClick={() => switchTab("dc")}>Data centers</button>
            <button role="tab" aria-selected={tab === "commercial"} className={tab === "commercial" ? "on" : ""} onClick={() => switchTab("commercial")}>
              Commercial <span className="est">est.</span>
            </button>
          </div>
        </div>
        <div className="search-wrap">
          <SearchBar value={focus} onPick={(e) => pickEntry(e)} onClear={clearFocus} onAsk={() => setAskOpen((o) => !o)} asking={askOpen} />
          {askOpen && (
            <AssistantPanel log={askLog} busy={askBusy} onAsk={ask} muted={muted} setMuted={setMuted}
              onClose={() => { setAskOpen(false); window.speechSynthesis?.cancel(); }} />
          )}
          {searchMode && !focus && !askOpen && <div className="search-hint">{hint}</div>}
        </div>
        <label className="toggle" title="Show every candidate pair in the city">
          <input type="checkbox" checked={!searchMode} onChange={(e) => switchView(e.target.checked ? "all" : "search")} />
          <span className="track"><span className="thumb" /></span>
          <span>All candidates</span>
        </label>
      </header>

      {searchMode && focus && (
        <ResultsPanel
          entry={focus}
          tab={tab}
          otherTabCount={otherTabCount}
          onSwitchTab={() => switchTab(otherTab)}
          building={focus.id >= 0 ? data.buildings.get(focus.id) : null}
          partners={partnerRows}
          nearby={nearby}
          maxDist={searchMaxDist}
          setMaxDist={setSearchMaxDist}
          mode={filters.mode}
          setMode={(m) => setFilters((f) => ({ ...f, mode: m }))}
          selectedId={selectedId}
          onSelect={selectPair}
          onClose={clearFocus}
          intentChips={intent ? describeFilter(intent).slice(0, -1) : null}
          sortLabel={intent ? SORT_LABEL[intent.sort] : null}
          onClearIntent={() => setIntent(null)}
          onOwnerData={() => setOwnerOpen(true)}
        />
      )}

      {ownerOpen && focus && focus.id >= 0 && data.buildings.get(focus.id) && (
        <OwnerDataPanel
          building={data.buildings.get(focus.id)}
          grid={rawGrids?.[focus.id]}
          A={A}
          record={owner[focus.id]}
          defaultKind={tab === "dc" ? "dc" : "sink"}
          onApply={(rec) => applyOwnerRecord(focus.id, rec)}
          onReset={() => applyOwnerRecord(focus.id, null)}
          onClose={() => setOwnerOpen(false)}
        />
      )}

      {!searchMode && (
        <Sidebar
          data={data}
          filters={filters}
          setFilters={setFilters}
          pairs={filtered}
          totals={totals}
          tab={tab}
          selectedId={selectedId}
          onSelect={selectPair}
          chains={chains}
          chainsBusy={chainsBusy || (filters.chainSize > 2 && !grids)}
          chainKey={chainKey}
          onSelectChain={selectChain}
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
          focusId={searchMode ? focus?.id : null}
          quote={quotes[selected.id]}
          setQuote={(v) => setQuote(selected.id, v)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {!searchMode && selectedChain && (
        <ChainDrawer key={selectedChain.key} data={data} grids={grids} chain={selectedChain} filters={filters}
          hour={hour} month={month} onClose={() => setChainKey(null)} />
      )}

      {!searchMode && (
        <TimeBar hour={hour} setHour={setHour} month={month} setMonth={setMonth} pairs={filtered}
          grids={grids} mode={filters.mode} flowMax={flowMax} />
      )}
    </div>
  );
}
