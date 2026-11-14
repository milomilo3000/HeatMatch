"""What does each pipe route actually have to cross?

The route is the shortest wall-to-wall line between two buildings. We intersect it with:
  - the NYC street centerline (CSCL): which public streets it crosses, and how wide each is
  - DOT protected streets: blocks resurfaced in the last five years (opening one costs more:
    DOT requires wider restoration)
  - MTA subway service lines: a subway (or elevated line) runs along the street being crossed
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import shapely

from . import config as C
from . import fetch
from .match import project


def _load(df: pd.DataFrame) -> np.ndarray:
    return project(shapely.from_wkb(df["wkb"].to_numpy()))


class Streets:
    def __init__(self, refresh: bool = False):
        st = fetch.streets(refresh)
        self.geom = _load(st)
        self.name = (st["full_street_name"].fillna("unnamed street").str.replace(r"\s+", " ", regex=True)
                     .str.strip().str.title().to_numpy())
        w = pd.to_numeric(st["streetwidth"], errors="coerce")
        self.width = w.where(w > 0, C.DEFAULT_STREET_FT).to_numpy()
        self.highway = st["rw_type"].astype(str).isin(C.HIGHWAY_TYPES).to_numpy()
        self.tree = shapely.STRtree(self.geom)

        pr = fetch.protected_streets(refresh)
        until = pd.to_datetime(pr["dateprot_1"], errors="coerce")
        self.protected = shapely.STRtree(_load(pr[until > pd.Timestamp.now()]))
        self.subway = shapely.STRtree(_load(fetch.subway_lines(refresh)))

    def analyze(self, geom_a: np.ndarray, geom_b: np.ndarray) -> pd.DataFrame:
        """Per pair: streets crossed (count, names, total roadway width in ft) and flags."""
        lines = shapely.shortest_line(geom_a, geom_b)
        n = len(lines)
        li, si = self.tree.query(lines, predicate="intersects")
        hits = pd.DataFrame({"pair": li, "name": self.name[si], "width": self.width[si], "hwy": self.highway[si]})
        # a divided avenue has one centerline per carriageway: count the street once, add up to two widths
        hits = hits.sort_values("width", ascending=False).groupby(["pair", "name"], sort=False).head(2)
        per_street = hits.groupby(["pair", "name"], sort=False).agg(width=("width", "sum"), hwy=("hwy", "any")).reset_index()
        per_street = per_street.sort_values("width", ascending=False)
        g = per_street.groupby("pair")
        out = pd.DataFrame({
            "n_cross": g.size(), "street_ft": g["width"].sum(), "highway": g["hwy"].any(),
            "cross_names": g["name"].agg(list),
        }).reindex(range(n))
        out["n_cross"] = out["n_cross"].fillna(0).astype(int)
        out["street_ft"] = out["street_ft"].fillna(0.0)
        out["highway"] = out["highway"].fillna(False).astype(bool)
        out["cross_names"] = out["cross_names"].map(lambda v: v if isinstance(v, list) else [])
        for col, tree in (("protected", self.protected), ("subway", self.subway)):
            flag = np.zeros(n, dtype=bool)
            flag[np.unique(tree.query(lines, predicate="intersects")[0])] = True
            out[col] = flag & (out["n_cross"].to_numpy() > 0)
        return out
