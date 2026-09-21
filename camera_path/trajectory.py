"""Camera keyframe path: JSON keyframes in, per-frame poses out.

A path is a JSON object carrying the pivots the camera can orbit and the camera
keyframes themselves, indexed by output frame:

    {
      "version": 2,
      "pivots": [{"id": "p1", "keys": [{"frame": 0, "x": 0, "y": 0, "z": 1, "tilt": 0, "roll": 0}]}],
      "camera": [{"frame": 0, "pivot": "p1", "azimuth": 0, "elevation": 0,
                  "distance": 1, "lateral": 0, "height": 0,
                  "pan": 0, "tilt": 0, "roll": 0, "lock": 0}, ...]
    }

A pivot is a point in the scene plus the frame the camera orbits it in. The point
is in units of the geometry's own pivot depth, so `(0, 0, 1)` is the automatically
found subject and a path carries over to other footage without rescaling. `tilt`
and `roll` straighten the orbit when the shot itself was pitched or rolled;
`heading` sets azimuth-zero around that corrected up axis. Its
`keys` are a track: one key today, but the shape is ready for a pivot that follows
a moving subject. A bare array of camera keyframes is the version 1 format and
still loads, orbiting the automatic pivot.

Every axis is optional and defaults to the pivot-relative reset pose, so a path
written before an axis existed still loads.

Interpolation between keyframes is monotone cubic (PCHIP) per axis, so a sparse
timeline describes a continuous camera move and never overshoots a keyframe. When
consecutive camera keys name different pivots, the pivots' resolved positions are
interpolated the same way, so the camera hands off from one subject to the next
instead of popping. js/interpolate.js is the same function, so the editor preview
matches the render.
"""
import json
import math

#: The axes of a camera pose, in the order they are written out.
AXES = ("azimuth", "elevation", "distance", "lateral", "height", "pan", "tilt", "roll", "lock", "dolly")
#: Pivot-relative reset; reproduces the source camera with the automatic pivot.
DEFAULTS = {"azimuth": 0.0, "elevation": 0.0, "distance": 1.0, "lateral": 0.0, "height": 0.0,
            "pan": 0.0, "tilt": 0.0, "roll": 0.0, "lock": 0.0, "dolly": 0.0}
#: A pivot key: position in units of the automatic pivot depth, then its frame in degrees.
PIVOT_AXES = ("x", "y", "z", "tilt", "roll", "heading")
#: The automatic pivot: on the optical axis, one pivot depth in, frame of the source camera.
PIVOT_DEFAULTS = {"x": 0.0, "y": 0.0, "z": 1.0, "tilt": 0.0, "roll": 0.0, "heading": 0.0}
#: Hidden axes the camera track carries so a pivot switch interpolates as a move.
_CARRIED = tuple("_pivot_" + name for name in PIVOT_AXES)
VERSION = 2

Pose = dict
Keyframe = dict
Pivot = dict
Path = dict


def identity_pose() -> Pose:
    """The pivot-relative reset pose."""
    return dict(DEFAULTS)


def default_pivot(identifier: str = "p1") -> Pivot:
    """A pivot sitting on the automatically found subject."""
    return {"id": identifier, "keys": [{"frame": 0, **PIVOT_DEFAULTS}]}


def default_path() -> Path:
    """A path with one source-camera keyframe on one automatic pivot."""
    pivot = default_pivot()
    return {"pivots": [pivot], "camera": [{"frame": 0, "pivot": pivot["id"], **DEFAULTS}]}


def _frame_of(item: dict, what: str) -> int:
    frame = item.get("frame")
    if frame is None or isinstance(frame, bool) or not isinstance(frame, (int, float)) or not math.isfinite(frame):
        raise ValueError(f'every {what} needs a numeric "frame" index.')
    return int(round(frame))


