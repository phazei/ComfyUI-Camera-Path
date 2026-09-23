import math
import unittest

import numpy as np
import torch

from .context import render, trajectory

WIDTH, HEIGHT = 64, 48
FX = FY = 80.0
CX, CY = WIDTH / 2.0, HEIGHT / 2.0
LENS = (FX, FY, CX, CY)


def pose(**overrides):
    base = dict(trajectory.DEFAULTS)
    base.update(overrides)
    return base


def point_map(depth):
    """MoGe-style point map: pixel centres unprojected through LENS."""
    rows = torch.arange(HEIGHT, dtype=torch.float32)[:, None] + 0.5
    columns = torch.arange(WIDTH, dtype=torch.float32)[None, :] + 0.5
    return torch.stack([(columns - CX) / FX * depth, (rows - CY) / FY * depth, depth], dim=-1)


def project(c2w, world):
    rotation, translation = render.world_to_camera(c2w)
    camera = rotation @ np.asarray(world, dtype=np.float64) + translation
    return camera[0] / camera[2] * FX + CX, camera[1] / camera[2] * FY + CY


class CameraMath(unittest.TestCase):
    def test_dolly_keyframes_follow_a_straight_line(self):
        p = pose(azimuth=20, pan=65, tilt=-15, lateral=0.2, lock=1)
        path = trajectory.parse_path([{**p, "frame": 0, "dolly": -0.5},
                                      {**p, "frame": 10, "dolly": 0.5}])
        path = trajectory.parse_path(trajectory.dumps(path))
        start = render.pose_matrix(trajectory.pose_at(path, 0), 2)
        end = render.pose_matrix(trajectory.pose_at(path, 10), 2)
        for frame in range(11):
            resolved = trajectory.pose_at(path, frame)
            camera = render.pose_matrix(resolved, 2)
            fraction = resolved["dolly"] + 0.5
            self.assertGreaterEqual(fraction, 0)
            self.assertLessEqual(fraction, 1)
            np.testing.assert_allclose(camera[:3, :3], start[:3, :3], atol=1e-12, rtol=0)
            np.testing.assert_allclose(camera[:3, 3], start[:3, 3] + (end[:3, 3] - start[:3, 3]) * fraction,
                                       atol=1e-12, rtol=0)

    def test_dolly_moves_along_final_aim_without_turning(self):
        for lock in (0, 0.5, 1):
            p = pose(azimuth=35, elevation=-12, lateral=0.3, height=-0.2,
                     pan=50, tilt=20, roll=27, lock=lock)
            base = render.orbit_matrix(p, [2, -1, 4], -25, 12, unit=2, heading=65)
            for dolly in (-2, 0, 0.5, 3):
                moved = render.orbit_matrix({**p, "dolly": dolly}, [2, -1, 4], -25, 12, unit=2, heading=65)
                np.testing.assert_allclose(moved[:3, :3], base[:3, :3], atol=1e-12, rtol=0)
                np.testing.assert_allclose(moved[:3, 3], base[:3, 3] + base[:3, 2] * dolly * 2,
                                           atol=1e-12, rtol=0)

    def test_heading_offsets_azimuth_in_the_corrected_frame(self):
        for heading in (-180, 35, 450):
            for azimuth in (0, 25):
                p = pose(azimuth=azimuth, elevation=15, lateral=0.2, height=0.1, lock=0.5)
                headed = render.orbit_matrix(p, [2, -1, 4], -25, 12, unit=2, heading=heading)
                offset = render.orbit_matrix({**p, "azimuth": azimuth + heading}, [2, -1, 4], -25, 12, unit=2)
                self.assertTrue(np.allclose(headed, offset, atol=1e-12, rtol=0))
                self.assertTrue(np.allclose(render.orbit_frame(-25, 12, heading)[:, 1],
                                            render.orbit_frame(-25, 12)[:, 1]))

    def test_default_pose_is_the_source_camera(self):
        matrix = render.orbit_matrix(pose(), 2.0)
        self.assertTrue(np.allclose(matrix, np.eye(4), atol=1e-9))

    def test_pivot_stays_centred_while_orbiting(self):
        for azimuth, elevation in ((25.0, 0.0), (0.0, 20.0), (-40.0, -10.0)):
            with self.subTest(azimuth=azimuth, elevation=elevation):
                u, v = project(render.orbit_matrix(pose(azimuth=azimuth, elevation=elevation), 2.0), [0, 0, 2])
                self.assertAlmostEqual(u, CX, places=6)
                self.assertAlmostEqual(v, CY, places=6)

    def test_distance_uses_the_same_unit_for_every_pivot(self):
        for pivot in ([-0.6, 0.3, 1.7], [4, -2, 20]):
            matrix = render.orbit_matrix(pose(), pivot, unit=2.0)
            self.assertTrue(np.allclose(matrix[:3, 3], np.array(pivot) - [0, 0, 2]))
            self.assertAlmostEqual(np.linalg.norm(matrix[:3, 3] - pivot), 2.0)

    def test_an_off_axis_pivot_is_centred_while_orbiting(self):
        pivot = [-0.6, 0.3, 1.7]
        home = project(np.eye(4), pivot)
        self.assertNotAlmostEqual(home[0], CX)
        for azimuth, elevation, distance in ((30.0, 0.0, 1.0), (0.0, -20.0, 1.0), (-45.0, 15.0, 1.0)):
            with self.subTest(azimuth=azimuth, elevation=elevation):
                u, v = project(render.orbit_matrix(pose(azimuth=azimuth, elevation=elevation), pivot), pivot)
                self.assertAlmostEqual(u, CX, places=6)
                self.assertAlmostEqual(v, CY, places=6)

    def test_a_depth_and_an_on_axis_vector_are_the_same_pivot(self):
        for p in (pose(azimuth=20.0, elevation=-5.0, lateral=0.2, lock=0.5), pose(distance=0.5, pan=8.0)):
            self.assertTrue(np.allclose(render.orbit_matrix(p, 2.0), render.orbit_matrix(p, [0.0, 0.0, 2.0], unit=2.0),
                                        atol=1e-12))

    def test_a_reset_camera_inherits_the_pivot_frame(self):
        matrix = render.orbit_matrix(pose(), [-0.6, 0.3, 1.7], tilt=-25.0, roll=8.0)
        frame = render.orbit_frame(-25.0, 8.0)
        self.assertTrue(np.allclose(matrix[:3, :3], frame, atol=1e-8))
        self.assertTrue(np.allclose(matrix[:3, 3], np.array([-0.6, 0.3, 1.7]) - frame[:, 2]))

    def test_the_orbit_happens_about_the_frames_axes(self):
        # Azimuth turns about the frame's up. With the frame rolled 90 degrees that up
        # is the image's x axis, so an azimuth sweep moves the camera vertically.
        pivot = [0.0, 0.0, 2.0]
        flat = render.orbit_matrix(pose(azimuth=30.0), pivot)
        rolled = render.orbit_matrix(pose(azimuth=30.0), pivot, roll=90.0)
        self.assertAlmostEqual(flat[1, 3], 0.0, places=9)
        self.assertNotAlmostEqual(flat[0, 3], 0.0)
        self.assertAlmostEqual(rolled[0, 3], 0.0, places=9)
        self.assertAlmostEqual(abs(rolled[1, 3]), abs(flat[0, 3]), places=9)
        # And the pivot still projects to the same pixel either way.
        self.assertTrue(np.allclose(project(rolled, pivot), project(flat, pivot), atol=1e-9))

    def test_boom_follows_the_frames_up(self):
        pivot = [0.0, 0.0, 2.0]
        matrix = render.orbit_matrix(pose(height=0.5), pivot, tilt=90.0)
        # Tilted a quarter turn, the frame's up points along the image's z, so the boom goes in.
        base = render.orbit_matrix(pose(), pivot, tilt=90.0)
        self.assertTrue(np.allclose(matrix[:3, 3] - base[:3, 3], [0, 0, -0.5]))

    def test_pose_matrix_scales_the_pivot_by_the_unit(self):
        pose_ = {**pose(azimuth=20.0), "pivot": {"x": 0.1, "y": -0.2, "z": 0.9, "tilt": 5.0, "roll": -3.0}}
        self.assertTrue(np.allclose(render.pose_matrix(pose_, 2.0),
                                    render.orbit_matrix(pose_, [0.2, -0.4, 1.8], 5.0, -3.0, unit=2.0), atol=1e-12))

    def test_locking_centres_an_off_axis_pivot(self):
        u, v = project(render.orbit_matrix(pose(lock=1.0), [-0.6, 0.3, 1.7]), [-0.6, 0.3, 1.7])
        self.assertAlmostEqual(u, CX, places=6)
        self.assertAlmostEqual(v, CY, places=6)

    def test_orbiting_right_parallaxes_the_foreground_left(self):
        matrix = render.orbit_matrix(pose(azimuth=15.0), 2.0)
        self.assertLess(project(matrix, [0, 0, 1])[0], CX)
        self.assertGreater(project(matrix, [0, 0, 6])[0], CX)

    def test_raising_elevation_parallaxes_the_foreground_down(self):
        matrix = render.orbit_matrix(pose(elevation=15.0), 2.0)
        self.assertGreater(project(matrix, [0, 0, 1])[1], CY)
        self.assertLess(project(matrix, [0, 0, 6])[1], CY)

    def test_boom_and_truck_translate_without_re_aiming(self):
        up = render.orbit_matrix(pose(height=0.25), 2.0)
        right = render.orbit_matrix(pose(lateral=0.25), 2.0)
        self.assertTrue(np.allclose(up[:3, :3], np.eye(3), atol=1e-9))
        self.assertTrue(np.allclose(right[:3, :3], np.eye(3), atol=1e-9))
        self.assertAlmostEqual(up[1, 3], -0.5, places=9)
        self.assertAlmostEqual(right[0, 3], 0.5, places=9)
        self.assertGreater(project(up, [0, 0, 2])[1], CY)
        self.assertLess(project(right, [0, 0, 2])[0], CX)

    def test_locking_on_target_re_aims_at_the_pivot(self):
        # Trucking and booming slide the subject out of frame; lock brings it back.
        off_centre = lambda matrix: math.hypot(*(np.array(project(matrix, [0, 0, 2])) - [CX, CY]))
        for axis in ("lateral", "height"):
            with self.subTest(axis=axis):
                free = render.orbit_matrix(pose(**{axis: 0.35}), 2.0)
                locked = render.orbit_matrix(pose(lock=1.0, **{axis: 0.35}), 2.0)
                self.assertGreater(off_centre(free), 1.0)
                self.assertAlmostEqual(off_centre(locked), 0.0, places=6)
                # The camera itself has not moved, only its aim.
                self.assertTrue(np.allclose(free[:3, 3], locked[:3, 3], atol=1e-9))

    def test_lock_eases_between_free_and_locked(self):
        # Stored as a number, not a flag, so a keyframe can ease into being locked.
        offsets = [abs(project(render.orbit_matrix(pose(lateral=0.35, lock=lock), 2.0), [0, 0, 2])[0] - CX)
                   for lock in (0.0, 0.5, 1.0)]
        self.assertGreater(offsets[0], offsets[1])
        self.assertGreater(offsets[1], offsets[2])

    def test_pan_and_tilt_aim_right_and_up(self):
        # Aiming right pushes what was centred to the left of frame, and vice versa.
        self.assertLess(project(render.orbit_matrix(pose(pan=20.0), 2.0), [0, 0, 2])[0], CX)
        self.assertGreater(project(render.orbit_matrix(pose(tilt=20.0), 2.0), [0, 0, 2])[1], CY)

    def test_roll_turns_the_frame_clockwise_about_the_lens(self):
        matrix = render.orbit_matrix(pose(roll=30.0), 2.0)
        # The centre of frame is untouched. The camera body rolls clockwise, so the scene
        # appears to turn the other way: what was to the right rises above centre.
        u, v = project(matrix, [0, 0, 2])
        self.assertAlmostEqual(u, CX, places=6)
        self.assertAlmostEqual(v, CY, places=6)
        _, right_v = project(matrix, [0.5, 0, 2])
        self.assertLess(right_v, CY)
        self.assertTrue(np.allclose(matrix[:3, 3], 0.0, atol=1e-12))

    def test_aim_leaves_the_camera_where_it_was(self):
        plain = render.orbit_matrix(pose(azimuth=35.0, elevation=10.0, lateral=0.2), 2.0)
        turned = render.orbit_matrix(pose(azimuth=35.0, elevation=10.0, lateral=0.2,
                                          pan=15.0, tilt=-8.0), 2.0)
        self.assertTrue(np.allclose(plain[:3, 3], turned[:3, 3], atol=1e-12))
        self.assertAlmostEqual(abs(float(np.linalg.det(turned[:3, :3]))), 1.0, places=9)

    def test_a_zero_aim_changes_nothing(self):
        matrix = render.orbit_matrix(pose(azimuth=12.0), 2.0)
        self.assertTrue(np.allclose(render.aim(matrix, 0.0, 0.0), matrix, atol=1e-15))

    def test_pulling_back_shrinks_the_frame(self):
        subject = [0.5, 0.0, 2.0]
        near, _ = project(render.orbit_matrix(pose(), 2.0), subject)
        far, _ = project(render.orbit_matrix(pose(distance=2.0), 2.0), subject)
        self.assertLess(abs(far - CX), abs(near - CX))

    def test_looking_straight_down_keeps_a_usable_basis(self):
        matrix = render.look_at(np.array([0.0, -3.0, 0.0]), np.zeros(3))
        self.assertAlmostEqual(abs(float(np.linalg.det(matrix[:3, :3]))), 1.0, places=9)


