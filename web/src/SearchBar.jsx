import React, { useEffect, useRef, useState } from "react";
import { loadIndex, searchIndex, ROLE_LABEL } from "./search.js";

export default function SearchBar({ onPick, onClear, value }) {
  const [text, setText] = useState("");
  const [index, setIndex] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef(null);

  useEffect(() => setText(value ? value.name : ""), [value]);

  function ensureIndex() {
    if (index || loading) return;
    setLoading(true);
    loadIndex().then((ix) => { setIndex(ix); setLoading(false); });
  }

  useEffect(() => {
    if (!index) return;
    const t = setTimeout(() => { setHits(searchIndex(index, text)); setCursor(0); }, 60);
    return () => clearTimeout(t);
  }, [text, index]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function pick(e) {
    setOpen(false);
    setText(e.name);
    onPick(e);
  }

  function onKey(ev) {
    if (ev.key === "ArrowDown") { setCursor((c) => Math.min(c + 1, hits.length - 1)); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { setCursor((c) => Math.max(c - 1, 0)); ev.preventDefault(); }
    else if (ev.key === "Enter" && hits[cursor]) pick(hits[cursor]);
    else if (ev.key === "Escape") setOpen(false);
  }

  return (
    <div className="search" ref={box}>
      <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
      <input
        value={text}
        placeholder="Find energy-sharing partners for your building…"
        onFocus={() => { ensureIndex(); setOpen(true); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
        aria-label="Search for your building by name or address"
      />
      {text && (
        <button className="search-clear" onClick={() => { setText(""); setHits([]); onClear(); }} aria-label="Clear search">×</button>
      )}
      {open && text.trim() && (
        <div className="search-menu">
          {loading && <div className="search-empty">Loading NYC buildings…</div>}
          {!loading && index && !hits.length && (
            <div className="search-empty">No benchmarked building matches “{text}”. Try the street address.</div>
          )}
          {hits.map((e, i) => (
            <button key={`${e.id}-${e.name}-${e.address}`} className={`search-row ${i === cursor ? "on" : ""}`}
              onMouseEnter={() => setCursor(i)} onClick={() => pick(e)}>
              <span className="search-main">
                <b>{e.name}</b>
                <span>{e.address}{e.borough ? `, ${e.borough}` : ""}</span>
              </span>
              <span className={`role-chip r-${e.role || "none"}`}>{ROLE_LABEL[e.role]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