def _keys(items, what: str, axes, defaults) -> list[dict]:
    """Validates a list of keyed items and fills in every axis."""
    if not isinstance(items, list) or not items:
        raise ValueError(f"{what}s must be a non-empty array.")
    keys = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError(f"every {what} must be an object.")
        key = {"frame": _frame_of(item, what)}
        for name in axes:
            value = item.get(name)
            value = float(defaults[name] if value is None else value)
            if not math.isfinite(value):
                raise ValueError(f"{what} {key['frame']}: {name} is not a finite number.")
            key[name] = value
        keys.append((item, key))
    keys.sort(key=lambda pair: pair[1]["frame"])
    for (_, left), (_, right) in zip(keys, keys[1:]):
        if left["frame"] == right["frame"]:
            raise ValueError(f"two {what}s share frame {left['frame']}.")
    return keys


def parse_path(raw) -> Path:
    """JSON text (or already decoded data) -> a validated path.

    Accepts the version 2 object or a bare version 1 array of camera keyframes.

    Raises:
        ValueError: on malformed JSON, a missing/duplicate frame index, a non-finite
            axis, a non-positive distance or pivot depth, or a camera keyframe that
            names a pivot which does not exist.
    """
    if isinstance(raw, (list, tuple, dict)):
        data = raw
    else:
        text = str(raw or "").strip()
        if not text:
            return default_path()
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError(f"camera_path is not valid JSON: {error}") from None
    if isinstance(data, (list, tuple)):
        data = {"camera": list(data)}
    if not isinstance(data, dict):
        raise ValueError("camera_path must be a JSON array of keyframes or a path object.")

    pivots = []
    for item in data.get("pivots") or [default_pivot()]:
        if not isinstance(item, dict):
            raise ValueError("every pivot must be an object.")
        identifier = item.get("id")
        if not isinstance(identifier, str) or not identifier:
            raise ValueError("every pivot needs a string id.")
        if any(pivot["id"] == identifier for pivot in pivots):
            raise ValueError(f'two pivots share the id "{identifier}".')
        keys = [key for _, key in _keys(item.get("keys"), "pivot key", PIVOT_AXES, PIVOT_DEFAULTS)]
        for key in keys:
            if key["z"] <= 0.0:
                raise ValueError(f"pivot {identifier}: z must be greater than 0.")
        pivots.append({"id": identifier, "keys": keys})

    camera = []
    for item, key in _keys(data.get("camera"), "keyframe", AXES, DEFAULTS):
        if key["distance"] <= 0.0:
            raise ValueError(f"keyframe {key['frame']}: distance must be greater than 0.")
        reference = item.get("pivot")
        if reference is None:
            reference = pivots[0]["id"]
        elif not any(pivot["id"] == reference for pivot in pivots):
            raise ValueError(f'keyframe {key["frame"]}: no pivot with id "{reference}".')
        camera.append({"frame": key["frame"], "pivot": reference, **{name: key[name] for name in AXES}})
    return {"pivots": pivots, "camera": camera}


def dumps(path: Path) -> str:
    """Path -> the JSON text the camera_path output and widget carry."""
    path = _as_path(path)
    data = {
        "version": VERSION,
        "pivots": [{"id": pivot["id"],
                    "keys": [{"frame": int(key["frame"]),
                              **{name: round(axis(key, name, PIVOT_DEFAULTS), 4) for name in PIVOT_AXES}}
                             for key in pivot["keys"]]}
                   for pivot in path["pivots"]],
        "camera": [{"frame": int(key["frame"]), "pivot": key.get("pivot", path["pivots"][0]["id"]),
                    **{name: round(axis(key, name), 4) for name in AXES}}
                   for key in path["camera"]],
    }
    return json.dumps(data, indent=2)


def axis(key: dict, name: str, defaults: dict = DEFAULTS) -> float:
    """One axis of a keyframe, defaulted when absent.

    Keyframes reach here from parse_path with every axis filled in, but also
    straight from callers that only set what they care about. Defaulting here is
    what lets a path written before an axis existed still load.
    """
    value = key.get(name)
    return defaults[name] if value is None else float(value)


