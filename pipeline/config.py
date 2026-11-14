"""HeatMatch constants. Every assumption lives here so the UI and pitch can cite it."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SHAPES = ROOT / "data" / "shapes"
WEB_DATA = ROOT / "web" / "public" / "data"

SOCRATA = "https://data.cityofnewyork.us/resource"
DS_LL84 = "5zyy-y8am"          # LL84 annual benchmarking, 2022-present
DS_LL84_MONTHLY = "fvp3-gcb2"  # LL84 monthly gas + electricity
DS_COOLING = "y4fw-iqfr"       # DOHMH/DOB cooling tower registrations
DS_FOOTPRINTS = "5zhs-2jue"    # building footprints with height_roof
DS_PLUTO = "64uk-42ks"         # PLUTO (owner names)

YEAR = 2024

# NREL End-Use Load Profiles (OEDI, public S3). Hourly shapes only; magnitudes come from LL84.
OEDI = "https://oedi-data-lake.s3.amazonaws.com/nrel-pds-building-stock/end-use-load-profiles-for-us-building-stock/2024"
COMSTOCK_COUNTY = OEDI + "/comstock_amy2018_release_2/timeseries_aggregates/by_county/upgrade=0/county=G3600610/up00-g3600610-{btype}.csv"
RESSTOCK_STATE = OEDI + "/resstock_amy2018_release_2/timeseries_aggregates/by_state/upgrade=0/state=NY/up00-ny-{btype}.csv"
COMSTOCK_TYPES = ["largeoffice", "hospital", "largehotel"]
RESSTOCK_TYPES = ["multi-family_with_5plus_units"]

# --- building roles -------------------------------------------------------
# Sources run around the clock (process cooling / refrigeration / IT).
SOURCE_24_7 = {
    "Data Center": "datacenter",
    "Supermarket/Grocery Store": "refrigeration",
    "Refrigerated Warehouse": "refrigeration",
    "Wholesale Club/Supercenter": "refrigeration",
    "Hospital (General Medical & Surgical)": "hospital",
    "Laboratory": "hospital",
    "Other - Recreation": "refrigeration",  # kept only if the name looks like an ice rink
}
# These count as sources only when they have a registered cooling tower.
SOURCE_IF_TOWER = {
    "Office": "office", "Financial Office": "office", "Mixed Use Property": "office",
    "College/University": "office", "Retail Store": "office", "Enclosed Mall": "office",
    "Hotel": "office", "Medical Office": "office", "Bank Branch": "office",
}
SINK_TYPES = {
    "Multifamily Housing": "residential", "Residence Hall/Dormitory": "residential",
    "Senior Living Community": "residential", "Residential Care Facility": "residential",
    "Other - Lodging/Residential": "residential",
    "Hotel": "hotel", "Fitness Center/Health Club/Gym": "hotel",
}
SINK_MIN_HEAT_KBTU = 1_000_000  # ~10,000 therms/yr of fossil heat: below this a heat link isn't worth it
# Fossil heat a sink buys today. Con Ed district steam is fossil-fired, so it counts.
FUELS = {  # LL84 column -> (label, LL97 tCO2e/kBtu, $/kBtu, delivered-heat efficiency)
    "natural_gas_use_kbtu": ("gas", 0.00005311, 0.0115, 0.80),
    "district_steam_use_kbtu": ("steam", 0.00004493, 0.0280, 0.85),
    "fuel_oil_2_use_kbtu": ("oil", 0.00007421, 0.0250, 0.80),
    "fuel_oil_4_use_kbtu": ("oil", 0.00007529, 0.0220, 0.80),
}
DATACENTER_INTENSITY = 10  # data-center floor uses ~10x the electricity per ft2 of office floor

# --- physics ---------------------------------------------------------------
CHILLER_COP = 5.0          # condenser heat = cooling elec * (1 + COP)
REFRIG_COP = 2.5
REFRIG_ELEC_SHARE = 0.5    # share of supermarket electricity that is refrigeration
DATACENTER_HEAT_SHARE = 0.9
CAPTURE_EFF = 0.7          # fraction of rejected heat realistically captured
HP_COP = 3.5               # water-source heat pump, ~85F condenser water -> ~140F (~45% of Carnot)
STORAGE_HOURS = [0, 4, 12] # thermal-storage scenarios precomputed for the UI slider

# --- distance --------------------------------------------------------------
MAX_DIST_M = 150
SHARED_WALL_M = 3
ONE_STREET_M = 40
TIER_LABEL = {1: "Shared wall", 2: "Same block", 3: "Across one street", 4: "Further"}
PIPE_USD_PER_FT = {1: 800, 2: 800, 3: 2500, 4: 3500}  # trench-ft incl. supply+return, NYC urban
CONNECTION_FT = 60         # risers / plant-room connections on both ends

# --- money & carbon ---------------------------------------------------------
# Fuel prices: gas = EIA NY commercial (~$11.5/Mcf, 2024); steam = Con Ed SC tariff (~$33/Mlb);
# oil = NY heating-oil average (~$3.5/gal). Per-fuel values live in FUELS above.
ELEC_USD_PER_KWH = 0.22    # EIA NY commercial electricity (2024)
HP_USD_PER_KW = 1500       # installed water-source heat pump, per kW thermal
LL97_ELEC_T_PER_KWH = 0.000288962  # 2024-2029 grid coefficient
LL97_USD_PER_T = 268
# Cooling towers evaporate water to reject heat: ~1 gal per 8.3 kBtu plus ~25% blowdown.
TOWER_GAL_PER_KBTU = 0.15
WATER_USD_PER_GAL = 0.0165  # NYC water + sewer combined, ~$12.4 per 100 ft3 (FY2025)

KBTU_PER_KWH = 3.412
KBTU_PER_THERM = 100.0
# Cooling share of annual electricity when no monthly electric data exists
# (LL84 monthly publishes gas only). From ComStock Manhattan / typical NYC benchmarks.
COOLING_ELEC_SHARE = {"office": 0.12, "hospital": 0.15}
