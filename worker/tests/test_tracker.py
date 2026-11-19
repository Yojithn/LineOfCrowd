import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tracker import CentroidTracker, CounterflowPersistence, Track, flow_stats  # noqa: E402


def box(cx, cy, w=20, h=40):
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, 0.9)


def test_one_person_keeps_id_and_velocity():
    tr = CentroidTracker()
    first = tr.update([box(100, 100)], 640, 360, 0.5)
    second = tr.update([box(110, 100)], 640, 360, 0.5)
    assert first[0].id == second[0].id
    assert second[0].vx > 0


def test_two_people_crossing_keep_motion_predicted_ids():
    tr = CentroidTracker(max_jump=0.12)
    frames = [[box(250, 100), box(390, 100)], [box(290, 100), box(350, 100)],
              [box(330, 100), box(310, 100)], [box(370, 100), box(270, 100)]]
    tracked = [tr.update(frame, 640, 360, 1.0) for frame in frames]
    left_id, right_id = tracked[0][0].id, tracked[0][1].id
    assert tr.tracks[left_id].x > tr.tracks[right_id].x
    assert len({t.id for t in tracked[-1]}) == 2


def test_short_occlusion_and_reappearance_preserve_id():
    tr = CentroidTracker()
    tid = tr.update([box(100, 100)], 640, 360, 0.5)[0].id
    tr.update([box(110, 100)], 640, 360, 0.5)
    assert tr.update([], 640, 360, 0.5) == []
    returned = tr.update([box(130, 100)], 640, 360, 0.5)
    assert returned[0].id == tid


def test_disappearance_expires_and_late_reappearance_gets_new_id():
    tr = CentroidTracker(max_missed=2, max_missed_s=2)
    tid = tr.update([box(100, 100)], 640, 360, 0.5)[0].id
    for _ in range(3):
        tr.update([], 640, 360, 0.5)
    assert tid not in tr.tracks
    assert tr.update([box(100, 100)], 640, 360, 0.5)[0].id != tid


def test_expiration_uses_elapsed_time_even_at_low_frame_rate():
    tr = CentroidTracker(max_missed=20, max_missed_s=1)
    tid = tr.update([box(100, 100)], 640, 360, 0.5)[0].id
    tr.update([], 640, 360, 1.1)
    assert tid not in tr.tracks


def test_assignment_never_duplicates_track_or_detection():
    tr = CentroidTracker()
    tr.update([box(100, 100), box(180, 100)], 640, 360, 0.5)
    tracks = tr.update([box(110, 100), box(170, 100), box(300, 100)], 640, 360, 0.5)
    assert len(tracks) == 3
    assert len({t.id for t in tracks}) == 3


def make_tracks(vectors):
    return [Track(i + 1, 0.5, 0.5, (0, 0, 1, 1), vx, vy, age=3)
            for i, (vx, vy) in enumerate(vectors)]


def test_one_way_flow_is_classified():
    stats = flow_stats(make_tracks([(0.03, 0.001)] * 8))
    assert stats["state"] == "one_way"
    assert stats["forward_fraction"] >= 0.7


def test_two_opposing_streams_are_detected_with_proportions():
    stats = flow_stats(make_tracks([(0.03, 0)] * 5 + [(-0.03, 0)] * 4))
    assert stats["state"] == "counterflow"
    assert stats["forward_fraction"] >= 0.25
    assert stats["reverse_fraction"] >= 0.25


def test_random_multidirectional_motion_is_not_counterflow():
    vecs = [(math.cos(i * math.tau / 8), math.sin(i * math.tau / 8)) for i in range(8)]
    assert flow_stats(make_tracks(vecs))["state"] == "multidirectional"


def test_stationary_and_insufficient_tracks_report_insufficient():
    assert flow_stats(make_tracks([(0, 0)] * 8))["state"] == "insufficient"
    assert flow_stats(make_tracks([(0.03, 0)] * 3))["state"] == "insufficient"


def test_noisy_opposing_vectors_are_grouped_with_tolerance():
    stats = flow_stats(make_tracks([(0.03, 0.003), (0.03, -0.004), (0.03, 0.002),
                                    (-0.03, 0.002), (-0.03, -0.004), (-0.03, 0.001)]))
    assert stats["state"] == "counterflow"


def test_counterflow_must_persist_before_confirmation():
    stats = flow_stats(make_tracks([(0.03, 0)] * 4 + [(-0.03, 0)] * 4))
    persistence = CounterflowPersistence(threshold_s=3)
    assert persistence.update(stats, 1)["counterflow_confirmed"] is False
    assert persistence.update({**stats, "state": "multidirectional"}, 1)["counterflow_confirmed"] is False
    assert persistence.update(stats, 1)["counterflow_confirmed"] is False
    assert persistence.update(stats, 1.9)["counterflow_confirmed"] is False
    assert persistence.update(stats, 1.1)["counterflow_confirmed"] is True
