"""Download and cache every public input. Re-running is cheap: cached files are reused."""
from __future__ import annotations

import io
import time

import pandas as pd
import requests

from . import config as C

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "heatmatch-hackathon/0.1"


def _get(url: str, params: dict | None = None, tries: int = 4) -> requests.Response:
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=180)
            r.raise_for_status()
            return r
        except requests.RequestException:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))
    raise RuntimeError("unreachable")


def socrata(ds: str, select: str | None = None, where: str | None = None, page: int = 50_000) -> pd.DataFrame:
    """Page through a Socrata dataset and return all rows as strings."""
    frames, offset = [], 0
    while True:
        params = {"$limit": page, "$offset": offset, "$order": ":id"}
        if select:
            params["$select"] = select
        if where:
            params["$where"] = where
        rows = _get(f"{C.SOCRATA}/{ds}.json", params).json()
        if not rows:
            break
        frames.append(pd.DataFrame(rows))
        if len(rows) < page:
            break
        offset += page
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def cached(name: str, fn, refresh: bool = False) -> pd.DataFrame:
    path = C.RAW / f"{name}.parquet"
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    C.RAW.mkdir(parents=True, exist_ok=True)
    t = time.time()
    df = fn()
    df.to_parquet(path, index=False)
    print(f"  fetched {name}: {len(df):,} rows in {time.time() - t:.0f}s")
    return df


LL84_COLS = ",".join([
    "property_id", "property_name", "parent_property_id", "nyc_borough_block_and_lot",
    "nyc_building_identification", "address_1", "borough", "postal_code", "primary_property_type",
    "list_of_all_property_use", "property_gfa_calculated", "year_built",
    "natural_gas_use_kbtu", "electricity_use_grid_purchase", "district_steam_use_kbtu",
    "fuel_oil_2_use_kbtu", "fuel_oil_4_use_kbtu", "site_eui_kbtu_ft", "data_center_it_energy",
    "data_center_pue", "default_values", "estimated_data_flag", "latitude", "longitude",
])


def ll84(year: int = C.YEAR, refresh=False) -> pd.DataFrame:
    return cached(f"ll84_{year}", lambda: socrata(C.DS_LL84, LL84_COLS, f"report_year={year}"), refresh)


def ll84_monthly(year: int = C.YEAR, refresh=False) -> pd.DataFrame:
    return cached(f"ll84_monthly_{year}", lambda: socrata(
        C.DS_LL84_MONTHLY, "property_id,month,natural_gas_use_kbtu,electricity_use_kbtu",
        f"calendar_year='{year}'"), refresh)


def cooling_towers(refresh=False) -> pd.DataFrame:
    return cached("cooling_towers", lambda: socrata(
        C.DS_COOLING, "bin,bbl,system_id,activeequipment,latitude,longitude"), refresh)


def _in_chunks(ds: str, field: str, values, select: str, chunk: int = 250) -> pd.DataFrame:
    values = sorted({str(v) for v in values if v})
    frames = []
    for i in range(0, len(values), chunk):
        part = ",".join(f"'{v}'" for v in values[i:i + chunk])
        frames.append(socrata(ds, select, f"{field} in ({part})"))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def footprints(bins, refresh=False) -> pd.DataFrame:
    return cached("footprints", lambda: _in_chunks(
        C.DS_FOOTPRINTS, "bin", bins, "bin,base_bbl,height_roof,ground_elevation,the_geom"), refresh)


def pluto(bbls, refresh=False) -> pd.DataFrame:
    return cached("pluto", lambda: _in_chunks(
        C.DS_PLUTO, "bbl", bbls, "bbl,ownername,bldgclass,numfloors,unitsres,address"), refresh)


# --- NREL hourly shapes -----------------------------------------------------

def _reduce_nrel(csv_bytes: bytes) -> pd.DataFrame:
    """15-min aggregate CSV -> 8760 hourly kWh columns: cooling, heating, dhw."""
    df = pd.read_csv(io.BytesIO(csv_bytes))
    ts = pd.to_datetime(df["timestamp"]) - pd.Timedelta(minutes=1)  # timestamps mark interval end
    cols = [c for c in df.columns if c.startswith("out.") and c.endswith(".kwh") and ".total." not in c]

    def pick(*keys, exclude=()):
        sel = [c for c in cols if any(k in c for k in keys) and not any(x in c for x in exclude)]
        return df[sel].sum(axis=1) if sel else pd.Series(0.0, index=df.index)

    out = pd.DataFrame({
        "cooling": pick(".cooling.", exclude=("fans", "pumps")),
        "heating": pick(".heating.", "heating_hp_bkup", exclude=("fans", "pumps", "water")),
        "dhw": pick("water_systems", "hot_water"),
    })
    out.index = ts
    hourly = out.resample("h").sum()
    hourly = hourly[~((hourly.index.month == 2) & (hourly.index.day == 29))]
    return hourly.iloc[:8760].reset_index(drop=True)


def nrel_shapes(refresh=False) -> dict[str, pd.DataFrame]:
    C.SHAPES.mkdir(parents=True, exist_ok=True)
    out = {}
    jobs = [(t, C.COMSTOCK_COUNTY.format(btype=t)) for t in C.COMSTOCK_TYPES]
    jobs += [("multifamily", C.RESSTOCK_STATE.format(btype=t)) for t in C.RESSTOCK_TYPES]
    for name, url in jobs:
        path = C.SHAPES / f"{name}.csv"
        if not path.exists() or refresh:
            t = time.time()
            _reduce_nrel(_get(url).content).to_csv(path, index=False)
            print(f"  shape {name} in {time.time() - t:.0f}s")
        out[name] = pd.read_csv(path)
    return out


if __name__ == "__main__":
    nrel_shapes()
    ll84()
    ll84_monthly()
    cooling_towers()
