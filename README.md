# HeatMatch NYC

**Data centers turn nearly every watt they use into heat, around the clock, and then pay to dump it
into the sky. Their neighbors burn gas, oil or Con Ed steam for heat and hot water.** HeatMatch finds
NYC data centers and the buildings next door that could use that heat. It checks that the two are
close **and** that the heat is there in the hours it's needed, prices the link, and drafts a
proposal to both owners.

The app has two tabs:
- **Data centers** (the main product): 170 NYC data centers, standalone or a floor inside a tower.
  16 of them report a measured IT load in LL84, so their waste heat is measured rather than modeled.
- **Commercial** (estimate-heavy): supermarkets, refrigerated warehouses, hospitals/labs and
  cooling-tower buildings. Their cooling loads aren't metered anywhere public, so heat is modeled
  from assumed cooling shares and labeled as an estimate.

HackPrinceton, sustainability track. Screening tool, not an engineering design.

## Quick start

```bash
python3.15 -m venv .venv && .venv/bin/pip install pandas numpy shapely pyproj requests pyarrow openpyxl fastapi uvicorn anthropic pytest
.venv/bin/python symbiocity.py            # ~5 min first run (downloads + caches), ~3 min after
.venv/bin/python -m pytest -q tests

cd web && npm install && npm run dev      # http://localhost:5173

# AI features (voice assistant, reading uploaded bills, proposal letters)
.venv/bin/uvicorn api.main:app --port 8000
```

**AI without an API key.** The API uses the Claude Code CLI (`claude -p`) if it is installed and
logged in on the machine, so a Claude subscription is enough for a local demo. It counts against
that subscription's limits and takes 2–6 seconds per call. Set `ANTHROPIC_API_KEY` (and
`HEATMATCH_AI=api`) to use the Anthropic API instead; anything other people use needs that.
With neither, the app still works: keyword-based assistant, CSV-only uploads, template letters.

