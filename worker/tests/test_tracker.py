import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tracker import CentroidTracker, flow_stats  # noqa: E402


def box(cx, cy, w=20, h=40):
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, 0.9)


def test_same_person_keeps_id_and_gets_velocity():
    tr = CentroidTracker()
    first = tr.update([box(100, 100)], 640, 360, 0.5)
    second = tr.update([box(110, 100)], 640, 360, 0.5)
    assert first[0].id == second[0].id
    assert second[0].vx > 0


def test_everyone_walking_the_same_way_is_coherent():
    tr = CentroidTracker()
    for step in range(4):
        tracks = tr.update([box(100 + 60 * i + 8 * step, 200) for i in range(6)], 640, 360, 0.5)
    stats = flow_stats(tracks)
    assert stats["coherence"] > 0.9
    assert stats["moving"] == 6


def test_opposing_groups_show_counterflow():
    tr = CentroidTracker()
    for step in range(4):
        left = [box(100 + 60 * i + 8 * step, 100) for i in range(4)]
        right = [box(100 + 60 * i - 8 * step, 250) for i in range(4)]
        tracks = tr.update(left + right, 640, 360, 0.5)
    assert flow_stats(tracks)["counterflow"] > 0.8
