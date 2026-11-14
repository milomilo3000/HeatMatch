import numpy as np
import shapely
from shapely.geometry import LineString, box

from pipeline.streets import Streets


def make(streets, protected=(), subway=()):
    """A Streets object over hand-made geometry (feet), skipping the downloads."""
    s = object.__new__(Streets)
    s.geom = np.array([g for g, *_ in streets], dtype=object)
    s.name = np.array([n for _, n, *_ in streets])
    s.width = np.array([w for _, _, w, *_ in streets], dtype=float)
    s.highway = np.array([h for *_, h in streets], dtype=bool)
    s.tree = shapely.STRtree(s.geom)
    s.protected = shapely.STRtree(np.array(list(protected), dtype=object))
    s.subway = shapely.STRtree(np.array(list(subway), dtype=object))
    return s


AVE = (LineString([(100, -500), (100, 500)]), "9 Ave", 60.0, False)
AVE_2ND_ROADWAY = (LineString([(110, -500), (110, 500)]), "9 Ave", 30.0, False)
STREET = (LineString([(-500, 100), (500, 100)]), "W 16 St", 30.0, False)
WEST, EAST, NORTH = box(0, 0, 50, 50), box(150, 0, 200, 50), box(0, 150, 50, 200)


def analyze(s, a, b):
    return s.analyze(np.array([a], dtype=object), np.array([b], dtype=object)).iloc[0]


def test_buildings_on_the_same_block_cross_nothing():
    r = analyze(make([AVE, STREET]), WEST, box(60, 0, 90, 50))
    assert r.n_cross == 0 and r.street_ft == 0 and not r.protected


def test_crossing_one_street_reports_its_name_and_width():
    r = analyze(make([AVE, STREET]), WEST, EAST)
    assert r.n_cross == 1 and r.cross_names == ["9 Ave"] and r.street_ft == 60


def test_divided_avenue_counts_once_but_adds_both_roadways():
    r = analyze(make([AVE, AVE_2ND_ROADWAY, STREET]), WEST, EAST)
    assert r.n_cross == 1 and r.street_ft == 90


def test_protected_and_subway_flags_only_apply_when_a_street_is_crossed():
    s = make([AVE, STREET], protected=[AVE[0]], subway=[STREET[0]])
    r = analyze(s, WEST, EAST)
    assert r.protected and not r.subway
    r = analyze(s, WEST, NORTH)
    assert r.subway and not r.protected and r.cross_names == ["W 16 St"]
