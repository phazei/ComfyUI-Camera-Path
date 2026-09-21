"""The editor must predict exactly what the node renders.

js/interpolate.js and js/geometry.js reimplement trajectory.py and render.py for
the live preview; this runs both and compares them.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

import numpy as np
import torch

from .context import render, trajectory

SCRIPT = pathlib.Path(__file__).resolve().parent / "parity.mjs"
PIVOT_Z = 2.35
WIDTH, HEIGHT = 48, 36
LENS = {"fx": 60.0, "fy": 60.0, "cx": WIDTH / 2, "cy": HEIGHT / 2}

PATH = {
    "pivots": [
        {"id": "subject", "keys": [{"frame": 0, "x": -0.2, "y": 0.1, "z": 0.9, "tilt": -12, "roll": 4, "heading": 35}]},
        {"id": "other", "keys": [{"frame": 0, "x": 0.4, "heading": -20}, {"frame": 60, "x": 0.6, "z": 1.3, "roll": -9, "heading": 90}]},
        {"id": "third", "keys": [{"frame": 0, "x": -0.6, "z": 1.7, "tilt": 20, "heading": -45}]},
    ],
    "camera": [
        {"frame": 0, "pivot": "subject", "azimuth": 0, "elevation": 0, "distance": 1, "lateral": 0, "height": 0},
        {"frame": 17, "pivot": "subject", "pivot_target": "other", "pivot_blend": 0.35,
         "azimuth": 20.5, "elevation": 5, "distance": 1.1, "lateral": -0.2,
         "height": 0.15, "pan": 4, "tilt": -6, "roll": 3, "lock": 0, "dolly": -0.4},
        {"frame": 42, "pivot": "other", "pivot_target": "third", "pivot_blend": 0.2,
         "azimuth": 45, "elevation": -3, "distance": 1.2, "lateral": 0.1, "height": 0,
         "pan": 12, "tilt": -6, "roll": -11, "lock": 1, "dolly": 0.6},
        {"frame": 90, "pivot": "other", "azimuth": 45, "elevation": -3, "distance": 0.8, "lateral": 0.1,
         "height": -0.4, "pan": 12, "tilt": 9, "lock": 1},
    ],
}
POSES = [
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.0, "height": 0.0},
    {"azimuth": 33.0, "elevation": 12.0, "distance": 1.4, "lateral": 0.0, "height": 0.0},
    {"azimuth": -120.0, "elevation": -40.0, "distance": 0.6, "lateral": 0.3, "height": -0.25},
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.5, "height": 0.5},
    {"azimuth": 400.0, "elevation": 0.0, "distance": 2.0, "lateral": -0.7, "height": 0.2},
    # Aim and lock, alone and stacked on an orbit that already moved the camera.
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.0, "height": 0.0,
     "pan": 25.0, "tilt": -15.0, "lock": 0.0, "dolly": -0.3},
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.6, "height": -0.35, "lock": 1.0},
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.6, "height": -0.35, "lock": 0.4},
    {"azimuth": -70.0, "elevation": 25.0, "distance": 1.3, "lateral": -0.4, "height": 0.3,
     "pan": -33.0, "tilt": 18.0, "lock": 1.0, "dolly": 0.4},
    {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "roll": 30.0},
    {"azimuth": 15.0, "elevation": -10.0, "distance": 1.2, "lateral": 0.2, "pan": 5.0, "tilt": 7.0, "roll": -25.0},
]
# A pivot off the optical axis, so the rigid-orbit construction gets compared too, and
# then the same pivot with a turned orbit frame.
OFF_AXIS = [-0.55, 0.3, 1.9]
FRAME = {"tilt": -20.0, "roll": 7.5}
CAMERAS = ([{"pose": pose} for pose in POSES]
           + [{"pose": pose, "pivot": OFF_AXIS} for pose in POSES]
           + [{"pose": pose, "pivot": OFF_AXIS, **FRAME} for pose in POSES])


def scene():
    """A tilted wall with a nearer block, so the z-buffer and the splat both matter."""
    rows = torch.arange(HEIGHT, dtype=torch.float32)[:, None]
    columns = torch.arange(WIDTH, dtype=torch.float32)[None, :]
    depth = 2.0 + columns / WIDTH * 1.5 + rows / HEIGHT * 0.25
    depth[HEIGHT // 4:HEIGHT // 2, WIDTH // 3:2 * WIDTH // 3] = 1.4
    colors = torch.stack([(columns * 5 % 256).expand(HEIGHT, WIDTH),
                          (rows * 7 % 256).expand(HEIGHT, WIDTH),
                          ((rows + columns) * 3 % 256)], dim=-1).to(torch.uint8)
    return depth, colors


def point_map(depth):
    rows = torch.arange(HEIGHT, dtype=torch.float32)[:, None] + 0.5
    columns = torch.arange(WIDTH, dtype=torch.float32)[None, :] + 0.5
    return torch.stack([(columns - LENS["cx"]) / LENS["fx"] * depth,
                        (rows - LENS["cy"]) / LENS["fy"] * depth, depth], dim=-1)


@unittest.skipIf(shutil.which("node") is None, "node is not installed")
class FrontendParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frames = sorted(set(range(0, 95, 3)) | {-3, 16.999, 17, 17.001, 41.999, 42.001})
        depth, colors = scene()
        cls.renders = [{"width": WIDTH, "height": HEIGHT, "lens": LENS, "splat": splat, "pose": pose,
                        "pivot": pivot, **frame, "depth": depth.flatten().tolist(), "colors": colors.flatten().tolist()}
                       for splat, pose, pivot, frame in ((1, POSES[0], None, {}), (1, POSES[1], None, {}),
                                                         (0, POSES[3], None, {}), (1, POSES[2], OFF_AXIS, {}),
                                                         (1, POSES[1], OFF_AXIS, FRAME),
                                                         (1, POSES[1], None, {"markers": True}),
                                                         (1, POSES[2], OFF_AXIS, {"markers": True}))]
        job = {"path": PATH, "frames": frames, "cameras": CAMERAS, "pivot_z": PIVOT_Z, "renders": cls.renders}
        result = subprocess.run(["node", str(SCRIPT)], input=json.dumps(job), capture_output=True,
                                text=True, cwd=SCRIPT.parent)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.frames = frames
        cls.answer = json.loads(result.stdout)
        cls.path = trajectory.parse_path(json.dumps(PATH))

    def test_interpolation_matches(self):
        for frame, javascript in zip(self.frames, self.answer["poses"]):
            python = trajectory.pose_at(self.path, frame)
            for name in trajectory.AXES:
                self.assertAlmostEqual(python[name], javascript[name], places=12, msg=f"frame {frame} {name}")
            for name in trajectory.PIVOT_AXES:
                self.assertAlmostEqual(python["pivot"][name], javascript["pivot"][name], places=12,
                                       msg=f"frame {frame} pivot {name}")

    def test_orbit_matrices_match(self):
        for camera, javascript in zip(CAMERAS, self.answer["cameras"]):
            pivot = camera.get("pivot", PIVOT_Z)
            python = render.orbit_matrix(camera["pose"], pivot, camera.get("tilt", 0.0), camera.get("roll", 0.0))
            for column, values in enumerate(javascript):
                self.assertTrue(np.allclose(python[:3, column], values, atol=1e-12),
                                msg=f"{camera} column {column}: {python[:3, column]} != {values}")

    def test_serialization_matches(self):
        self.assertEqual(json.loads(self.answer["serialized"]), json.loads(trajectory.dumps(self.path)))

    def test_resolved_pivot_cameras_match(self):
        for frame, javascript in zip(self.frames, self.answer["resolvedCameras"]):
            python = render.pose_matrix(trajectory.pose_at(self.path, frame), PIVOT_Z)
            self.assertTrue(np.allclose(python[:3, :].T, javascript, atol=1e-12, rtol=0), msg=f"frame {frame}")

    def test_lattice_matches(self):
        points, colors = render.marker_lattice(PIVOT_Z)
        javascript = self.answer["lattice"]
        self.assertEqual(points.shape[0], len(javascript["points"]))
        # The browser keeps its cloud in float32, so compare at that precision.
        self.assertTrue(np.allclose(points.astype(np.float32), np.array(javascript["points"], dtype=np.float32),
                                    atol=1e-6))
        expected = np.floor(colors * 255.0 + 0.5).astype(np.int64).flatten()
        self.assertLessEqual(int(np.abs(expected - np.array(javascript["colors"])).max()), 1)

    def test_reprojection_matches(self):
        depth, colors = scene()
        geometry = render.PointCloud.from_frame(point_map(depth), None, colors.float() / 255.0)
        lattice = render.PointCloud.lattice(PIVOT_Z, geometry.points.device)
        lens = (LENS["fx"], LENS["fy"], LENS["cx"], LENS["cy"])
        for job, javascript in zip(self.renders, self.answer["renders"]):
            with self.subTest(pose=job["pose"], splat=job["splat"], markers=job.get("markers", False)):
                cloud = geometry.joined(lattice) if job.get("markers") else geometry
                self.assertEqual(cloud.points.shape[0], javascript["points"])
                matrix = render.orbit_matrix(job["pose"], job["pivot"] if job["pivot"] is not None else PIVOT_Z,
                                             job.get("tilt", 0.0), job.get("roll", 0.0))
                rgb, hole = cloud.render(matrix, lens, (WIDTH, HEIGHT), job["splat"])
                python = (rgb * 255.0).round().to(torch.int64).reshape(-1, 3)
                other = torch.tensor(javascript["pixels"], dtype=torch.int64).reshape(-1, 3)
                # A point sitting exactly on a pixel edge can round either way: the browser
                # projects in float64 and torch in float32. Everything else must agree.
                mismatch = int((python != other).any(dim=-1).sum())
                self.assertLessEqual(mismatch, 0.005 * WIDTH * HEIGHT)
                self.assertAlmostEqual(float(hole.float().mean()), javascript["holes"], delta=0.005)


if __name__ == "__main__":
    unittest.main()
