import json
import math
import unittest

from .context import trajectory


class ParsePath(unittest.TestCase):
    def test_empty_text_is_the_source_camera(self):
        path = trajectory.parse_path("")
        self.assertEqual(path["camera"], [{"frame": 0, "pivot": "p1", **trajectory.DEFAULTS}])
        self.assertEqual(path["pivots"], [trajectory.default_pivot()])

    def test_missing_axes_fall_back_to_defaults(self):
        path = trajectory.parse_path('[{"frame": 3, "azimuth": 10}]')
        self.assertEqual(path["camera"][0], {"frame": 3, "pivot": "p1", **trajectory.DEFAULTS, "azimuth": 10.0})

    def test_a_bare_array_is_a_version_1_path_on_the_automatic_pivot(self):
        path = trajectory.parse_path('[{"frame": 0}, {"frame": 10, "azimuth": 5}]')
        self.assertEqual(len(path["pivots"]), 1)
        self.assertEqual(trajectory.pivot_at(path["pivots"][0], 0), trajectory.PIVOT_DEFAULTS)
        self.assertTrue(all(key["pivot"] == path["pivots"][0]["id"] for key in path["camera"]))

    def test_keyframes_are_sorted_by_frame(self):
        path = trajectory.parse_path('[{"frame": 9}, {"frame": 2}]')
        self.assertEqual([key["frame"] for key in path["camera"]], [2, 9])

    def test_a_keyframe_without_a_pivot_takes_the_first(self):
        path = trajectory.parse_path({"pivots": [{"id": "a", "keys": [{"frame": 0, "x": 0.5}]},
                                                 {"id": "b", "keys": [{"frame": 0}]}],
                                      "camera": [{"frame": 0}, {"frame": 5, "pivot": "b"}]})
        self.assertEqual([key["pivot"] for key in path["camera"]], ["a", "b"])
        self.assertEqual(path["pivots"][0]["keys"][0], {"frame": 0, **trajectory.PIVOT_DEFAULTS, "x": 0.5})

    def test_rejects_bad_paths(self):
        for raw in ('{"frame": 0}', "[]", "[[]]", '[{"azimuth": 1}]', '[{"frame": 0}, {"frame": 0}]',
                    '[{"frame": 0, "distance": 0}]', '[{"frame": 0, "azimuth": "x"}]', "not json",
                    '{"camera": [{"frame": 0, "pivot": "missing"}]}',
                    '{"pivots": [{"id": "a", "keys": []}], "camera": [{"frame": 0}]}',
                    '{"pivots": [{"keys": [{"frame": 0}]}], "camera": [{"frame": 0}]}',
                    '{"pivots": [{"id": "a", "keys": [{"frame": 0}]}, {"id": "a", "keys": [{"frame": 0}]}], '
                    '"camera": [{"frame": 0}]}',
                    '{"pivots": [{"id": "a", "keys": [{"frame": 0, "z": 0}]}], "camera": [{"frame": 0}]}'):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    trajectory.parse_path(raw)

    def test_round_trips_through_dumps(self):
        path = trajectory.parse_path('[{"frame": 0}, {"frame": 30, "azimuth": 20.123456}]')
        self.assertEqual(trajectory.parse_path(trajectory.dumps(path))["camera"][1]["azimuth"], 20.1235)


