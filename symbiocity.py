"""HeatMatch pipeline: python symbiocity.py [--refresh] [--no-export]

fetch -> clean -> geometry -> candidate pairs -> hourly coincidence -> economics -> web JSON
"""
from __future__ import annotations

import argparse
import re
import time

import pandas as pd

from pipeline import clean, economics, fetch, match
from pipeline import config as C


def norm_owner(s) -> str | None:
    if not isinstance(s, str) or not s.strip():
        return None
    s = re.sub(r"[^A-Z0-9 ]", "", s.upper())
    s = re.sub(r"\b(LLC|INC|CORP|CO|LP|L P|THE|ASSOCIATES|COMPANY|CORPORATION)\b", "", s)
    s = " ".join(s.split())
    return None if s in {"", "UNAVAILABLE OWNER", "NA"} else s


def run(refresh=False):
    t0 = time.time()
    print("1/6 fetching public data (cached in data/raw)")
    shapes = fetch.nrel_shapes()
    b = clean.buildings(fetch.ll84(refresh=refresh), fetch.ll84_monthly(refresh=refresh), fetch.cooling_towers(refresh=refresh))
    print(f"    {len(b):,} candidate buildings: {b['source_kind'].notna().sum():,} sources, {b['sink_kind'].notna().sum():,} sinks")

    print("2/6 footprints + owners")
    fp = fetch.footprints(b["bins"].explode().dropna().unique(), refresh=refresh)
    owners = fetch.pluto(b["bbls"].explode().dropna().unique(), refresh=refresh)
    owners["bbl"] = owners["bbl"].astype(str).str.split(".").str[0]  # PLUTO returns '1000080044.00000000'
    own = owners.drop_duplicates("bbl").set_index("bbl")
    b["owner"] = b["bbl"].map(own["ownername"])
    b["owner_key"] = b["owner"].map(norm_owner)
    units = pd.to_numeric(own["unitsres"], errors="coerce").fillna(0).to_dict()
    b["units"] = b["bbls"].map(lambda xs: sum(units.get(x, 0) for x in xs) or None)  # campuses span lots
    b = match.attach_geometry(b, fp)
    print(f"    footprints found for {b['has_footprint'].mean():.0%} of buildings")

    print("3/6 candidate pairs")
    p = match.candidate_pairs(b)
    same_owner = (b.loc[p["s"], "owner_key"].to_numpy() == b.loc[p["k"], "owner_key"].to_numpy()) & b.loc[p["s"], "owner_key"].notna().to_numpy()
    p = p[~same_owner].reset_index(drop=True)
    print(f"    {len(p):,} pairs within {C.MAX_DIST_M} m  | tiers: {p['tier'].value_counts().sort_index().to_dict()}")

    print("4/6 hourly coincidence (8760 h, storage scenarios)")
    p, src_prof, sink_prof = match.score_pairs(b, p)

    print("5/6 economics")
    fac = economics.sink_factors(b)
    econ = economics.pair_economics(p, fac)
    p = p.join(econ)
    p["portfolio_frac"] = economics.portfolio(p, econ)
    print(f"    done in {time.time() - t0:.0f}s")
    return b, p, src_prof, sink_prof, fac


def report(b, p):
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    v = p.assign(src=b.loc[p["s"], "property_name"].str[:28].to_numpy(), src_kind=b.loc[p["s"], "source_kind"].to_numpy(),
                 sink=b.loc[p["k"], "property_name"].str[:28].to_numpy())
    cols = ["src", "src_kind", "sink", "dist_m", "tier", "coincidence_all", "coincidence_dhw", "mmbtu", "t_co2e", "net_usd", "value_usd", "capex_usd", "payback_yr"]
    print("\nTop 20 by tCO2e avoided (tier <= 3):")
    print(v[v["tier"] <= 3].sort_values("t_co2e", ascending=False)[cols].head(20).round(2).to_string())
    print("\nCoincidence by source kind (median, mode=all):")
    print(v.groupby("src_kind")[["coincidence_all", "coincidence_dhw"]].median().round(2))
    pf = p["portfolio_frac"]
    print(f"\nCity portfolio: {int((pf > 0).sum())} pairs, {(p['mmbtu'] * pf).sum():,.0f} MMBtu/yr, "
          f"{(p['t_co2e'] * pf).sum():,.0f} tCO2e/yr, ${(p['value_usd'] * pf).sum():,.0f}/yr value "
          f"(energy-only ${(p['net_usd'] * pf).sum():,.0f}/yr)")
    print("Main fuel of portfolio sinks:", b.loc[p.loc[pf > 0, 'k'], 'main_fuel'].value_counts().to_dict())
    chel = v[v["src"].str.contains("85 10th Ave", na=False) & v["sink"].str.contains("FULTON", na=False)]
    print("\nChelsea check (85 10th Ave -> Fulton Houses):")
    print(chel[cols].round(2).to_string() if len(chel) else "    not found")
    if len(chel):
        rank = (v[v["tier"] <= 3]["t_co2e"] > chel["t_co2e"].max()).sum() + 1
        print(f"    rank by tCO2e among tier<=3 pairs: #{rank}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download Socrata data")
    ap.add_argument("--no-export", action="store_true")
    args = ap.parse_args()
    b, p, src_prof, sink_prof, fac = run(args.refresh)
    report(b, p)
    if not args.no_export:
        from pipeline import export
        export.write(b, p, src_prof, sink_prof, fac)