Demo keys: **c** opens NYCHA Fulton Houses (Con Ed's Chelsea pilot site) in the Data centers tab, **o** zooms back out to the city.

## Data (all free and public)

| Input | Source |
|---|---|
| Annual energy per building (gas, steam, oil, electricity, use types, BIN/BBL, lat/lon) | NYC Open Data LL84 benchmarking `5zyy-y8am` (2024) |
| Monthly gas per building | LL84 monthly `fvp3-gcb2` (gas only: electricity is blank for 2021–2024) |
| Heat-rejection sites | DOHMH/DOB cooling tower registry `y4fw-iqfr` (5,921 systems) |
| 3D geometry | Building footprints `5zhs-2jue` (polygon + roof height) |
| Owner names | PLUTO `64uk-42ks` |
| Streets a pipe would cross, and their widths | NYC street centerline (CSCL) `inkn-q76z` (110k segments) |
| Recently repaved streets (costlier to open) | DOT protected streets `wyih-3nzf` |
| Subway lines under a street | MTA subway service lines `s692-irgq` (data.ny.gov) |
| Hourly load shapes | NREL ComStock (Manhattan county) and ResStock (NY multifamily) 2024, OEDI |
| Basemap | OpenFreeMap (OpenStreetMap), no API key |

## Method

1. **Roles.**
   - **Data-center sources:** any LL84 property whose main use is Data Center, or with ≥2,000 sq ft
     of data-center floor, or a reported IT load. Waste heat = measured IT energy × 1.2 (chiller work
     on top) when reported, otherwise the data center's estimated share of building electricity. IT
     load is flat, so the heat is too. Only the data-center portion is counted.
   - **Commercial sources:** supermarkets/refrigerated warehouses, hospitals/labs, and any
     office/hotel/college with a registered cooling tower that isn't a data center. Heat comes from
     an assumed cooling or refrigeration share of electricity.
   - **Heat users (both tabs):** apartments, hotels, dorms, senior housing, gyms, offices, schools,
     colleges and hospitals buying at least 1M kBtu/yr of gas, oil or district steam.
2. **Distance and what's in the way.** The pipe route is the shortest wall-to-wall line between
   the two footprints (150 m cap). It is intersected with the city's street centerlines, so each
   pair knows exactly which public streets it crosses, how wide they are, whether any was repaved
   in the last five years (a DOT protected street), and whether a subway line runs along it. Tiers:
   - shared wall (<3 m)
   - no street to cross (private easement only)
   - crosses one street (NYC DOT revocable consent + street-opening permit)
   - crosses several streets, or a highway/bridge/ramp

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

   Installed cost is a low/base/high **screening estimate**, labeled as an estimate everywhere
   (`PIPE`, `COST` and `HP_USD_PER_KW` in `web/src/econ.js`):
   - **Pipe on private property:** feet × a per-foot rate that grows with pipe diameter
     (district-energy planning formula, EUR 7.96 × DN + 861 per metre, × 1.35 NYC premium).
   - **Pipe in the street:** the real roadway width crossed plus sidewalks, at 2–4.5× the private
     rate, +50% on a protected street, plus $40–150k per crossing for permits, traffic control and
     utility mark-out. Crossing a street costs far more than running between two buildings.
   - **Heat pumps** at $900–2,100 per kW of heat (published data-center heat-recovery studies use
     EUR 250k–1M per MW), source tie-in, building hookup (per apartment for steam-heated
     buildings), storage, engineering (~30%) and contingency (~25%).

   NYCHA buildings follow LL97 Article 321, so no per-ton penalty value is counted for them.
   Physics and price constants are in `pipeline/config.py`.
5. **City total without double counting.** Each sink takes its best source, and a source's heat is shared out until it runs out.

## Results (LL84 2024)

**Data centers (main track)**
- 170 data centers screened (16 with measured IT load). 160 have at least one heat user within 150 m,
  giving 3,231 pairs with 2,073 neighboring buildings.
- Of those pairs, 83 share a wall, 203 cross no street, 1,101 cross exactly one, and 1,844 cross
  several. 45% cross a protected street and 31% a street with a subway line.
- Crossing at most one street, 1,379 data-center pairs have a payback, and **208 pay back in under
  ~15 years** at the base estimate (hot water + space heat). The best are small, close links, e.g.
  ConEd Irving Place → 145 East 15th St (19 m across E 15 St, est. $1.0–2.9M, 5–15 years) and
  11 Wall St → 14 Wall St (14 m across Wall St, est. $0.8–2.3M, 5–13 years).
- Without double counting, the data-center portfolio could avoid an estimated **~67,000 tCO₂e/yr**.
- **Validation.** Con Ed's proposed Chelsea thermal-energy-network pilot sends heat from 85 10th Ave
  (a data-center building) to NYCHA Fulton Houses. HeatMatch finds that pair on its own, plus a
  closer data-center source for the same campus: 111 Eighth Ave, 37 m away across the 9th Ave /
  W 16th St intersection (a protected street). That big link is an estimated $19–58M with a payback
  of 14 years or more. NYCHA gets no LL97 penalty value, so smaller links pencil out first.

**Commercial (estimates)**
- 1,290 sources, 33,560 pairs; ~404,000 tCO₂e/yr portfolio. Treat as directional.

## Owner features

- **Use my real numbers.** On any building's result card, an owner can replace the public-data
  model with their own figures: a data center's IT load, or a heat user's monthly fuel use and
  price. They can type them in or upload a bill or usage file in any format (PDF, spreadsheet, CSV,
  photo); Claude reads the file, finds the usage and units, and pre-fills the form for the owner
  to check. Partner estimates update at once, with the old model numbers shown for comparison.
  The data stays in that browser (localStorage); uploaded files are read and discarded.
- **Ask HeatMatch (voice).** Press **Ask** in the search bar and speak or type, e.g. "I run the
  data center at 111 Eighth Avenue, find hotels within a block, cheapest first", then follow up
  with "none that cross a street". Claude only turns the request into filters (building, partner
  types, distance, sort); the app runs the search on its own data and reads the answer aloud, so
  the assistant can't invent a building or a number. Voice input needs Chrome, Edge or Safari.

## Demo script (3 min, data-center focused)

1. **Hook (0:00).** Grey city, yellow heat arcs. "Every one of these arcs is a NYC data center throwing
   heat into the sky next to a building that burns gas for heat. 160 data centers, 2,000 neighbors."
2. **Search (0:25).** Type a data center, e.g. "111 Eighth Avenue": its neighbors light up, numbered,
   each with an installed-cost range and payback. Point at the **measured / estimated** badge.
3. **Validation (0:55).** Press **c** (NYCHA Fulton Houses): "Con Ed is building this exact link as a
   pilot. HeatMatch found it from public data, plus a closer data center 37 m away."
4. **Honest economics (1:25).** Open the partner, then **Cost breakdown**: the street crossing is its
   own line ("Pipe under 9 Ave and W 16 St, 120 ft in the street, protected street"). Big NYCHA
   links take decades to pay back. Then search "ConEd Irving Place": the best is a ~$2M link 19 m
   away across E 15th St that pays back in an estimated 5–15 years.
   "The best data-center heat links are small and close."
   Optional: click **Use your real energy numbers**, upload a bill, and watch the estimate update.
5. **Why data centers (2:00).** Toggle **All candidates** and press ▶ on the time bar: data-center pairs
   keep flowing at 3 am in July, while the Commercial tab's cooling-tower pairs fade.
   "IT load never sleeps, so the heat supply is reliable."
6. **Voice + proposal (2:30).** Press **Ask** and say "find hotels within a block of 111 Eighth
   Avenue, cheapest first". Then click **Draft proposal to both owners**; the letter leads with the
   24/7 data-center heat.

Use `?lite` in the URL to turn off the particle animation on a weak laptop.

## Known limits

- Profiles are modeled from annual and monthly totals × NREL shapes, not metered hourly data.
- Cooling-tower capacity isn't public. Cooling load is estimated as a share of annual electricity.
- Prices are 2024 NYC averages. LL97 value only counts if the building is actually over its cap.
- Costs are screening estimates. The street crossings are real data; the dollar rates are
  assumptions (no public source prices NYC street work per foot). Concept-stage estimates like
  these typically land within −50% to +100% of the final cost (AACE Class 5).
- Data explored for cost calibration and not used: DOB job filings record real mechanical-job
  costs, but the median is $115k and they are mostly small tenant HVAC jobs.
- The pipe route is a straight wall-to-wall line; chain hops between two heat users use a
  tax-block heuristic instead of the street map.

## Layout

```
symbiocity.py        pipeline entry point (fetch → clean → match → score → export)
pipeline/            config, fetch, clean, profiles, match, streets (real street crossings), economics, export
tests/               coincidence / storage / energy-conservation tests
web/                 Vite + React + deck.gl + MapLibre demo (reads web/public/data/*.json)
api/                 FastAPI app (api.main): proposal letters, bill/usage file reading, voice-assistant intent;
                     api/ai.py reaches Claude through the Claude Code CLI or the Anthropic API
```
