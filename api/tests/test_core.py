import pytest

from app import core

T = core.Thresholds(warning=2.0, critical=4.0)


def test_density_is_people_per_square_metre():
    assert core.density(40, 20) == 2.0
    assert core.density(0, 20) == 0.0


def test_density_rejects_bad_area():
    with pytest.raises(ValueError):
        core.density(10, 0)


@pytest.mark.parametrize("d,expected", [(0.5, "safe"), (1.99, "safe"), (2.0, "warning"), (3.9, "warning"), (4.0, "critical"), (6, "critical")])
def test_status_levels(d, expected):
    assert core.status_for(d, T) == expected


def test_forecast_rising_zone_gets_an_eta():
    now = 1000.0
    hist = [(now - 40 + i, 2.0 + 0.02 * i) for i in range(41)]   # +0.02 per second
    fc = core.forecast(hist, now, T)
    assert fc["trend"] == "rising"
    assert fc["per_min"] == pytest.approx(1.2, abs=0.01)
    assert fc["eta_s"] == pytest.approx((4.0 - 2.8) / 0.02, rel=0.02)


def test_forecast_steady_zone_has_no_eta():
    now = 1000.0
    hist = [(now - i, 1.5) for i in range(30)]
    fc = core.forecast(hist, now, T)
    assert fc == {"trend": "steady", "per_min": 0.0, "eta_s": None}


def test_forecast_already_critical():
    now = 1000.0
    hist = [(now - i, 4.5) for i in range(10)]
    assert core.forecast(hist, now, T)["eta_s"] == 0.0


def test_redirect_goes_to_least_loaded_online_zone():
    zones = [
        {"id": "gate", "name": "Main gate", "density": 4.6, "status": "critical", "offline": False},
        {"id": "stage", "name": "Front stage", "density": 2.5, "status": "warning", "offline": False},
        {"id": "food", "name": "Food court", "density": 0.4, "status": "safe", "offline": True},
        {"id": "exit", "name": "Exit road", "density": 1.0, "status": "safe", "offline": False},
    ]
    plan = core.redirect_plan(zones, T)
    assert plan == [{"from": "gate", "from_name": "Main gate", "to": "exit", "to_name": "Exit road", "to_load_pct": 25}]


def test_overall_status():
    assert core.overall_status([{"status": "safe"}, {"status": "critical"}]) == "critical"
    assert core.overall_status([{"status": "safe", "offline": True}, {"status": "safe"}]) == "degraded"
    assert core.overall_status([{"status": "safe"}]) == "safe"