class Geometry(unittest.TestCase):
    def test_focal_is_recovered_from_a_point_map(self):
        points = point_map(torch.full((HEIGHT, WIDTH), 2.0) + torch.rand(HEIGHT, WIDTH))
        fx, fy = render.estimate_focal(points, torch.ones(HEIGHT, WIDTH, dtype=torch.bool), WIDTH, HEIGHT)
        self.assertAlmostEqual(fx, FX, places=3)
        self.assertAlmostEqual(fy, FY, places=3)

    def test_focal_falls_back_without_enough_geometry(self):
        points = point_map(torch.full((HEIGHT, WIDTH), 2.0))
        fx, _ = render.estimate_focal(points, torch.zeros(HEIGHT, WIDTH, dtype=torch.bool), WIDTH, HEIGHT)
        self.assertAlmostEqual(fx, WIDTH / (2 * math.tan(math.radians(30.0))), places=6)

    def test_pivot_follows_the_subject_not_the_backdrop(self):
        depth = torch.full((HEIGHT, WIDTH), 9.0)
        depth[HEIGHT // 3:2 * HEIGHT // 3, WIDTH // 3:2 * WIDTH // 3] = 2.0
        pivot = render.pivot_depth(depth, torch.ones(HEIGHT, WIDTH, dtype=torch.bool))
        self.assertAlmostEqual(pivot, 2.0, places=6)

    def test_pivot_ignores_geometry_outside_the_frame_centre(self):
        depth = torch.full((HEIGHT, WIDTH), 5.0)
        depth[:, :WIDTH // 8] = 0.5
        pivot = render.pivot_depth(depth, torch.ones(HEIGHT, WIDTH, dtype=torch.bool))
        self.assertAlmostEqual(pivot, 5.0, places=6)

    def test_pivot_is_positive_without_any_valid_depth(self):
        depth = torch.full((HEIGHT, WIDTH), 3.0)
        self.assertGreater(render.pivot_depth(depth, torch.zeros(HEIGHT, WIDTH, dtype=torch.bool)), 0.0)


class Rendering(unittest.TestCase):
    def cloud(self, depth, mask=None, colors=None):
        points = point_map(depth)
        if colors is None:
            colors = torch.rand(HEIGHT, WIDTH, 3)
        return render.PointCloud.from_frame(points, mask, colors), colors

    def test_default_pose_reproduces_the_source(self):
        cloud, colors = self.cloud(torch.full((HEIGHT, WIDTH), 2.0))
        rgb, hole = cloud.render(render.orbit_matrix(pose(), 2.0), LENS, (WIDTH, HEIGHT), 1)
        self.assertTrue(torch.equal(rgb, colors))
        self.assertFalse(bool(hole.any()))

    def test_masked_pixels_become_holes(self):
        mask = torch.ones(HEIGHT, WIDTH, dtype=torch.bool)
        mask[:, :8] = False
        cloud, _ = self.cloud(torch.full((HEIGHT, WIDTH), 2.0), mask)
        _, hole = cloud.render(render.orbit_matrix(pose(), 2.0), LENS, (WIDTH, HEIGHT), 1)
        # The splat reaches one pixel past the masked edge.
        self.assertTrue(bool(hole[:, :7].all()))
        self.assertFalse(bool(hole[:, 9:].any()))

    def test_holes_are_painted_the_background(self):
        mask = torch.ones(HEIGHT, WIDTH, dtype=torch.bool)
        mask[:, :8] = False
        cloud, colors = self.cloud(torch.full((HEIGHT, WIDTH), 2.0), mask)
        rgb, hole = cloud.render(render.orbit_matrix(pose(), 2.0), LENS, (WIDTH, HEIGHT), 1, (1.0, 0.0, 1.0))
        self.assertTrue(torch.equal(rgb[hole], torch.tensor([1.0, 0.0, 1.0]).expand(int(hole.sum()), 3)))
        # Past the splat's reach into the masked edge, the geometry is untouched.
        self.assertTrue(torch.equal(rgb[:, 9:], colors[:, 9:]))

    def test_hex_colours_parse(self):
        self.assertEqual(render.hex_color("#ff00ff"), (1.0, 0.0, 1.0))
        self.assertEqual(render.hex_color("F0F"), (1.0, 0.0, 1.0))
        self.assertEqual(render.hex_color("#000000"), (0.0, 0.0, 0.0))
        for bad in ("", "#ff00f", "#gg0000"):
            with self.assertRaises(ValueError):
                render.hex_color(bad)

    def test_a_truck_shifts_the_image_the_other_way(self):
        colors = torch.zeros(HEIGHT, WIDTH, 3)
        colors[:, WIDTH // 2] = 1.0
        cloud, _ = self.cloud(torch.full((HEIGHT, WIDTH), 2.0), colors=colors)
        rgb, _ = cloud.render(render.orbit_matrix(pose(lateral=0.1), 2.0), LENS, (WIDTH, HEIGHT), 0)
        moved = int(rgb[HEIGHT // 2, :, 0].argmax())
        self.assertLess(moved, WIDTH // 2)
        self.assertAlmostEqual(moved, WIDTH // 2 - 0.1 * 2.0 / 2.0 * FX, delta=1.0)

    def test_the_near_surface_wins_the_pixel(self):
        depth = torch.full((HEIGHT, WIDTH), 4.0)
        depth[:, WIDTH // 2:] = 2.0
        colors = torch.zeros(HEIGHT, WIDTH, 3)
        colors[:, WIDTH // 2:] = 1.0
        cloud, _ = self.cloud(depth, colors=colors)
        # Orbiting swings the near wall over the far one; it must not be painted over.
        rgb, _ = cloud.render(render.orbit_matrix(pose(azimuth=8.0), 3.0), LENS, (WIDTH, HEIGHT), 1)
        row = rgb[HEIGHT // 2, :, 0]
        near = (row > 0.5).nonzero()
        self.assertTrue(near.numel() > 0)
        self.assertTrue(bool((row[int(near.min()):int(near.max()) + 1] > 0.5).all()))

    def test_points_behind_the_camera_are_dropped(self):
        cloud, _ = self.cloud(torch.full((HEIGHT, WIDTH), 2.0))
        behind = render.look_at(np.array([0.0, 0.0, 6.0]), np.array([0.0, 0.0, 9.0]))
        _, hole = cloud.render(behind, LENS, (WIDTH, HEIGHT), 1)
        self.assertTrue(bool(hole.all()))


class Lattice(unittest.TestCase):
    def test_scales_with_the_unit_and_stays_deterministic(self):
        one, colors = render.marker_lattice(1.0)
        two, again = render.marker_lattice(2.0)
        self.assertTrue(np.array_equal(one * 2.0, two))
        self.assertTrue(np.array_equal(colors, again))
        self.assertEqual(one.shape[0] % render.LATTICE_POINTS, 0)
        self.assertTrue(np.all((colors >= 0.0) & (colors <= 1.0)))
        # Each sphere sits on a half-spacing step from the anchor, every one of its points
        # at the radius from it.
        spheres = one.reshape(-1, render.LATTICE_POINTS, 3)
        steps, centres = self.steps(spheres)
        self.assertTrue(np.allclose(np.linalg.norm(spheres - centres[:, None], axis=-1), render.LATTICE_RADIUS, atol=1e-9))
        self.assertEqual(len({tuple(s) for s in steps}), spheres.shape[0])

    @staticmethod
    def steps(spheres):
        """Each sphere's centre in half-spacing steps from the anchor, and the centre."""
        half = 0.5 * render.LATTICE_SPACING
        anchor = np.array(render.LATTICE_ANCHOR)
        steps = np.round((spheres.mean(axis=1) - anchor) / half).astype(int)
        return steps, anchor + steps * half

    def test_the_box_is_centred_on_the_pivot_plane(self):
        _, centres = self.steps(render.marker_lattice(1.0)[0].reshape(-1, render.LATTICE_POINTS, 3))
        low = np.array(render.LATTICE_CENTRE) - render.LATTICE_HALF
        high = np.array(render.LATTICE_CENTRE) + render.LATTICE_HALF
        self.assertEqual(render.LATTICE_CENTRE, (0.0, 0.0, 1.0))
        # Filled to within half a step of every face, and nothing outside.
        half = 0.5 * render.LATTICE_SPACING
        self.assertTrue(np.all(centres.min(axis=0) >= low - 1e-9))
        self.assertTrue(np.all(centres.min(axis=0) <= low + half + 1e-9))
        self.assertTrue(np.all(centres.max(axis=0) <= high + 1e-9))
        self.assertTrue(np.all(centres.max(axis=0) >= high - half - 1e-9))
        # So a camera looking back at the source sees markers behind it too.
        self.assertTrue(np.any(centres[:, 2] < 0))

    def test_every_other_sphere_is_staggered_half_a_step_right_down_and_back(self):
        spheres = render.marker_lattice(1.0)[0].reshape(-1, render.LATTICE_POINTS, 3)
        steps, centres = self.steps(spheres)
        # A sphere is either on the anchor's grid on every axis or off it on every axis.
        odd = steps % 2
        self.assertTrue(np.all(odd == odd[:, :1]))
        # On the grid, whole steps sum even; off it, the step it was moved from sums odd.
        whole = np.where(odd == 1, (steps - 1) // 2, steps // 2).sum(axis=1)
        self.assertTrue(np.all(whole % 2 == odd[:, 0]))
        # The sphere dead ahead of the source camera is the anchor and stays put.
        self.assertIn((0, 0, 0), {tuple(s) for s in steps})
        # Same density as the plain grid it replaced: one sphere per cubic spacing. The
        # pattern repeats every two spacings, so a half-open cube of four holds 64.
        centre = np.array(render.LATTICE_CENTRE)
        inside = np.all((centres >= centre - 2 * render.LATTICE_SPACING - 1e-9)
                        & (centres < centre + 2 * render.LATTICE_SPACING - 1e-9), axis=1)
        self.assertEqual(int(inside.sum()), 64)
        # Along any axis line, neighbours are two spacings apart, never one.
        for axis in range(3):
            others = [a for a in range(3) if a != axis]
            lines = {}
            for s in steps:
                lines.setdefault(tuple(s[others]), []).append(s[axis])
            for line in lines.values():
                self.assertTrue(np.all(np.diff(sorted(line)) == 4))

    def test_the_lattice_is_occluded_by_nearer_geometry(self):
        wall, _ = Rendering.cloud(Rendering(), torch.full((HEIGHT, WIDTH), 2.0), colors=torch.zeros(HEIGHT, WIDTH, 3))
        joined = wall.joined(render.PointCloud.lattice(2.0, wall.points.device))
        rgb, hole = joined.render(render.orbit_matrix(pose(), 2.0), LENS, (WIDTH, HEIGHT), 1)
        self.assertFalse(bool(hole.any()))
        lit = (rgb > 0).any(dim=-1)
        # Spheres in front of the wall show; the ones behind it do not, so the wall is
        # neither untouched nor buried.
        self.assertGreater(float(lit.float().mean()), 0.01)
        self.assertLess(float(lit.float().mean()), 0.6)
        # Pull the wall in front of the whole lattice and every sphere disappears.
        near, _ = Rendering.cloud(Rendering(), torch.full((HEIGHT, WIDTH), 0.3), colors=torch.zeros(HEIGHT, WIDTH, 3))
        rgb, _ = near.joined(render.PointCloud.lattice(2.0, near.points.device)).render(
            render.orbit_matrix(pose(), 2.0), LENS, (WIDTH, HEIGHT), 1)
        self.assertFalse(bool((rgb > 0).any()))


if __name__ == "__main__":
    unittest.main()
