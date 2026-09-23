"""Virtual camera math and point-cloud reprojection.

Everything is in the MoGe / OpenCV camera frame: +x right, +y down, +z into the
scene, source camera at the origin looking down +z. Camera poses are relative
to their pivot's position and orbit frame, using a shared automatic-depth unit:

    azimuth    degrees around the pivot, + orbits the camera to the right
    elevation  degrees around the pivot, + raises the camera
    distance   orbit radius as a multiple of the shared automatic depth
    lateral    truck: slides the camera along its own right axis, in units of pivot depth
    height     boom: raises the camera straight up, in units of pivot depth

The pivot starts centred in the camera's frame. lateral and height translate the
camera without re-aiming it, so the subject moves across the frame. A reset camera
reproduces the source only with the automatic, unturned pivot.

The orbit/look-at construction follows ComfyUI-CrossViewWarp (Apache-2.0), by way
of the Camera H3 depth warp. js/geometry.js mirrors it for the live preview.
"""
import math

import numpy as np
import torch

EPS = 1e-6
SPLAT_BIAS = 1e-4


def splat_bias(dy: int, dx: int) -> float:
    """Depth multiplier that makes the centre of a splat outrank its own skirt."""
    return 1.0 + SPLAT_BIAS * (dy * dy + dx * dx)


