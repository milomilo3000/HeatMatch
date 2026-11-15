# HeatMatch NYC

**Data centers turn nearly every watt they use into heat, around the clock, and then pay to dump it
into the sky. Their neighbors burn gas, oil or Con Ed steam for heat and hot water.** HeatMatch finds
NYC data centers and the buildings next door that could use that heat. It checks that the two are
close **and** that the heat is there in the hours it's needed, prices the link, and drafts a
proposal to both owners.

The app has two tabs:
- **Data centers** (the main product): 170 NYC data centers, standalone or a floor inside a tower.
  16 of them report a measured IT load in LL84, so their waste heat is measured rather than modeled.
- **Commercial**: supermarkets, refrigerated warehouses, hospitals/labs and cooling-tower
  buildings. Their cooling loads aren't metered anywhere public, so their heat is modeled from
  assumed cooling shares.

Live demo: [heatmatch.us](https://heatmatch.us). **Demo login** unlocks the AI features.

HackPrinceton, sustainability track. Screening tool, not an engineering design.

## Quick start

Follow the [setup guide](SETUP.md) to run the demo and configure Anthropic and ElevenLabs.
The included demo data is ready to use.

To regenerate the data, install `numpy pandas shapely pyproj requests pyarrow openpyxl` in your
virtual environment and run `python symbiocity.py` from the repo root (about 3 minutes with cached
downloads). Install `pytest` and run `python -m pytest -q tests` to run the Python tests.

Demo keys: **c** opens NYCHA Fulton Houses (Con Ed's Chelsea pilot site) in the Data centers tab,
**o** zooms back out to the city. Add `?lite` to the URL to turn off the particle animation on a
weak laptop.

## Data (all free and public)

| Input | Source |
|---|---|
| Annual energy per building (gas, steam, oil, electricity, use types, BIN/BBL, lat/lon) | NYC Open Data LL84 benchmarking `5zyy-y8am` (2024) |
| Monthly gas per building | LL84 monthly `fvp3-gcb2` (gas only: electricity is blank for 2021–2024) |
| Heat-rejection sites | DOHMH/DOB cooling tower registry `y4fw-iqfr` (5,921 systems) |
| 3D geometry | Building footprints `5zhs-2jue` (polygon + roof height) |
| Owner names, apartment counts | PLUTO `64uk-42ks` |
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
     colleges and hospitals buying at least 1M kBtu/yr of gas, oil or district steam (18,880
     buildings).
2. **Distance and what's in the way.** The pipe route is the shortest wall-to-wall line between
   the two footprints (150 m cap). It is intersected with the city's street centerlines, so each
   pair knows exactly which public streets it crosses, how wide they are, whether any was repaved
   in the last five years (a DOT protected street), and whether a subway line runs along it. Tiers:
   - shared wall (<3 m)
   - no street to cross (private easement only)
   - crosses one street (NYC DOT revocable consent + street-opening permit)
   - crosses several streets, or a highway/bridge/ramp

   Pairs on the same campus, the same lot, or with the same owner are excluded, and so are
   hospital-to-hospital pairs (almost always one medical campus).
3. **Timing.** Each building gets an 8,760-hour profile. A sink's summer gas floor is hot water,
   and the winter excess is space heat; both are shaped by NREL hourly profiles. Source heat comes
   from electricity use (IT load, refrigeration, chiller condenser heat) and is shaped by the same
   profiles. Matched heat each hour is `min(available, demand)`, with an optional 4 h or 12 h
   thermal tank. *Timing fit* is the share of the smaller side that lines up hour by hour;
   *coverage* is the share of the neighbor's heat need that gets met.
4. **Economics.** A water-source heat pump lifts the captured waste heat to ~140°F. The pipeline's
   baseline is COP 3.5 with 70% of rejected heat captured (`pipeline/config.py`). The web app runs
   a **demo setting** of COP 5 with 78.4% capture, which delivers the same heat with less
   electricity (`demoAssumptions` in `web/src/econ.js`). Yearly savings are made up of:
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
5. **Match score (0–100).** 30% timing fit, 30% coverage, 20% how easy the pipe route is, 20%
   payback. Each partner shows the four reasons behind its score.
6. **City total without double counting.** Each heat user takes its best source, and a source's
   heat is shared out until it runs out.

## AI and voice

| Feature | What runs it |
|---|---|
| **Ask**: a spoken or typed request becomes search filters | Claude Opus 5.5 (Anthropic Messages API, structured JSON output) |
| Reading an uploaded bill (PDF, photo, spreadsheet, CSV) | Claude Opus 5.5 (PDF/image input, structured JSON output) |
| Outreach letters to both owners | Claude Opus 5.5, streamed; template letter as fallback |
| Speech input on the hosted site | ElevenLabs **Scribe v2 realtime**: the browser streams the mic directly to ElevenLabs with a single-use token from `/api/scribe-token` |
| Speech input when running locally | `/api/transcribe`: faster-whisper (`base.en`/`tiny.en`) or the small Vosk English model, on the server |
| Spoken replies | ElevenLabs **Flash v2.5** text-to-speech (`/api/speech`); off until the user turns voice on |

Claude never produces a building or a number shown to the user. It only turns words into filters,
reads a file into usage figures for the owner to check, or writes letters from facts the app
supplies. Every match, cost and saving comes from the app's own data. On the hosted site, a shared
**Demo login** password protects the paid endpoints. Without `ANTHROPIC_API_KEY` the app falls back
to keyword search, CSV import and template letters; without `ELEVENLABS_API_KEY` there is no voice.
API keys stay on the server.

## Results (LL84 2024)

**Data centers (main track)**
- 170 data centers screened (16 with measured IT load). 160 have at least one heat user within
  150 m, giving 3,231 pairs with 2,073 neighboring buildings.
- Of those pairs, 83 share a wall, 203 cross no street, 1,101 cross exactly one, and 1,844 cross
  several. 45% cross a protected street and 31% a street with a subway line.
- Crossing at most one street, 1,387 pairs qualify. At the base cost estimate (hot water + space
  heat), **208 pay back in under 15 years** at the pipeline baseline, and **406** at the app's
  demo setting.
- The best are small, close links. At the demo setting:
  - ConEd Irving Place → 145 East 15th St: 19 m across E 15 St, est. $1.0–2.9M, ~$246k/yr
    savings, 4–12 year payback.
  - 11 Wall St → 14 Wall St: 14 m across Wall St, est. $0.8–2.3M, ~$230k/yr, 3–10 years.
- Without double counting, the data-center portfolio could avoid an estimated **~67,000 tCO₂e/yr**
  (pipeline baseline).
- **Validation.** Con Ed's proposed Chelsea thermal-energy-network pilot sends heat from 85 10th Ave
  (a data-center building) to NYCHA Fulton Houses. HeatMatch finds that pair on its own, plus a
  closer data-center source for the same campus: 111 Eighth Ave, 37 m away across the 9th Ave /
  W 16th St intersection (a protected street). That big link is an estimated $19–59M saving
  ~$1.8M/yr, so it takes 10 years or more to pay back. NYCHA gets no LL97 penalty value, so
  smaller links pencil out first.

**Commercial (directional)**
- 1,363 sources screened, 1,267 with a partner. The app shows 8,605 pairs, the best 8 per source,
  mostly within one street. Portfolio ~404,000 tCO₂e/yr.

## Owner features

- **Use my real numbers.** On any building's result card, an owner can replace the public-data
  model with their own figures: a data center's IT load, or a heat user's monthly fuel use and
  price. They can type them in or upload a bill or usage file in any format (PDF, spreadsheet, CSV,
  photo); Claude reads the file, finds the usage and units, and pre-fills the form for the owner
  to check. Partner estimates update at once, with the old model numbers shown for comparison.
  The figures stay in that browser (localStorage); uploaded files are read and discarded.
- **Ask HeatMatch.** Press **Ask** in the search bar, then speak (microphone button) or type, e.g.
  "I run the data center at 111 Eighth Avenue, find hotels within a block, cheapest first", and
  follow up with "none that cross a street". Claude only turns the request into filters
  (building, partner types, distance, sort); the app runs the search on its own data and writes
  the answer from the real results. Turn voice on to hear the answer read aloud.
- **Draft outreach letters.** From any partner, Claude drafts a letter to each owner using only the
  numbers HeatMatch computed for that link.

## Demo script (3 min, data-center focused)

1. **Hook (0:00).** Grey city, yellow heat arcs. "Every one of these arcs is a NYC data center throwing
   heat into the sky next to a building that burns gas for heat. 160 data centers, 2,000 neighbors."
2. **Search (0:25).** Type a data center, e.g. "111 Eighth Avenue": its neighbors light up, each with
   an installed-cost range and yearly savings. Hover a building to see its number and name.
3. **Validation (0:55).** Press **c** (NYCHA Fulton Houses): "Con Ed is building this exact link as a
   pilot. HeatMatch found it from public data, plus a closer data center 37 m away."
4. **Honest economics (1:25).** Open the partner. The route line reads "Under 9 Ave and W 16 St ·
   needs a DOT street permit", and **Savings & cost breakdown** shows pipe & street work as its
   own line. Big NYCHA links take a decade or more to pay back. Then search "ConEd Irving Place":
   the best is a link 19 m away across E 15th St, est. $1.0–2.9M, saving ~$246k a year.
   "The best data-center heat links are small and close."
   Optional: click **Own this building? Use your real energy numbers**, upload a bill, and watch
   the estimate update.
5. **Why data centers (2:00).** Point at the partner's score: "Heat is there when it's needed (100%
   of hours)". IT load never sleeps. Switch to the **Commercial** tab and open a cooling-tower pair:
   its timing fit is lower because that heat fades at night and in winter.
6. **Voice + letters (2:30).** Press **Ask** and say "find hotels within a block of 111 Eighth
   Avenue, cheapest first". Then open a partner and click **Draft outreach letters**; the letter
   leads with the 24/7 data-center heat.

## Known limits

- Profiles are modeled from annual and monthly totals × NREL shapes, not metered hourly data.
- **Most data-center heat is estimated.** 154 of 170 data centers report no measured IT load.
  On the 24 LL84 buildings that report both IT energy and data-center floor area, our
  share-of-electricity estimate runs about 3.7× high, so estimated sources likely overstate heat.
- **LL97 value is generous.** Avoided penalties are counted for every non-NYCHA neighbor, but only
  about 17% of data-center neighbors are over their 2024–29 emissions cap (about 74% from 2030).
- The app's demo setting (heat-pump COP 5) is optimistic; the pipeline baseline is COP 3.5. In NYC,
  heat-pump electricity often costs more than the gas it replaces, so for gas-heated neighbors the
  savings lean on LL97 value.
- Cooling-tower capacity isn't public. Cooling load is estimated as a share of annual electricity.
- Prices are 2024 NYC averages.
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
web/                 Vite + React + deck.gl + MapLibre app (reads web/public/data/*.json)
api/                 FastAPI app (api.main), also serves web/dist when built:
                       ai.py            Claude Messages API (structured output, PDF/image input)
                       assistant.py     Ask: request → search filters
                       usage.py         bill / usage file reading
                       proposal.py      outreach letters (streamed)
                       speech.py        ElevenLabs text-to-speech + Scribe single-use tokens
                       transcription.py local speech-to-text (faster-whisper / Vosk)
                       demo_login.py    shared-password gate for the paid endpoints
tests/               matching/storage, streets, AI bridge, speech, transcription, demo login
Dockerfile, render.yaml, render-build.sh   hosted deploy (Render)
```