def _as_path(path) -> Path:
    """Accepts a bare camera keyframe list wherever a path is expected."""
    if isinstance(path, dict):
        return path
    return {"pivots": [default_pivot()], "camera": list(path)}


def _slope(keys: list[dict], index: int, name: str, defaults: dict) -> float:
    """Monotone (PCHIP) tangent: flat at the ends, at holds and at reversals."""
    if index == 0 or index == len(keys) - 1:
        return 0.0
    left, center, right = keys[index - 1:index + 2]
    h0 = center["frame"] - left["frame"]
    h1 = right["frame"] - center["frame"]
    d0 = (axis(center, name, defaults) - axis(left, name, defaults)) / h0
    d1 = (axis(right, name, defaults) - axis(center, name, defaults)) / h1
    if d0 == 0.0 or d1 == 0.0 or (d0 > 0.0) != (d1 > 0.0):
        return 0.0
    w0, w1 = 2 * h1 + h0, h1 + 2 * h0
    return (w0 + w1) / (w0 / d0 + w1 / d1)


def _interpolate(keys: list[dict], frame: float, axes, defaults: dict) -> dict:
    """PCHIP over a sorted key list; held before the first and after the last key."""
    pick = lambda key: {name: axis(key, name, defaults) for name in axes}
    if frame <= keys[0]["frame"]:
        return pick(keys[0])
    if frame >= keys[-1]["frame"]:
        return pick(keys[-1])
    for index, (left, right) in enumerate(zip(keys, keys[1:])):
        if frame > right["frame"]:
            continue
        h = right["frame"] - left["frame"]
        u = (frame - left["frame"]) / h
        h00 = 2 * u ** 3 - 3 * u ** 2 + 1
        h10 = u ** 3 - 2 * u ** 2 + u
        h01 = -2 * u ** 3 + 3 * u ** 2
        h11 = u ** 3 - u ** 2
        result = {}
        for name in axes:
            a, b = axis(left, name, defaults), axis(right, name, defaults)
            value = (h00 * a + h10 * h * _slope(keys, index, name, defaults)
                     + h01 * b + h11 * h * _slope(keys, index + 1, name, defaults))
            # PCHIP stays inside the segment; this only clips floating point excursions.
            result[name] = min(max(value, min(a, b)), max(a, b))
        return result
    return pick(keys[-1])


def pivot_at(pivot: Pivot, frame: float) -> dict:
    """A pivot's position and frame on an output frame: ``{x, y, z, tilt, roll}``."""
    return _interpolate(pivot["keys"], frame, PIVOT_AXES, PIVOT_DEFAULTS)


def pose_at(path, frame: float) -> Pose:
    """Camera pose on an output frame, with the pivot it orbits under ``"pivot"``.

    The path is held before the first and after the last keyframe. Each keyframe's
    pivot is resolved to a position and frame first, so a change of pivot between
    keyframes interpolates as a move rather than a jump.
    """
    path = _as_path(path)
    by_id = {pivot["id"]: pivot for pivot in path["pivots"]}
    keys = []
    for key in path["camera"]:
        resolved = pivot_at(by_id[key.get("pivot", path["pivots"][0]["id"])], key["frame"])
        keys.append({**key, **{carried: resolved[name] for carried, name in zip(_CARRIED, PIVOT_AXES)}})
    defaults = dict(DEFAULTS, **{carried: PIVOT_DEFAULTS[name] for carried, name in zip(_CARRIED, PIVOT_AXES)})
    pose = _interpolate(keys, frame, AXES + _CARRIED, defaults)
    return {**{name: pose[name] for name in AXES},
            "pivot": {name: pose[carried] for carried, name in zip(_CARRIED, PIVOT_AXES)}}


def poses(path, frame_count: int) -> list[Pose]:
    """One pose per output frame."""
    return [pose_at(path, i) for i in range(int(frame_count))]