def _rot_x(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _rot_y(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _rot_z(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def look_at(eye, target, down=(0.0, 1.0, 0.0)) -> np.ndarray:
    """Camera-to-world matrix whose columns are right, down, forward, eye.

    ``down`` is the reference the camera's own down is squared against; world down
    unless the orbit frame says otherwise.
    """
    forward = np.asarray(target, dtype=np.float64) - np.asarray(eye, dtype=np.float64)
    forward = forward / max(np.linalg.norm(forward), 1e-12)
    right = np.cross(np.asarray(down, dtype=np.float64), forward)
    length = np.linalg.norm(right)
    if length < 1e-6:
        # Straight up or down: the down reference is degenerate, roll around z instead.
        right = np.cross([0.0, 0.0, 1.0], forward)
        length = np.linalg.norm(right)
    right = right / max(length, 1e-12)
    c2w = np.eye(4)
    c2w[:3, 0] = right
    c2w[:3, 1] = np.cross(forward, right)
    c2w[:3, 2] = forward
    c2w[:3, 3] = eye
    return c2w


def pivot_point(pivot) -> np.ndarray:
    """Pivot as a 3-vector. A bare number is a depth on the optical axis."""
    if np.ndim(pivot) == 0:
        return np.array([0.0, 0.0, float(pivot)])
    return np.asarray(pivot, dtype=np.float64).reshape(3)


def orbit_frame(tilt: float, roll: float, heading: float = 0.0) -> np.ndarray:
    """Rotation from the source camera's axes to a pivot's orbit frame.

    A shot that was pitched down or rolled has an image vertical that is not the
    scene's vertical, so orbiting about it looks tilted. The pivot's ``tilt`` and
    ``roll`` (degrees, same sense as the camera's) straighten the frame the orbit
    happens in. Heading turns azimuth-zero about that corrected up axis.
    """
    tilt, roll = float(tilt), float(roll)
    if not tilt and not roll and not heading:
        return np.eye(3)
    return _rot_z(math.radians(roll)) @ _rot_x(math.radians(tilt)) @ _rot_y(math.radians(-heading))


def orbit_matrix(pose: dict, pivot, tilt: float = 0.0, roll: float = 0.0, unit=None, heading: float = 0.0) -> np.ndarray:
    """Pose dict + pivot (3-vector, or a depth on the axis) -> camera-to-world matrix.

    The camera inherits the pivot frame, then orbits at radius ``distance * unit``.
    Azimuth turns about the frame's up, elevation about its right, and boom runs
    along its up. A scalar pivot supplies its own unit; a vector defaults to unit 1.
    ``pose_matrix`` supplies the shared automatic depth explicitly.

    Truck and boom slide the camera and its target together, so the lens holds its
    direction and the subject travels across the frame. ``lock`` blends the target
    back onto the pivot, which keeps the subject centred instead; it is a number
    rather than a flag so a keyframe can ease between the two. ``pan``, ``tilt`` and
    ``roll`` then re-aim the camera about its own axes, on top of whatever lock decided.
    ``dolly`` finally translates along the resulting forward axis without re-aiming.
    """
    if unit is None:
        unit = float(pivot) if np.isscalar(pivot) else 1.0
    pivot = pivot_point(pivot)
    frame = orbit_frame(tilt, roll, heading)
    orbit = _rot_y(math.radians(-pose["azimuth"])) @ _rot_x(math.radians(-pose["elevation"]))
    rotation = frame @ orbit
    distance = float(pose["distance"])
    eye = pivot + distance * unit * (rotation @ np.array([0.0, 0.0, -1.0]))
    # Unlocked translations carry the target along with the camera.
    carried = np.zeros(3)
    height, lateral = float(pose.get("height", 0.0)), float(pose.get("lateral", 0.0))
    if height or lateral:
        right = rotation @ np.array([1.0, 0.0, 0.0])
        up = frame @ np.array([0.0, -1.0, 0.0])
        shift = height * unit * up + lateral * unit * right
        eye = eye + shift
        carried = carried + shift
    target = pivot + (1.0 - float(pose.get("lock", 0.0))) * carried
    # The camera's own down, carried with it, is the roll reference: a locked camera
    # then stays level in the orbit frame rather than in the image frame.
    down = rotation @ np.array([0.0, 1.0, 0.0])
    camera = aim(look_at(eye, target, down), pose.get("pan", 0.0), pose.get("tilt", 0.0), pose.get("roll", 0.0))
    camera[:3, 3] += float(pose.get("dolly", 0.0)) * unit * camera[:3, 2]
    return camera


def aim(c2w: np.ndarray, pan: float, tilt: float, roll: float = 0.0) -> np.ndarray:
    """Turn a camera about its own axes, leaving its position alone.

    Pan rotates about the camera's vertical, tilt about its right axis and roll about
    its forward axis, so positive values aim right, aim up and roll clockwise
    respectively regardless of where the camera is.
    """
    pan, tilt, roll = float(pan), float(tilt), float(roll)
    if not pan and not tilt and not roll:
        return c2w
    turned = c2w.copy()
    turned[:3, :3] = (c2w[:3, :3] @ _rot_y(math.radians(pan)) @ _rot_x(math.radians(tilt))
                      @ _rot_z(math.radians(roll)))
    return turned


def pose_matrix(pose: dict, unit: float) -> np.ndarray:
    """Camera-to-world for a pose from ``trajectory.pose_at``, whose pivot is in units of ``unit``."""
    pivot = pose["pivot"]
    return orbit_matrix(pose, [pivot["x"] * unit, pivot["y"] * unit, pivot["z"] * unit],
                        pivot.get("tilt", 0.0), pivot.get("roll", 0.0), unit, pivot.get("heading", 0.0))


def world_to_camera(c2w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rotation = c2w[:3, :3]
    return rotation.T, -rotation.T @ c2w[:3, 3]


def pivot_depth(depth: torch.Tensor, valid: torch.Tensor) -> float:
    """Orbit centre: the lower quartile of the depth across the central region.

    Framing puts the subject near the middle, and the lower quartile lands on it
    rather than on the backdrop behind it.
    """
    height, width = depth.shape
    central = torch.zeros_like(valid)
    central[height // 8:4 * height // 5, width // 5:4 * width // 5] = True
    picked = valid & central
    if not bool(picked.any()):
        picked = valid
    values = depth[picked]
    if values.numel() == 0:
        return 1.0
    return max(float(values.kthvalue(max(1, values.numel() // 4)).values), 1e-3)


def estimate_focal(points: torch.Tensor, valid: torch.Tensor, width: int, height: int) -> tuple[float, float]:
    """Least-squares focal in pixels from a point map, for geometry without intrinsics.

    Exact for a perspective point map, a sane average for anything else. Falls
    back to a 60 degree horizontal lens when the fit has nothing to work with.
    """
    fallback = width / (2.0 * math.tan(math.radians(60.0) / 2.0))
    rows, cols = valid.nonzero(as_tuple=True)
    if rows.numel() < 64:
        return fallback, fallback
    picked = points[rows, cols].double()
    z = picked[:, 2]
    focal = []
    for axis, index, size in ((cols, 0, width), (rows, 1, height)):
        offset = axis.double() + 0.5 - size / 2.0
        a = offset * z
        denominator = float((a * picked[:, index]).sum())
        value = float((a * a).sum()) / denominator if abs(denominator) > 1e-9 else 0.0
        focal.append(value if math.isfinite(value) and value > 1.0 else fallback)
    return focal[0], focal[1]


#: The marker lattice, in units of the automatic pivot depth. Spacing between grid
#: steps; the box it fills, as a centre and a half-width per axis; the anchor sphere
#: the stagger is counted from; the radius of a sphere and the number of points on its
#: surface. js/geometry.js repeats these; test_parity checks the result.
#:
#: The box is centred on the pivot plane -- the automatic pivot sits at (0, 0, 1) --
#: and is as deep as it is wide, so a camera that orbits all the way round finds as
#: many markers looking back at the source as looking out from it. The anchor is the
#: sphere dead ahead of the source camera, half a unit out; counting the stagger from a
#: fixed sphere rather than from the box corner means resizing the box never changes
#: which half moves.
LATTICE_SPACING = 1.0
LATTICE_CENTRE = (0.0, 0.0, 1.0)
LATTICE_HALF = (3.0, 3.0, 3.0)
LATTICE_ANCHOR = (0.0, 0.0, 0.5)
LATTICE_RADIUS = 0.015
LATTICE_POINTS = 24

#: Golden angle; a Fibonacci spiral built on it spreads points evenly over a sphere.
GOLDEN = math.pi * (3.0 - math.sqrt(5.0))

#: Where the lattice's shading light comes from: above, left and behind the camera.
LATTICE_LIGHT = (-0.45, -0.7, -0.55)


def marker_lattice(unit: float) -> tuple[np.ndarray, np.ndarray]:
    """Small spheres on a staggered grid through the scene, as points to splat.

    They share the geometry's space, so the z-buffer occludes them behind the
    subject and perspective shrinks them with distance -- exactly the parallax cues
    a downstream video model can use.

    The grid is a 3D checkerboard: counting whole steps from ``LATTICE_ANCHOR``,
    every sphere whose steps sum to an odd number is moved half a spacing along
    +x, +y and +z, and every sphere that lands inside the box is kept. The
    density is the same as a plain grid's -- one sphere per cubic spacing -- but no axis line
    carries more than every other sphere, and the moved half fills the lines between
    them, so spheres do not stack behind one another along any axis -- least of all
    the source camera's view direction. It is a diamond lattice: every sphere has
    four nearest neighbours, evenly spread. Each sphere is coloured by where it is
    (x -> red, y -> green, z -> blue) so a marker keeps one colour throughout a
    move and its travel across the frame is readable.

    Returns ``(points, colors)``: float64 ``[N, 3]`` in world units and ``[N, 3]``
    in 0..1. Deterministic, so the JavaScript mirror produces the same points.
    """
    low = [c - h for c, h in zip(LATTICE_CENTRE, LATTICE_HALF)]
    high = [c + h for c, h in zip(LATTICE_CENTRE, LATTICE_HALF)]
    # Whole steps from the anchor that could reach the box; the box test below trims.
    steps = [range(math.floor((low[a] - LATTICE_ANCHOR[a]) / LATTICE_SPACING) - 1,
                   math.ceil((high[a] - LATTICE_ANCHOR[a]) / LATTICE_SPACING) + 1)
             for a in range(3)]
    surface = np.empty((LATTICE_POINTS, 3))
    for i in range(LATTICE_POINTS):
        y = 1.0 - 2.0 * (i + 0.5) / LATTICE_POINTS
        r = math.sqrt(1.0 - y * y)
        angle = i * GOLDEN
        surface[i] = (r * math.cos(angle), y, r * math.sin(angle))
    lit = 0.7 + 0.3 * np.clip(surface @ np.array(LATTICE_LIGHT), 0.0, None)

    points, colors = [], []
    for k in steps[2]:
        for j in steps[1]:
            for i in steps[0]:
                cell = (i, j, k)
                shift = 0.5 * ((i + j + k) % 2)
                centre = np.array([LATTICE_ANCHOR[a] + (cell[a] + shift) * LATTICE_SPACING
                                   for a in range(3)])
                if not all(low[a] - 1e-9 <= centre[a] <= high[a] + 1e-9 for a in range(3)):
                    continue
                tint = np.array([0.35 + 0.6 * (centre[a] - low[a]) / (high[a] - low[a]) for a in range(3)])
                points.append((centre + surface * LATTICE_RADIUS) * unit)
                colors.append(tint * lit[:, None])
    return np.concatenate(points), np.clip(np.concatenate(colors), 0.0, 1.0)


class PointCloud:
    """Coloured points of one source frame, in the source camera frame."""

    def __init__(self, points: torch.Tensor, colors: torch.Tensor):
        self.points = points
        self.colors = colors

    @classmethod
    def from_frame(cls, points_map: torch.Tensor, mask, rgb: torch.Tensor) -> "PointCloud":
        valid = torch.isfinite(points_map).all(dim=-1) & (points_map[..., 2] > EPS)
        if mask is not None:
            valid = valid & mask
        flat = valid.reshape(-1)
        return cls(points_map.reshape(-1, 3)[flat], rgb.reshape(-1, 3)[flat])

    @classmethod
    def lattice(cls, unit: float, device) -> "PointCloud":
        """The marker lattice as a cloud on ``device``, ready to append."""
        points, colors = marker_lattice(unit)
        return cls(torch.as_tensor(points, dtype=torch.float32, device=device),
                   torch.as_tensor(colors, dtype=torch.float32, device=device))

    def joined(self, other: "PointCloud") -> "PointCloud":
        """This cloud followed by another, so both splat through one z-buffer."""
        return PointCloud(torch.cat([self.points, other.points]), torch.cat([self.colors, other.colors]))

    def render(self, c2w: np.ndarray, intrinsics: tuple, size: tuple[int, int], splat: int = 1):
        """-> (rgb float32 [H, W, 3], hole bool [H, W]) seen from the given camera.

        Every point is splatted over a (2*splat+1)^2 window and the nearest one
        wins each pixel, so the far side of the scene cannot paint over the near
        side. Pixels no point reached at all are holes. Depth is biased outwards
        across the window, so a point owns its own pixel whenever a neighbour is
        at the same distance; without that a flat wall comes out shifted by the
        last splat offset.
        """
        width, height = size
        fx, fy, cx, cy = intrinsics
        device = self.points.device
        rotation, translation = world_to_camera(c2w)
        rotation = torch.as_tensor(rotation, dtype=torch.float32, device=device)
        translation = torch.as_tensor(translation, dtype=torch.float32, device=device)

        camera = self.points @ rotation.T + translation
        z = camera[:, 2]
        front = z > EPS
        camera, colors, z = camera[front], self.colors[front], z[front]
        u = camera[:, 0] / z * fx + cx
        v = camera[:, 1] / z * fy + cy
        # Points behind a grazing edge project arbitrarily far out; keep the cast to int sane.
        on_canvas = torch.isfinite(u) & torch.isfinite(v) & (u.abs() < 1e7) & (v.abs() < 1e7)
        column = torch.where(on_canvas, u, torch.zeros_like(u)).floor().long()
        row = torch.where(on_canvas, v, torch.zeros_like(v)).floor().long()

        pixels = width * height
        offsets = [(dy, dx) for dy in range(-splat, splat + 1) for dx in range(-splat, splat + 1)]

        def target_index(dy, dx):
            tx, ty = column + dx, row + dy
            inside = on_canvas & (tx >= 0) & (tx < width) & (ty >= 0) & (ty < height)
            return torch.where(inside, ty * width + tx, torch.full_like(tx, pixels))

        # One extra slot swallows everything off canvas, so no pass needs a compaction step.
        zbuffer = torch.full((pixels + 1,), float("inf"), dtype=torch.float32, device=device)
        for dy, dx in offsets:
            zbuffer.scatter_reduce_(0, target_index(dy, dx), z * splat_bias(dy, dx), reduce="amin",
                                    include_self=True)
        image = torch.zeros((pixels + 1, 3), dtype=torch.float32, device=device)
        covered = torch.zeros(pixels + 1, dtype=torch.bool, device=device)
        for dy, dx in offsets:
            index = target_index(dy, dx)
            winner = z * splat_bias(dy, dx) == zbuffer[index]
            image[index[winner]] = colors[winner]
            covered[index] = True
        return image[:pixels].reshape(height, width, 3), ~covered[:pixels].reshape(height, width)
