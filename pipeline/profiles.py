"""8760-hour heat profiles.

Magnitudes come from each building's own LL84 numbers. Hour-by-hour shapes come from NREL
ComStock (Manhattan) / ResStock (NY multifamily) end-use load profiles.

  source(h): heat a building rejects (cooling towers, IT, refrigeration), kBtu/h
  sink(h):   useful heat a building makes today from gas/oil/steam, split into DHW + space, kBtu/h
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
import pandas as pd

from . import config as C

HOURS = pd.date_range("2018-01-01", periods=8760, freq="h")  # NREL weather year, no leap day
MONTH = HOURS.month.to_numpy() - 1
HOUR = HOURS.hour.to_numpy()
GRID_IDX = MONTH * 24 + HOUR
GRID_COUNT = np.bincount(GRID_IDX, minlength=288)


def grid(x: np.ndarray) -> np.ndarray:
    """8760 -> 12x24 mean by (month, hour of day)."""
    return (np.bincount(GRID_IDX, weights=x, minlength=288) / GRID_COUNT).reshape(12, 24)


def _within_month(x: np.ndarray) -> np.ndarray:
    """Weights that sum to 1 inside each month (flat if the month is empty)."""
    tot = np.bincount(MONTH, weights=x, minlength=12)
    cnt = np.bincount(MONTH, minlength=12)
    flat = 1.0 / cnt[MONTH]
    with np.errstate(invalid="ignore", divide="ignore"):
        w = np.where(tot[MONTH] > 0, x / tot[MONTH], flat)
    return w


@lru_cache(maxsize=None)
def shape(name: str):
    df = pd.read_csv(C.SHAPES / f"{name}.csv").clip(lower=0)
    out = {}
    for col in ("cooling", "heating", "dhw"):
        x = df[col].to_numpy(dtype=float)
        out[col] = {
            "w": _within_month(x),                                     # hour weight within month
            "m": np.bincount(MONTH, weights=x, minlength=12) / max(x.sum(), 1e-9),  # month share of year
            "total": x.sum(),
        }
    return out


FUEL_EFF = {lab: eff for lab, _t, _p, eff in C.FUELS.values()}
SINK_SHAPE = {
    "residential": "multifamily", "hotel": "largehotel", "office": "largeoffice",
    "school": "secondaryschool", "hospital": "hospital",
}
SOURCE_SHAPE = {"office": "largeoffice", "hospital": "hospital"}


def sink_profile(b) -> tuple[np.ndarray, np.ndarray]:
    """Useful heat demand (kBtu/h) met by fossil fuel today: (dhw, space)."""
    s = shape(SINK_SHAPE[b["sink_kind"]])
    useful = sum(b[f"fuel_{lab}"] * eff for lab, eff in FUEL_EFF.items())
    dhw_share = s["dhw"]["total"] / (s["dhw"]["total"] + s["heating"]["total"])

    if b.get("gas_monthly_ok") and b["fuel_gas"] > 0:
        # Measured monthly gas: the summer floor is hot water, the winter excess is space heat.
        g = np.array([b[f"gas_{i}"] for i in range(1, 13)], dtype=float).clip(min=0)
        u = g / g.sum() * useful
        base_m = int(np.argmin(u[5:8])) + 5                       # quietest of Jun/Jul/Aug
        dhw_m = u[base_m] * s["dhw"]["m"] / s["dhw"]["m"][base_m]  # winter inlet water is colder
        dhw_m = np.minimum(dhw_m, u)
        space_m = u - dhw_m
    else:
        dhw_m = useful * dhw_share * s["dhw"]["m"]
        space_m = useful * (1 - dhw_share) * s["heating"]["m"]

    return dhw_m[MONTH] * s["dhw"]["w"], space_m[MONTH] * s["heating"]["w"]


def source_profile(b, track: str = "commercial") -> np.ndarray:
    """Heat rejected to the sky today (kBtu/h).

    dc:         the data center's IT heat (measured or estimated, see clean.py), flat around the clock.
    commercial: refrigeration / hospital / cooling-tower heat, excluding any data-center floor.
    """
    if track == "dc":
        return np.full(8760, float(b["dc_heat_kbtu"]) / 8760)

    kind, elec = b["source_kind"], float(b["elec"])
    dc_share = float(b.get("dc_elec_share", 0) or 0)
    diurnal = 1 + 0.08 * np.sin((HOUR - 9) / 24 * 2 * np.pi)       # small daytime bump
    diurnal = diurnal / diurnal.sum()
    heat = np.zeros(8760)
    if kind == "refrigeration":
        heat += elec * C.REFRIG_ELEC_SHARE * (1 + C.REFRIG_COP) * diurnal
    if kind in SOURCE_SHAPE:
        s = shape(SOURCE_SHAPE[kind])["cooling"]
        cool_elec = elec * (1 - dc_share) * C.COOLING_ELEC_SHARE[kind]
        heat += cool_elec * (1 + C.CHILLER_COP) * s["m"][MONTH] * s["w"]
    return heat


def deliverable(source_heat: np.ndarray) -> np.ndarray:
    """Heat a water-source heat pump can deliver from captured waste heat.
    Delivered = captured + compressor work, and captured = delivered * (1 - 1/COP)."""
    return C.CAPTURE_EFF * source_heat / (1 - 1 / C.HP_COP)
