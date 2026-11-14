import numpy as np

from pipeline import profiles as P
from pipeline.match import simulate


def test_matched_never_exceeds_either_side():
    rng = np.random.default_rng(0)
    A, D = rng.random((5, 8760)), rng.random((5, 8760))
    for cap in (0, 4 * D.mean(1)):
        M = simulate(A, D, cap)
        assert np.all(M <= D + 1e-9)
        assert M.sum() <= A.sum() + 1e-6


def test_flat_source_flat_sink_is_fully_coincident():
    A = np.ones((1, 8760))
    M = simulate(A, A, 0)
    assert M.sum() / A.sum() == 1.0


def test_summer_daytime_source_vs_winter_night_sink_is_low():
    summer_day = ((P.MONTH >= 5) & (P.MONTH <= 7) & (P.HOUR >= 9) & (P.HOUR <= 17)).astype(float)
    winter_night = (((P.MONTH <= 1) | (P.MONTH == 11)) & ((P.HOUR <= 6) | (P.HOUR >= 20))).astype(float)
    M = simulate(summer_day[None], winter_night[None], 0)
    assert M.sum() == 0


def test_storage_shifts_heat_into_the_evening():
    day = ((P.HOUR >= 9) & (P.HOUR <= 16)).astype(float)    # source: 8 h of daytime heat
    eve = ((P.HOUR >= 18) & (P.HOUR <= 21)).astype(float)   # sink: 4 h evening peak
    no_tank = simulate(day[None], eve[None], 0).sum()
    small = simulate(day[None], eve[None], 2.0).sum()      # tank holds half an evening
    big = simulate(day[None], eve[None], 4.0).sum()        # tank holds a full evening
    assert no_tank == 0
    assert small == 2.0 * 365 and big == eve.sum()


def test_profiles_conserve_annual_energy():
    b = {"sink_kind": "residential", "fuel_gas": 1e6, "fuel_steam": 0.0, "fuel_oil": 0.0, "gas_monthly_ok": False}
    dhw, space = P.sink_profile(b)
    assert abs((dhw + space).sum() - 0.8e6) < 1
    s = {"source_kind": "datacenter", "elec": 1e6, "dc_elec_share": 1.0, "primary_property_type": "Data Center"}
    assert abs(P.source_profile(s).sum() - 0.9e6) < 1
