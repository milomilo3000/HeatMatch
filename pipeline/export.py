"""Write the static JSON the web demo loads (no live API calls needed on stage)."""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
import shapely

from . import config as C
from . import fetch
from . import profiles as P

KEEP_TIER4_MIN_T = 300  # keep a far (tier 4) pair only if it is big, e.g. Con Ed's Chelsea pilot


def _r(x, nd=0):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return None
    return round(float(x), nd) if nd else int(round(float(x)))


def _polys(geom) -> list:
    """Shapely (Multi)Polygon in lon/lat -> list of outer rings, simplified (~0.5 m) and rounded.
    Grown by ~0.5 m so our extrusions sit just outside the basemap's identical 3D buildings
    (otherwise the coincident walls flicker)."""
    g = shapely.buffer(geom, 6e-6, join_style="mitre")
    g = shapely.simplify(g, 5e-6, preserve_topology=True)
    parts = list(g.geoms) if hasattr(g, "geoms") else [g]
    out = []
    for part in parts:
        if part.geom_type != "Polygon" or part.is_empty:
            continue
        out.append([[round(x, 6), round(y, 6)] for x, y in part.exterior.coords])
    return out


def _grid(x: np.ndarray) -> tuple[list[int], float]:
    """8760 kBtu/h -> 12x24 grid scaled to 0..999 plus its max (kBtu/h)."""
    g = P.grid(x).ravel()
    mx = float(g.max())
    return ([int(round(v / mx * 999)) for v in g] if mx > 0 else [0] * 288), mx


def select_pairs(p: pd.DataFrame) -> pd.DataFrame:
    keep = (p["tier"] <= 3) | ((p["t_co2e"] >= KEEP_TIER4_MIN_T) & (p["value_usd"] > 0))
    return p[keep & (p["matched_all_0"] > 0)].sort_values("t_co2e", ascending=False)


