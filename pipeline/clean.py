"""Turn raw LL84 + cooling-tower rows into one tidy building table with roles."""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from . import config as C

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
RINK = re.compile(r"\b(?:rink|ice|skat)", re.I)
DC_USE = re.compile(r"Data Center \(([\d.]+)\)")


def num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def split_ids(v, width: int) -> list[str]:
    """LL84 packs several BINs/BBLs in one cell ('1234567;1234568'). Return the valid ones."""
    if not isinstance(v, str):
        return []
    out = [t for t in re.split(r"[^0-9]+", v) if len(t) == width and not set(t) <= {"0"}]
    # BINs like 1000000 / 3000000 are placeholder "million BINs"
    return [t for t in out if not (width == 7 and t[1:] == "000000")]


def monthly_gas(monthly: pd.DataFrame) -> pd.DataFrame:
    """Long monthly rows -> one row per property with gas_1..gas_12 (kBtu)."""
    m = monthly.copy()
    m["mo"] = m["month"].str.split("-").str[-1].map({k: i + 1 for i, k in enumerate(MONTHS)})
    m["gas"] = num(m["natural_gas_use_kbtu"])
    wide = m.dropna(subset=["mo"]).groupby(["property_id", "mo"])["gas"].sum(min_count=1).unstack("mo")
    wide = wide.reindex(columns=range(1, 13))
    wide.columns = [f"gas_{i}" for i in range(1, 13)]
    return wide.reset_index()


def drop_children(b: pd.DataFrame) -> pd.DataFrame:
    """LL84 reports campuses as a parent row plus child rows that often share meters.
    Keep the parent (it carries every BIN) and drop its children."""
    parents = set(b["parent_property_id"]) & set(b["property_id"])
    is_child = b["parent_property_id"].isin(parents) & (b["parent_property_id"] != b["property_id"])
    return b[~is_child]


def dedupe_bins(b: pd.DataFrame) -> pd.DataFrame:
    """Some buildings are benchmarked twice (owner + tenant, or two filers). Keep the biggest
    record for any set of overlapping BINs."""
    order = (b["elec"] + b["heat_fuel"]).sort_values(ascending=False).index
    seen, keep = set(), []
    for i in order:
        bins = set(b.at[i, "bins"])
        if bins & seen:
            continue
        seen |= bins
        keep.append(i)
    return b.loc[sorted(keep)]


def buildings(ll84: pd.DataFrame, monthly: pd.DataFrame, towers: pd.DataFrame) -> pd.DataFrame:
    b = drop_children(ll84.drop_duplicates("property_id")).copy()
    for c in ["latitude", "longitude", "electricity_use_grid_purchase", "property_gfa_calculated", *C.FUELS]:
        b[c] = num(b[c])
    b = b.dropna(subset=["latitude", "longitude"])
    b = b[b["latitude"].between(40.4, 41.0) & b["longitude"].between(-74.3, -73.6)]
    b["elec"] = b["electricity_use_grid_purchase"].fillna(0)
    b["gfa"] = b["property_gfa_calculated"].fillna(0)
    for col, (label, *_rest) in C.FUELS.items():
        b[f"fuel_{label}"] = b.get(f"fuel_{label}", 0) + b[col].fillna(0).clip(lower=0)
    fuel_cols = sorted({f"fuel_{v[0]}" for v in C.FUELS.values()})
    b["heat_fuel"] = b[fuel_cols].sum(axis=1)
    b["main_fuel"] = b[fuel_cols].idxmax(axis=1).str.removeprefix("fuel_").where(b["heat_fuel"] > 0)

    b["bins"] = b["nyc_building_identification"].map(lambda v: split_ids(v, 7))
    b["bbls"] = b["nyc_borough_block_and_lot"].map(lambda v: split_ids(v, 10))
    b["bbl"] = b["bbls"].map(lambda x: x[0] if x else None)
    b["block"] = b["bbl"].str[:6]
    b["parent"] = b["parent_property_id"].where(~b["parent_property_id"].fillna("").str.startswith("Not"))

    # cooling towers, matched by BIN first, then by BBL
    t = towers.copy()
    t["n"] = num(t["activeequipment"]).fillna(1).clip(lower=1)
    by_bin = t.groupby("bin")["n"].sum().to_dict()
    by_bbl = t.groupby("bbl")["n"].sum().to_dict()
    b["towers"] = [
        int(sum(by_bin.get(x, 0) for x in bins) or sum(by_bbl.get(x, 0) for x in bbls))
        for bins, bbls in zip(b["bins"], b["bbls"])
    ]

    # --- data-center track: every property with a data center, standalone or a floor inside a tower
    pt = b["primary_property_type"].fillna("")
    dc_ft2 = np.maximum(
        b["list_of_all_property_use"].fillna("").map(lambda s: sum(float(x) for x in DC_USE.findall(s))),
        num(b["data_center_gross_floor_area"]).fillna(0),
    )
    is_dc_type = pt == "Data Center"
    a = (dc_ft2 / b["gfa"].replace(0, np.nan)).clip(0, 1).fillna(0)
    k = C.DATACENTER_INTENSITY
    share = (k * a / (k * a + (1 - a))).fillna(0)
    b["dc_elec_share"] = np.where(is_dc_type, np.maximum(share, 0.8), share)
    b["dc_ft2"] = dc_ft2
    # Measured: LL84's data-center IT site energy (kBtu). Essentially all IT power becomes heat, and the
    # chiller adds its own work on top. Estimated: the data center's share of building electricity.
    it = num(b["data_center_it_site_energy"]).where(lambda x: x > 0)
    b["dc_measured"] = it.notna()
    est = b["elec"] * b["dc_elec_share"] * C.DATACENTER_HEAT_SHARE
    b["dc_heat_kbtu"] = np.where(b["dc_measured"], it * C.DC_IT_HEAT_FACTOR, est)
    has_dc = is_dc_type | (dc_ft2 >= C.DC_MIN_FT2) | b["dc_measured"]
    b["dc_source"] = has_dc & (b["dc_heat_kbtu"] >= C.DC_MIN_HEAT_KBTU)

    # --- commercial track: refrigeration, hospitals/labs, and buildings with a registered cooling tower.
    # Anything that qualifies as a data center belongs to the data-center track only, so the two tabs
    # never show the same building as a heat source.
    src = pt.map(C.SOURCE_24_7)
    rink_ok = (pt != "Other - Recreation") | b["property_name"].fillna("").str.contains(RINK)
    src = src.where(rink_ok)
    src = src.fillna(pt.map(C.SOURCE_IF_TOWER).where(b["towers"] > 0))
    b["source_kind"] = src.where((b["elec"] > 0) & ~is_dc_type & ~b["dc_source"])
    b["sink_kind"] = pt.map(C.SINK_TYPES).where(b["heat_fuel"] >= C.SINK_MIN_HEAT_KBTU)
    b = b[b["dc_source"] | b["source_kind"].notna() | b["sink_kind"].notna()].copy()
    b = dedupe_bins(b)

    # monthly gas, kept only when it reconciles with the annual gas total
    b = b.merge(monthly_gas(monthly), on="property_id", how="left")
    g = b[[f"gas_{i}" for i in range(1, 13)]].to_numpy(dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        b["gas_monthly_ok"] = np.isfinite(g).all(1) & (np.abs(g.sum(1) / b["fuel_gas"] - 1) < 0.25) & (b["main_fuel"] == "gas")
    return b.reset_index(drop=True)
