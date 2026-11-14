"""Dollars and carbon. The same formulas are mirrored in web/src/econ.js for the live sliders."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C
from .profiles import FUEL_EFF

PRICE = {lab: p for lab, _t, p, _e in C.FUELS.values()}
CO2 = {lab: t for lab, t, _p, _e in C.FUELS.values()}
# two oil grades share a label; use the higher-carbon / lower-price one conservatively
CO2["oil"] = max(t for lab, t, _p, _e in C.FUELS.values() if lab == "oil")
PRICE["oil"] = min(p for lab, _t, p, _e in C.FUELS.values() if lab == "oil")


def sink_factors(b: pd.DataFrame) -> pd.DataFrame:
    """Per sink: $ and tCO2e avoided per kBtu of useful heat delivered (blended over its fuel mix)."""
    useful = {lab: b[f"fuel_{lab}"] * eff for lab, eff in FUEL_EFF.items()}
    tot = sum(useful.values()).replace(0, np.nan)
    usd = sum(useful[l] / tot * PRICE[l] / FUEL_EFF[l] for l in useful)
    t = sum(useful[l] / tot * CO2[l] / FUEL_EFF[l] for l in useful)
    return pd.DataFrame({"usd_per_kbtu": usd, "t_per_kbtu": t}, index=b.index)


def pair_economics(pairs: pd.DataFrame, factors: pd.DataFrame, mode="all", hrs=0) -> pd.DataFrame:
    m = pairs[f"matched_{mode}_{hrs}"]                     # kBtu/yr useful heat delivered
    peak_kw = pairs[f"peak_{mode}_{hrs}"] / C.KBTU_PER_KWH
    f = factors.loc[pairs["k"]].set_index(pairs.index)
    hp_kwh = m / C.HP_COP / C.KBTU_PER_KWH
    fuel_usd = m * f["usd_per_kbtu"]
    elec_usd = hp_kwh * C.ELEC_USD_PER_KWH
    t_avoided = m * f["t_per_kbtu"] - hp_kwh * C.LL97_ELEC_T_PER_KWH
    captured = m * (1 - 1 / C.HP_COP)                     # waste heat no longer sent to the tower
    water_usd = captured * C.TOWER_GAL_PER_KBTU * C.WATER_USD_PER_GAL
    pipe_ft = pairs["dist_m"] * 3.28084 + C.CONNECTION_FT
    capex = pipe_ft * pairs["tier"].map(C.PIPE_USD_PER_FT) + peak_kw * C.HP_USD_PER_KW
    net = fuel_usd - elec_usd + water_usd
    ll97 = t_avoided.clip(lower=0) * C.LL97_USD_PER_T
    value = net + ll97
    return pd.DataFrame({
        "mmbtu": m / 1000, "hp_mwh": hp_kwh / 1000, "fuel_usd": fuel_usd, "elec_usd": elec_usd, "water_usd": water_usd,
        "net_usd": net, "t_co2e": t_avoided, "ll97_usd": ll97, "capex_usd": capex, "peak_kw": peak_kw,
        "value_usd": value,
        "payback_energy_yr": (capex / net.where(net > 0)).round(1),
        "payback_yr": (capex / value.where(value > 0)).round(1),
    })


def portfolio(pairs: pd.DataFrame, econ: pd.DataFrame, mode="all", hrs=0) -> pd.Series:
    """City-wide totals without double counting: each sink takes its best source, and a source's
    heat is shared out until it runs dry (annual approximation)."""
    order = econ["t_co2e"].sort_values(ascending=False).index
    left = pairs.groupby("s")["avail"].first().to_dict()
    used_sinks, frac = set(), pd.Series(0.0, index=pairs.index)
    for i in order:
        s, k = pairs.at[i, "s"], pairs.at[i, "k"]
        need = pairs.at[i, f"matched_{mode}_{hrs}"]
        viable = pairs.at[i, "tier"] <= 3 and econ.at[i, "value_usd"] > 0 and econ.at[i, "t_co2e"] > 0
        if not viable or k in used_sinks or left[s] <= 0 or need <= 0:
            continue
        f = min(1.0, left[s] / need)
        left[s] -= need * f
        used_sinks.add(k)
        frac[i] = f
    return frac