class Interpolation(unittest.TestCase):
    path = [
        {"frame": 0, "azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.0, "height": 0.0},
        {"frame": 30, "azimuth": 20.0, "elevation": 5.0, "distance": 1.1, "lateral": 0.0, "height": 0.0},
        {"frame": 60, "azimuth": 45.0, "elevation": 0.0, "distance": 1.2, "lateral": 0.1, "height": 0.0},
    ]

    def test_keyframes_are_hit_exactly(self):
        for key in self.path:
            pose = trajectory.pose_at(self.path, key["frame"])
            for name in trajectory.AXES:
                self.assertAlmostEqual(pose[name], trajectory.axis(key, name), places=9)

    def test_axes_absent_from_a_keyframe_are_defaulted(self):
        # Paths saved before an axis existed must still interpolate.
        pose = trajectory.pose_at([{"frame": 0, "azimuth": 0.0}, {"frame": 10, "azimuth": 10.0}], 5)
        self.assertEqual(pose["distance"], 1.0)
        self.assertEqual(pose["tilt"], 0.0)
        self.assertEqual(pose["roll"], 0.0)
        self.assertEqual(pose["pivot"], trajectory.PIVOT_DEFAULTS)

    def test_held_outside_the_path(self):
        self.assertEqual(trajectory.pose_at(self.path, -5)["azimuth"], 0.0)
        self.assertEqual(trajectory.pose_at(self.path, 500)["azimuth"], 45.0)

    def test_monotone_axis_never_overshoots(self):
        previous = -math.inf
        for frame in range(61):
            azimuth = trajectory.pose_at(self.path, frame)["azimuth"]
            self.assertGreaterEqual(azimuth, previous)
            self.assertLessEqual(azimuth, 45.0)
            previous = azimuth

    def test_peak_axis_stays_inside_its_segment(self):
        for frame in range(61):
            elevation = trajectory.pose_at(self.path, frame)["elevation"]
            self.assertGreaterEqual(elevation, 0.0)
            self.assertLessEqual(elevation, 5.0)

    def test_single_keyframe_holds_everywhere(self):
        path = trajectory.parse_path('[{"frame": 10, "azimuth": 7}]')
        self.assertEqual([pose["azimuth"] for pose in trajectory.poses(path, 3)], [7.0, 7.0, 7.0])

    def test_poses_returns_one_entry_per_frame(self):
        self.assertEqual(len(trajectory.poses(self.path, 12)), 12)

    def test_switching_pivots_eases_between_their_positions(self):
        # The pivot is resolved to a position first, so a handoff is a move, not a jump.
        path = trajectory.parse_path({
            "pivots": [{"id": "a", "keys": [{"frame": 0, "x": -0.5}]},
                       {"id": "b", "keys": [{"frame": 0, "x": 0.5, "z": 1.5}]}],
            "camera": [{"frame": 0, "pivot": "a"}, {"frame": 20, "pivot": "b"}],
        })
        self.assertEqual(trajectory.pose_at(path, 0)["pivot"], {**trajectory.PIVOT_DEFAULTS, "x": -0.5})
        self.assertEqual(trajectory.pose_at(path, 20)["pivot"], {**trajectory.PIVOT_DEFAULTS, "x": 0.5, "z": 1.5})
        middle = trajectory.pose_at(path, 10)["pivot"]
        self.assertAlmostEqual(middle["x"], 0.0, places=9)
        self.assertAlmostEqual(middle["z"], 1.25, places=9)
        xs = [trajectory.pose_at(path, frame)["pivot"]["x"] for frame in range(21)]
        self.assertEqual(xs, sorted(xs))

    def test_a_pivot_track_interpolates_over_time(self):
        pivot = {"id": "p", "keys": [{"frame": 0, "x": 0.0}, {"frame": 10, "x": 1.0}]}
        self.assertAlmostEqual(trajectory.pivot_at(pivot, 5)["x"], 0.5, places=9)
        self.assertEqual(trajectory.pivot_at(pivot, 99)["x"], 1.0)


class Serialization(unittest.TestCase):
    def test_dumps_emits_a_versioned_path_object(self):
        data = json.loads(trajectory.dumps(trajectory.parse_path('[{"frame": 0}]')))
        self.assertEqual(data["version"], trajectory.VERSION)
        self.assertEqual(list(data), ["version", "pivots", "camera"])
        self.assertEqual(list(data["camera"][0]), ["frame", "pivot", *trajectory.AXES])
        self.assertEqual(list(data["pivots"][0]["keys"][0]), ["frame", *trajectory.PIVOT_AXES])


if __name__ == "__main__":
    unittest.main()
