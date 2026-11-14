# HeatMatch NYC

Finds pairs of neighboring NYC buildings where one throws heat away (cooling towers, data
centers, refrigeration) and the other burns gas, oil or Con Ed steam for heat and hot water.
It checks that the two are close **and** that the heat is available in the same hours it is
needed, sizes the savings, and drafts a proposal to both owners.

HackPrinceton, sustainability track. Screening tool, not an engineering design.

## Quick start

```bash
python3.15 -m venv .venv && .venv/bin/pip install pandas numpy shapely pyproj requests pyarrow fastapi uvicorn anthropic pytest
.venv/bin/python symbiocity.py            # ~2 min first run (downloads + caches), ~25 s after
.venv/bin/python -m pytest -q tests

cd web && npm install && npm run dev      # http://localhost:5173

# optional: live AI proposal drafting (otherwise the app shows a template letter)
export ANTHROPIC_API_KEY=...
.venv/bin/uvicorn api.proposal:app --port 8000
```

Demo keys: **c** flies to the Chelsea / Fulton Houses site, **o** zooms back out to the city.

## Data (all free and public)

| Input | Source |
|---|---|
| Annual energy per building (gas, steam, oil, electricity, use types, BIN/BBL, lat/lon) | NYC Open Data LL84 benchmarking `5zyy-y8am` (2024) |
| Monthly gas per building | LL84 monthly `fvp3-gcb2` (gas only: electricity is blank for 2021–2024) |
| Heat-rejection sites | DOHMH/DOB cooling tower registry `y4fw-iqfr` (5,921 systems) |
| 3D geometry | Building footprints `5zhs-2jue` (polygon + roof height) |
| Owner names | PLUTO `64uk-42ks` |
| Hourly load shapes | NREL ComStock (Manhattan county) and ResStock (NY multifamily) 2024, OEDI |
| Basemap | OpenFreeMap (OpenStreetMap), no API key |

## Method

1. **Roles.** Heat *sources* are data centers (including office towers with a data-center floor),
   supermarkets/refrigerated warehouses, hospitals/labs, and any office/hotel/college with a
   registered cooling tower. Heat *sinks* are multifamily, hotels, dorms, senior housing and gyms
   buying at least 1M kBtu/yr of gas, oil or district steam.
2. **Distance.** The edge-to-edge distance between footprints, in NY State Plane, with a 150 m cap. Each pair gets a tier:
   - shared wall (<3 m)
   - same tax block (private easement only)
   - across one street (needs a NYC DOT revocable consent)
   - further

   Pairs on the same campus, the same lot, or with the same owner are excluded.
3. **Timing.** Each building gets an 8,760-hour profile. A sink's summer gas floor is hot water,
   and the winter excess is space heat; both are shaped by NREL hourly profiles. Source heat comes
   from electricity use (IT load, refrigeration, chiller condenser heat) and is shaped by the same
   profiles. Matched heat each hour is `min(available, demand)`, with an optional 4 h or 12 h
   thermal tank. *Coincidence* is the share of the smaller side that lines up hour by hour.
4. **Economics.** A water-source heat pump (COP 3.5) lifts the waste heat. Annual value is made up of:
   - the fuel no longer bought
   - minus the heat-pump electricity
   - plus cooling-tower water saved
   - plus LL97 penalty exposure avoided ($268/t)

   Capex is the pipe, priced per foot by tier, plus the heat pump. Every constant is in `pipeline/config.py`.
5. **City total without double counting.** Each sink takes its best source, and a source's heat is shared out until it runs out.

## Results (LL84 2024)

- 16,982 buildings screened. They include 1,532 sources and 15,672 sinks.
- 18,539 source–sink pairs within 150 m. Of these, 4,557 are within one street.
- Portfolio of viable pairs (tier ≤3, positive value): **1,821 pairs, 6.4M MMBtu/yr, ~271,000 tCO₂e/yr**,
  $83M/yr of value. Only $11M of that is energy savings: in NYC, cheap gas and expensive electricity
  mean the case closes on LL97 penalties, or on sinks that buy Con Ed steam.
- **Validation.** Con Ed's proposed Chelsea thermal-energy-network pilot sends heat from 85 10th Ave to
  NYCHA Fulton Houses. HeatMatch finds that pair on its own: 142 m apart, a 24/7 data-center source,
  ~860 tCO₂e/yr, covering 35% of the campus's heat. It also finds a closer source for the same campus:
  111 Eighth Ave, 37 m away across 9th Ave, ranked #3 citywide, covering 98% with a ~7-year payback.

## Demo script (3 min)

1. **Hook, city view (0:00).** "5,921 registered cooling towers dump heat into the sky, often next door to buildings burning gas for hot water."
2. **Filters (0:25).** Drag max pipe run down to 60 m and minimum overlap up to 60%. The map collapses to a shortlist.
3. **Validation (0:50).** Press **c**. This is Con Ed's own Chelsea pilot pair: "HeatMatch found it from public data." Press **c** again: "…and found a closer source, 37 m away."
4. **Time (1:20).** Press ▶ on the time bar, then toggle Jan/Jul. Data-center pairs flow all night; cooling-tower pairs fade. "This is why we match by the hour, not by annual totals."
5. **Proposal (2:00).** Open the economics, slide the electricity price, then click **Draft proposal**.
6. **Impact (2:30).** Read the top-bar totals. Name the honest catch: energy alone is about $11M/yr, so the case closes on LL97 penalties.

Use `?lite` in the URL to turn off the particle animation on a weak laptop.

## Known limits

- Profiles are modeled from annual and monthly totals × NREL shapes, not metered hourly data.
- Cooling-tower capacity isn't public. Cooling load is estimated as a share of annual electricity.
- Prices are 2024 NYC averages. LL97 value only counts if the building is actually over its cap.

## Layout

```
symbiocity.py        pipeline entry point (fetch → clean → match → score → export)
pipeline/            config, fetch, clean, profiles, match, economics, export
tests/               coincidence / storage / energy-conservation tests
web/                 Vite + React + deck.gl + MapLibre demo (reads web/public/data/*.json)
api/proposal.py      FastAPI endpoint, Claude drafts the two owner letters
```
