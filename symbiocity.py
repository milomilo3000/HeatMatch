"""HeatMatch pipeline: python symbiocity.py [--refresh] [--no-export]

fetch -> clean -> geometry -> candidate pairs -> hourly coincidence -> economics -> web JSON
"""
from __future__ import annotations

import argparse
import re
import time

import pandas as pd

from pipeline import clean, economics, fetch, match, streets
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
    print(f"    {len(b):,} candidate buildings: {b['dc_source'].sum():,} data centers "
          f"({(b['dc_source'] & b['dc_measured']).sum()} with measured IT load), "
          f"{b['source_kind'].notna().sum():,} commercial sources, {b['sink_kind'].notna().sum():,} heat users")

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

    # Two tracks share the same heat users but have different sources and heat models.
    masks = {"dc": b["dc_source"], "commercial": b["source_kind"].notna()}
    print("    loading street network (centerlines, protected streets, subway lines)")
    net = streets.Streets(refresh)
    fac = economics.sink_factors(b)
    parts, src_prof, sink_prof = [], {}, {}
    for track, mask in masks.items():
        print(f"3/6 [{track}] candidate pairs")
        p = match.candidate_pairs(b, mask, net)
        same_owner = (b.loc[p["s"], "owner_key"].to_numpy() == b.loc[p["k"], "owner_key"].to_numpy()) & b.loc[p["s"], "owner_key"].notna().to_numpy()
        # hospitals next to hospitals are almost always one medical campus on a shared central plant
        campus = (b.loc[p["s"], "source_kind"].to_numpy() == "hospital") & (b.loc[p["k"], "sink_kind"].to_numpy() == "hospital")
        p = p[~same_owner & ~campus].reset_index(drop=True)
        print(f"    {len(p):,} pairs within {C.MAX_DIST_M} m  | tiers: {p['tier'].value_counts().sort_index().to_dict()}"
              f" | cross a protected street: {int(p['protected'].sum()):,}, a subway street: {int(p['subway'].sum()):,}")
        print(f"4/6 [{track}] hourly coincidence (8760 h, storage scenarios)")
        p, src_prof[track], kp = match.score_pairs(b, p, track)
        sink_prof.update(kp)
        print(f"5/6 [{track}] economics")
        econ = economics.pair_economics(p, fac)
        p = p.join(econ)
        p["portfolio_frac"] = economics.portfolio(p, econ)
        p["track"] = track
        parts.append(p)
    p = pd.concat(parts, ignore_index=True)
    print(f"    done in {time.time() - t0:.0f}s")
    return b, p, src_prof, sink_prof, fac


def report(b, p):
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    v = p.assign(src=b.loc[p["s"], "property_name"].str[:28].to_numpy(), src_kind=b.loc[p["s"], "source_kind"].to_numpy(),
                 measured=b.loc[p["s"], "dc_measured"].to_numpy(), sink=b.loc[p["k"], "property_name"].str[:28].to_numpy(),
                 sink_type=b.loc[p["k"], "sink_kind"].to_numpy())
    cols = ["src", "sink", "sink_type", "dist_m", "tier", "coincidence_all", "mmbtu", "t_co2e", "value_usd", "payback_yr"]
    for track in ("dc", "commercial"):
        t = v[v["track"] == track]
        pf = t["portfolio_frac"]
        print(f"\n=== {track}: {len(t):,} pairs, {t['s'].nunique():,} sources, {t['k'].nunique():,} heat users ===")
        print(t[t["tier"] <= 3].sort_values("t_co2e", ascending=False)[cols + (["measured"] if track == "dc" else ["src_kind"])].head(12).round(2).to_string())
        print(f"Portfolio: {int((pf > 0).sum())} pairs, {(t['mmbtu'] * pf).sum():,.0f} MMBtu/yr, "
              f"{(t['t_co2e'] * pf).sum():,.0f} tCO2e/yr, ${(t['value_usd'] * pf).sum():,.0f}/yr value "
              f"(energy-only ${(t['net_usd'] * pf).sum():,.0f}/yr)")
        print("Heat-user types:", t["sink_type"].value_counts().to_dict())
    chel = v[(v["track"] == "dc") & v["src"].str.contains("85 10th Ave|111 Eighth", na=False) & v["sink"].str.fullmatch("FULTON", na=False)]
    print("\nChelsea check (data-center track, -> Fulton Houses):")
    print(chel[cols + ["measured"]].round(2).to_string() if len(chel) else "    not found")


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
