"""Pair heat sources with nearby heat sinks, then score how well their hours line up."""
from __future__ import annotations

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely.geometry import shape as geo_shape

from . import config as C
from . import profiles as P

FT_PER_M = 3.28084
_to_ft = Transformer.from_crs("EPSG:4326", "EPSG:2263", always_xy=True)


def project(geoms):
    return shapely.transform(geoms, lambda xy: np.column_stack(_to_ft.transform(xy[:, 0], xy[:, 1])))


def attach_geometry(b: pd.DataFrame, fp: pd.DataFrame) -> pd.DataFrame:
    """Union each building's footprint polygons (by BIN). Falls back to a 10 m circle at the LL84 point."""
    fp = fp.dropna(subset=["the_geom"]).copy()
    fp["geom"] = fp["the_geom"].map(geo_shape)
    fp["height_roof"] = pd.to_numeric(fp["height_roof"], errors="coerce")
    by_bin = fp.groupby("bin").agg(geom=("geom", lambda g: shapely.union_all(list(g))),
                                   height=("height_roof", "max")).to_dict("index")
    geoms, heights, has_fp = [], [], []
    for bins, lon, lat in zip(b["bins"], b["longitude"], b["latitude"]):
        parts = [by_bin[x] for x in bins if x in by_bin]
        if parts:
            geoms.append(shapely.union_all([p["geom"] for p in parts]))
            heights.append(np.nanmax([p["height"] for p in parts] + [0]))
            has_fp.append(True)
        else:
            geoms.append(shapely.Point(lon, lat).buffer(0.0001))
            heights.append(30.0)
            has_fp.append(False)
    b = b.copy()
    b["geom_ll"] = geoms
    b["geom_ft"] = project(np.array(geoms, dtype=object))
    b["height_ft"] = heights
    b["has_footprint"] = has_fp
    return b


def candidate_pairs(b: pd.DataFrame) -> pd.DataFrame:
    """Edge-to-edge distance between every source and sink within MAX_DIST_M."""
    src = b.index[b["source_kind"].notna()].to_numpy()
    snk = b.index[b["sink_kind"].notna()].to_numpy()
    tree = shapely.STRtree(b.loc[snk, "geom_ft"].to_numpy())
    qi, ti = tree.query(b.loc[src, "geom_ft"].to_numpy(), predicate="dwithin", distance=C.MAX_DIST_M * FT_PER_M)
    p = pd.DataFrame({"s": src[qi], "k": snk[ti]})
    p = p[p["s"] != p["k"]]
    p["dist_m"] = shapely.distance(b.loc[p["s"], "geom_ft"].to_numpy(), b.loc[p["k"], "geom_ft"].to_numpy()) / FT_PER_M

    # exclusions: same campus / same tax lot / same owner
    def overlap(a, c):
        return bool(set(a) & set(c))
    same_parent = [(ps is not None and ps == pk) or ps == b.at[k, "property_id"] or pk == b.at[s, "property_id"]
                   for s, k, ps, pk in zip(p["s"], p["k"], b.loc[p["s"], "parent"], b.loc[p["k"], "parent"])]
    same_lot = [overlap(b.at[s, "bbls"], b.at[k, "bbls"]) for s, k in zip(p["s"], p["k"])]
    p = p[~np.array(same_parent) & ~np.array(same_lot)]

    blocks = b["bbls"].map(lambda x: {v[:6] for v in x})
    same_block = np.array([bool(blocks[s] & blocks[k]) for s, k in zip(p["s"], p["k"])], dtype=bool)
    d = p["dist_m"].to_numpy()
    p["tier"] = np.select([d <= C.SHARED_WALL_M, same_block, d <= C.ONE_STREET_M], [1, 2, 3], 4)
    return p.reset_index(drop=True)


def simulate(avail: np.ndarray, demand: np.ndarray, cap: np.ndarray | float) -> np.ndarray:
    """Hourly matched heat for many pairs at once (rows = pairs), with a thermal store of size cap."""
    direct = np.minimum(avail, demand)
    if np.all(np.asarray(cap) == 0):
        return direct
    surplus, deficit = avail - direct, demand - direct
    cap = np.broadcast_to(np.asarray(cap, dtype=float), (avail.shape[0],))
    level = np.zeros(avail.shape[0])
    out = direct.copy()
    for h in range(avail.shape[1]):
        dis = np.minimum(level, deficit[:, h])
        out[:, h] += dis
        level = np.minimum(level - dis + surplus[:, h], cap)
    return out


def score_pairs(b: pd.DataFrame, p: pd.DataFrame, batch: int = 400):
    """Coincidence metrics for each pair. Returns (pairs with metrics, source profiles, sink profiles)."""
    src_prof = {i: P.deliverable(P.source_profile(b.loc[i])) for i in p["s"].unique()}
    sink_prof = {i: P.sink_profile(b.loc[i]) for i in p["k"].unique()}
    rows = []
    for start in range(0, len(p), batch):
        chunk = p.iloc[start:start + batch]
        A = np.stack([src_prof[s] for s in chunk["s"]])
        DH = np.stack([sink_prof[k][0] for k in chunk["k"]])
        DS = np.stack([sink_prof[k][1] for k in chunk["k"]])
        res = {}
        for mode, D in (("dhw", DH), ("all", DH + DS)):
            for hrs in C.STORAGE_HOURS:
                M = simulate(A, D, hrs * D.mean(axis=1))
                res[f"matched_{mode}_{hrs}"] = M.sum(1)
                res[f"peak_{mode}_{hrs}"] = M.max(1)
        sumA, sumDH, sumD = A.sum(1), DH.sum(1), (DH + DS).sum(1)
        for j, idx in enumerate(chunk.index):
            row = {"pair": idx, "avail": sumA[j], "demand_dhw": sumDH[j], "demand_all": sumD[j]}
            row.update({k: v[j] for k, v in res.items()})
            rows.append(row)
    m = pd.DataFrame(rows).set_index("pair")
    out = p.join(m)
    for mode in ("dhw", "all"):
        out[f"coincidence_{mode}"] = out[f"matched_{mode}_0"] / np.minimum(out["avail"], out[f"demand_{mode}"]).clip(lower=1)
        out[f"coverage_{mode}"] = out[f"matched_{mode}_0"] / out[f"demand_{mode}"].clip(lower=1)
    return out, src_prof, sink_prof