def write(b: pd.DataFrame, p: pd.DataFrame, src_prof: dict, sink_prof: dict, fac: pd.DataFrame):
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    ex = select_pairs(p)
    ids = sorted(set(ex["s"]) | set(ex["k"]))

    buildings, grids = [], {}
    for i in ids:
        r = b.loc[i]
        c = r["geom_ll"].centroid
        buildings.append({
            "id": int(i), "name": r["property_name"], "address": r["address_1"], "borough": r["borough"],
            "type": r["primary_property_type"], "source": r["source_kind"] if isinstance(r["source_kind"], str) else None,
            "sink": r["sink_kind"] if isinstance(r["sink_kind"], str) else None,
            "fuel": r["main_fuel"] if isinstance(r["main_fuel"], str) else None,
            "owner": r["owner"] if isinstance(r["owner"], str) else None,
            "units": _r(r["units"]) if pd.notna(r["units"]) else None, "gfa": _r(r["gfa"]),
            "elec_kbtu": _r(r["elec"]), "heat_kbtu": _r(r["heat_fuel"]), "towers": int(r["towers"]),
            "dc_share": _r(r["dc_elec_share"], 2), "monthly_gas": bool(r["gas_monthly_ok"]),
            "bbl": r["bbl"] if isinstance(r["bbl"], str) else None,
            "height_m": _r(r["height_ft"] / 3.28084, 1), "lon": round(c.x, 6), "lat": round(c.y, 6),
            "polygons": _polys(r["geom_ll"]),
            "usd_per_kbtu": _r(fac.at[i, "usd_per_kbtu"], 5) if pd.notna(fac.at[i, "usd_per_kbtu"]) else None,
            "t_per_kbtu": _r(fac.at[i, "t_per_kbtu"], 8) if pd.notna(fac.at[i, "t_per_kbtu"]) else None,
        })
        g = {}
        if i in src_prof:
            g["src"], g["src_max"] = _grid(src_prof[i])
        if i in sink_prof:
            g["dhw"], g["dhw_max"] = _grid(sink_prof[i][0])
            g["space"], g["space_max"] = _grid(sink_prof[i][1])
        grids[int(i)] = g

    metric_cols = [c for c in ex.columns if c.startswith(("matched_", "peak_"))]
    pairs = []
    for rank, (idx, r) in enumerate(ex.iterrows(), 1):
        d = {"id": int(idx), "rank": rank, "s": int(r["s"]), "k": int(r["k"]), "dist_m": _r(r["dist_m"], 1),
             "tier": int(r["tier"]), "avail": _r(r["avail"]), "demand_dhw": _r(r["demand_dhw"]),
             "demand_all": _r(r["demand_all"]), "portfolio": _r(r["portfolio_frac"], 3)}
        for c in ["coincidence_all", "coincidence_dhw", "coverage_all", "coverage_dhw"]:
            d[c] = _r(min(r[c], 1.0), 3)
        for c in metric_cols:
            d[c] = _r(r[c])
        for c in ["mmbtu", "t_co2e", "net_usd", "value_usd", "capex_usd", "payback_yr"]:
            d[c] = _r(r[c], 1) if c == "payback_yr" else _r(r[c])
        pairs.append(d)

    pf = p["portfolio_frac"]
    names = b["property_name"].fillna("")
    chelsea = ex[(names.loc[ex["k"]].str.fullmatch("FULTON").to_numpy())
                 & names.loc[ex["s"]].str.contains("85 10th Ave|111 Eighth Avenue").to_numpy()]
    summary = {
        "generated": time.strftime("%Y-%m-%d %H:%M"), "year": C.YEAR,
        "counts": {
            "buildings_screened": int(len(b)), "sources": int(b["source_kind"].notna().sum()),
            "sinks": int(b["sink_kind"].notna().sum()), "pairs_150m": int(len(p)),
            "pairs_exported": len(pairs), "cooling_towers": int(len(fetch.cooling_towers())),
            "tiers": {int(k): int(v) for k, v in p["tier"].value_counts().sort_index().items()},
        },
        "portfolio": {
            "pairs": int((pf > 0).sum()), "mmbtu": _r((p["mmbtu"] * pf).sum()),
            "t_co2e": _r((p["t_co2e"] * pf).sum()), "value_usd": _r((p["value_usd"] * pf).sum()),
            "energy_usd": _r((p["net_usd"] * pf).sum()),
            "sink_fuels": {k: int(v) for k, v in b.loc[p.loc[pf > 0, "k"], "main_fuel"].value_counts().items()},
        },
        "bookmarks": {"chelsea": [int(i) for i in sorted(chelsea.index, key=lambda i: "85 10th" not in names[ex.at[i, "s"]])]},
        "assumptions": {
            "capture_eff": C.CAPTURE_EFF, "hp_cop": C.HP_COP, "chiller_cop": C.CHILLER_COP,
            "elec_usd_per_kwh": C.ELEC_USD_PER_KWH, "ll97_elec_t_per_kwh": C.LL97_ELEC_T_PER_KWH,
            "ll97_usd_per_t": C.LL97_USD_PER_T, "hp_usd_per_kw": C.HP_USD_PER_KW,
            "pipe_usd_per_ft": C.PIPE_USD_PER_FT, "connection_ft": C.CONNECTION_FT,
            "tower_gal_per_kbtu": C.TOWER_GAL_PER_KBTU, "water_usd_per_gal": C.WATER_USD_PER_GAL,
            "storage_hours": C.STORAGE_HOURS, "max_dist_m": C.MAX_DIST_M,
            "fuels": {lab: {"t_per_kbtu": t, "usd_per_kbtu": pr, "eff": e} for lab, t, pr, e in C.FUELS.values()},
            "tier_label": C.TIER_LABEL,
        },
        "sources": {
            "LL84 annual": f"data.cityofnewyork.us/d/{C.DS_LL84}", "LL84 monthly": f"data.cityofnewyork.us/d/{C.DS_LL84_MONTHLY}",
            "Cooling towers": f"data.cityofnewyork.us/d/{C.DS_COOLING}", "Footprints": f"data.cityofnewyork.us/d/{C.DS_FOOTPRINTS}",
            "PLUTO": f"data.cityofnewyork.us/d/{C.DS_PLUTO}", "Load shapes": "NREL ComStock/ResStock 2024 (OEDI)",
        },
    }

    def dump(name, obj):
        path = C.WEB_DATA / name
        path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False))
        print(f"    wrote {path.relative_to(C.ROOT)} ({path.stat().st_size / 1e6:.1f} MB)")

    print("6/6 export")
    dump("buildings.json", buildings)
    dump("pairs.json", pairs)
    dump("grids.json", grids)
    dump("summary.json", summary)
