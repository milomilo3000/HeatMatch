import React, { useRef, useState } from "react";
import { UNITS, FUEL_UNITS, buildOverride, parseCsvUsage, IT_HEAT_FACTOR } from "./owner.js";
import { fmt, FUEL_LABEL, MONTHS } from "./econ.js";

const blankMonths = () => new Array(12).fill("");

// A modal where an owner enters their own energy data, by hand or from a file. Nothing is applied
// until they press Apply, and what they apply is kept only in this browser.
export default function OwnerDataPanel({ building, grid, A, record, defaultKind, onApply, onReset, onClose }) {
  const canDc = !!building.dc, canSink = !!building.sink;
  const [kind, setKind] = useState(record?.kind || (defaultKind === "dc" && canDc ? "dc" : canSink ? "sink" : "dc"));
  const [itKw, setItKw] = useState(record?.itKw ?? "");
  const [itMwh, setItMwh] = useState("");
  const [fuel, setFuel] = useState(record?.fuel || (A.fuels[building.fuel] ? building.fuel : "gas"));
  const [unit, setUnit] = useState(record?.unit || FUEL_UNITS[A.fuels[building.fuel] ? building.fuel : "gas"][0]);
  const [monthly, setMonthly] = useState(record?.monthly?.map((v) => v ?? "") || blankMonths());
  const [annual, setAnnual] = useState(record?.annual ?? "");
  const [price, setPrice] = useState(record?.pricePerUnit ?? "");
  const [busy, setBusy] = useState(false);
  const [fileNote, setFileNote] = useState(null); // { tone, text }
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const kw = itKw !== "" ? +itKw : itMwh !== "" ? (+itMwh * 1000) / 8760 : 0;
  const rec = kind === "dc"
    ? { kind, itKw: kw }
    : { kind, fuel, unit, monthly: monthly.map((v) => (v === "" ? null : +v)), annual: annual === "" ? null : +annual, pricePerUnit: price === "" ? null : +price };
  const preview = buildOverride(building, grid || {}, A, rec);
  const filled = monthly.filter((v) => v !== "").length;

  function pickFuel(f) {
    setFuel(f);
    if (!FUEL_UNITS[f].includes(unit)) setUnit(FUEL_UNITS[f][0]);
  }

  function fill(out, fileName) {
    if (out.building_kind === "data_center" && canDc) setKind("dc");
    else if (out.building_kind === "heat_user" && canSink) setKind("sink");
    if (out.it_load_kw > 0) { setItKw(Math.round(out.it_load_kw)); setItMwh(""); }
    const heating = ["gas", "steam", "oil"].includes(out.fuel);
    if (heating) {
      setFuel(out.fuel);
      if (out.unit && UNITS[out.unit]) setUnit(out.unit);
      if (out.monthly?.some((v) => v != null)) setMonthly(out.monthly.map((v) => (v == null ? "" : v)));
      else if (out.annual_total > 0) setAnnual(out.annual_total);
      if (out.price_per_unit_usd > 0) setPrice(+out.price_per_unit_usd.toFixed(4));
    }
    const got = out.it_load_kw > 0 || (heating && (out.monthly?.some((v) => v != null) || out.annual_total > 0));
    setFileNote({
      tone: !got || out.confidence === "low" ? "warn" : "ok",
      text: `${fileName}: ${got ? `read with ${out.confidence || "unknown"} confidence${out.period ? ` (${out.period})` : ""}.` : "no usable energy data found."} ${out.notes || ""} ${got ? "Check the numbers below before applying." : ""}`,
    });
  }

  async function onFile(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    setBusy(true); setFileNote(null); setError("");
    try {
      const r = await fetch(`/api/extract-usage?filename=${encodeURIComponent(file.name)}&kind=${kind === "dc" ? "data_center" : "heat_user"}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const out = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("use Demo login to unlock AI file reading");
      if (!r.ok) throw new Error(out.error || `error ${r.status}`);
      fill(out, file.name);
    } catch (err) {
      // no AI reader: simple CSVs can still be read right here
      const csv = /\.(csv|tsv|txt)$/i.test(file.name) ? parseCsvUsage(await file.text()) : null;
      if (csv) {
        setMonthly(csv.monthly.map((v) => (v == null ? "" : v)));
        if (csv.unit) setUnit(csv.unit);
        setFileNote({ tone: "warn", text: `${file.name}: ${csv.notes}` });
      } else {
        setFileNote({ tone: "warn", text: `Couldn't read ${file.name} (${err.message}). You can type the numbers in instead.` });
      }
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (preview.error) return setError(preview.error);
    onApply({ ...rec, savedAt: new Date().toISOString() });
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Use my real numbers">
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <div className="eyebrow">Use my real numbers</div>
        <h2>{building.name}</h2>
        <p className="muted" style={{ margin: "4px 0 12px" }}>
          HeatMatch models this building from public benchmarking data. Your own figures replace that model and
          update every partner estimate. They stay in this browser and are never uploaded or shared.
        </p>

        {canDc && canSink && (
          <div className="seg" style={{ marginBottom: 12 }}>
            <button className={kind === "dc" ? "on" : ""} onClick={() => setKind("dc")}>My data center's heat</button>
            <button className={kind === "sink" ? "on" : ""} onClick={() => setKind("sink")}>My heating fuel use</button>
          </div>
        )}

        <div className="upload">
          <input ref={fileRef} type="file" hidden onChange={onFile} accept=".pdf,.csv,.tsv,.txt,.xml,.json,.xlsx,.xls,.xlsm,.png,.jpg,.jpeg,.webp,.gif" />
          <button className="ghost-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Reading your file…" : "Upload a bill or usage file"}
          </button>
          <span className="muted">
            PDF, spreadsheet, CSV or a photo of a bill. An AI model (Claude) reads the file to find your usage and
            units; the file isn't kept.
          </span>
        </div>
        {fileNote && <div className={`file-note ${fileNote.tone}`}>{fileNote.text}</div>}

        {kind === "dc" ? (
          <div className="form">
            <label>Average IT load (kW)
              <input type="number" min="0" value={itKw} onChange={(e) => { setItKw(e.target.value); setItMwh(""); }} placeholder="e.g. 2400" />
            </label>
            <div className="or">or</div>
            <label>IT energy per year (MWh)
              <input type="number" min="0" value={itMwh} onChange={(e) => { setItMwh(e.target.value); setItKw(""); }} placeholder="e.g. 21000" />
            </label>
            <p className="note" style={{ gridColumn: "1 / -1" }}>
              IT load is what your UPS or PDUs deliver to the servers. Nearly all of it becomes heat; the chillers add
              about {Math.round((IT_HEAT_FACTOR - 1) * 100)}% more. Air-cooled sites (no condenser-water loop) are harder to
              capture heat from than this assumes.
            </p>
          </div>
        ) : (
          <div className="form">
            <label>Heating fuel
              <select value={fuel} onChange={(e) => pickFuel(e.target.value)}>
                {Object.keys(FUEL_UNITS).map((f) => <option key={f} value={f}>{FUEL_LABEL[f]}</option>)}
              </select>
            </label>
            <label>Unit on your bill
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {FUEL_UNITS[fuel].map((u) => <option key={u} value={u}>{UNITS[u].label}</option>)}
              </select>
            </label>
            <div className="months">
              {MONTHS.map((m, i) => (
                <label key={m}>{m}
                  <input type="number" min="0" value={monthly[i]}
                    onChange={(e) => setMonthly((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))} />
                </label>
              ))}
            </div>
            <label>{filled ? "Annual total (not needed)" : "Or just the annual total"}
              <input type="number" min="0" value={annual} disabled={filled > 0} onChange={(e) => setAnnual(e.target.value)} />
            </label>
            <label>Price per {unit} ($, optional)
              <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="from your bill" />
            </label>
            {filled > 0 && filled < 12 && (
              <p className="note" style={{ gridColumn: "1 / -1" }}>
                {12 - filled} month{12 - filled > 1 ? "s" : ""} blank: those follow the model's seasonal shape, scaled to the months you entered.
              </p>
            )}
          </div>
        )}

        {!preview.error && (
          <div className="preview">
            Your {preview.summary.what}: <b>{fmt.int(preview.summary.yours)} MMBtu/yr</b>
            <span className="muted"> · public-data model: {fmt.int(preview.summary.model)} MMBtu/yr
              ({preview.summary.model > 0 ? `${preview.summary.yours >= preview.summary.model ? "+" : ""}${Math.round((preview.summary.yours / preview.summary.model - 1) * 100)}%` : "n/a"})</span>
          </div>
        )}
        {error && <div className="file-note warn">{error}</div>}

        <div className="modal-actions">
          {record && <button className="ghost" style={{ flex: "none" }} onClick={onReset}>Reset to public data</button>}
          <span style={{ flex: 1 }} />
          <button className="ghost" style={{ flex: "none" }} onClick={onClose}>Cancel</button>
          <button className="cta" style={{ width: "auto", padding: "9px 18px" }} onClick={apply} disabled={!!preview.error}>Apply my numbers</button>
        </div>
      </div>
    </div>
  );
}
