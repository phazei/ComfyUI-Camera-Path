/**
 * Camera path format and monotone cubic (PCHIP) interpolation, per axis.
 *
 * This is the same curve and the same format as `camera_path/trajectory.py`, so what
 * the editor previews is what the node renders. `tests/test_parity.py` runs both and
 * compares them -- any change here needs the matching change there.
 *
 * A path is `{pivots: [{id, keys: [{frame, x, y, z, tilt, roll}]}], camera: [{frame, pivot, ...axes}]}`.
 * Pivot positions are in units of the automatic pivot depth, so `(0, 0, 1)` is the
 * subject the node found on its own; tilt and roll straighten the frame the orbit
 * happens in. A bare array of camera keyframes (version 1) still loads.
 */

/** The axes of a camera pose, in the order they are written out. @type {string[]} */
export const AXES = ["azimuth", "elevation", "distance", "lateral", "height", "pan", "tilt", "roll", "lock", "dolly"];

/** Pivot-relative reset; reproduces the source camera with the automatic pivot. */
export const DEFAULTS = { azimuth: 0, elevation: 0, distance: 1, lateral: 0, height: 0,
                          pan: 0, tilt: 0, roll: 0, lock: 0, dolly: 0 };

/** A pivot key: position in units of the automatic pivot depth, then its frame in degrees. @type {string[]} */
export const PIVOT_AXES = ["x", "y", "z", "tilt", "roll", "heading"];

/** The automatic pivot: on the optical axis, one pivot depth in, frame of the source camera. */
export const PIVOT_DEFAULTS = { x: 0, y: 0, z: 1, tilt: 0, roll: 0, heading: 0 };

/** Hidden axes the camera track carries so a pivot switch interpolates as a move. */
const CARRIED = PIVOT_AXES.map((name) => `_pivot_${name}`);

export const VERSION = 2;

/**
 * @returns {object} The pivot-relative reset pose.
 */
export function identityPose() {
  return { ...DEFAULTS };
}

/**
 * @param {string} [id] Pivot id.
 * @returns {object} A pivot sitting on the automatically found subject.
 */
export function defaultPivot(id = "p1") {
  return { id, keys: [{ frame: 0, ...PIVOT_DEFAULTS }] };
}

/**
 * @returns {object} A path with one source-camera keyframe on one automatic pivot.
 */
export function defaultPath() {
  const pivot = defaultPivot();
  return { pivots: [pivot], camera: [{ frame: 0, pivot: pivot.id, ...DEFAULTS }] };
}

/**
 * One axis of a keyframe, defaulted when absent. Mirrors `trajectory.axis`, and is
 * what lets a path written before an axis existed still load.
 * @param {object} key Keyframe.
 * @param {string} name Axis name.
 * @param {object} [defaults] Defaults table; the camera's unless given.
 * @returns {number} The axis value.
 */
export function axis(key, name, defaults = DEFAULTS) {
  const value = key[name];
  return value === undefined || value === null ? defaults[name] : Number(value);
}

// ── Interpolation ──────────────────────────────────────────────────────────

/**
 * Monotone (PCHIP) tangent at a key: flat at the ends, at holds and at reversals.
 * @param {object[]} keys Keys sorted by frame.
 * @param {number} index Key to take the tangent at.
 * @param {string} name Axis name.
 * @param {object} defaults Defaults table.
 * @returns {number} Slope in units per frame.
 */
function slope(keys, index, name, defaults) {
  if (index === 0 || index === keys.length - 1) return 0;
  const left = keys[index - 1], center = keys[index], right = keys[index + 1];
  const h0 = center.frame - left.frame, h1 = right.frame - center.frame;
  const d0 = (axis(center, name, defaults) - axis(left, name, defaults)) / h0;
  const d1 = (axis(right, name, defaults) - axis(center, name, defaults)) / h1;
  if (d0 === 0 || d1 === 0 || (d0 > 0) !== (d1 > 0)) return 0;
  const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / d0 + w1 / d1);
}

/**
 * PCHIP over a sorted key list; held before the first and after the last key, and
 * every key is hit exactly.
 * @param {object[]} keys Keys sorted by frame.
 * @param {number} frame Output frame index; may be fractional while scrubbing.
 * @param {string[]} axes Axes to interpolate.
 * @param {object} defaults Defaults table.
 * @returns {object} Every axis filled in.
 */
function interpolate(keys, frame, axes, defaults) {
  const pick = (key) => Object.fromEntries(axes.map((name) => [name, axis(key, name, defaults)]));
  if (frame <= keys[0].frame) return pick(keys[0]);
  if (frame >= keys[keys.length - 1].frame) return pick(keys[keys.length - 1]);
  for (let index = 0; index < keys.length - 1; index++) {
    const left = keys[index], right = keys[index + 1];
    if (frame > right.frame) continue;
    const h = right.frame - left.frame, u = (frame - left.frame) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    const result = {};
    for (const name of axes) {
      const a = axis(left, name, defaults), b = axis(right, name, defaults);
      const value = h00 * a + h10 * h * slope(keys, index, name, defaults)
                  + h01 * b + h11 * h * slope(keys, index + 1, name, defaults);
      // PCHIP stays inside the segment; this only clips floating point excursions.
      result[name] = Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));
    }
    return result;
  }
  return pick(keys[keys.length - 1]);
}

/**
 * Accepts a bare camera keyframe list wherever a path is expected.
 * @param {object|object[]} path Path object or camera keyframes.
 * @returns {object} Path object.
 */
function asPath(path) {
  return Array.isArray(path) ? { pivots: [defaultPivot()], camera: path } : path;
}

/**
 * A pivot's position and frame on an output frame. Mirrors `trajectory.pivot_at`.
 * @param {object} pivot Pivot with its key track.
 * @param {number} frame Output frame index.
 * @returns {{x: number, y: number, z: number, tilt: number, roll: number}} Resolved pivot.
 */
export function pivotAt(pivot, frame) {
  return interpolate(pivot.keys, frame, PIVOT_AXES, PIVOT_DEFAULTS);
}

/**
 * Camera pose on an output frame, with the pivot it orbits under `pivot`. Each
 * keyframe's pivot is resolved to a position and frame first, so a change of pivot
 * between keyframes interpolates as a move rather than a jump. Mirrors
 * `trajectory.pose_at`.
 * @param {object|object[]} path Path, or camera keyframes sorted by frame.
 * @param {number} frame Output frame index; may be fractional while scrubbing.
 * @returns {object} Pose with every axis filled in and `pivot: {x, y, z, tilt, roll}`.
 */
export function poseAt(path, frame) {
  path = asPath(path);
  if (!path.camera?.length) return { ...identityPose(), pivot: { ...PIVOT_DEFAULTS } };
  const byId = new Map(path.pivots.map((pivot) => [pivot.id, pivot]));
  const keys = path.camera.map((key) => {
    const resolved = pivotAt(byId.get(key.pivot ?? path.pivots[0].id), key.frame);
    return { ...key, ...Object.fromEntries(PIVOT_AXES.map((name, i) => [CARRIED[i], resolved[name]])) };
  });
  const defaults = { ...DEFAULTS, ...Object.fromEntries(PIVOT_AXES.map((name, i) => [CARRIED[i], PIVOT_DEFAULTS[name]])) };
  const pose = interpolate(keys, frame, [...AXES, ...CARRIED], defaults);
  const result = Object.fromEntries(AXES.map((name) => [name, pose[name]]));
  result.pivot = Object.fromEntries(PIVOT_AXES.map((name, i) => [name, pose[CARRIED[i]]]));
  return result;
}

// ── Serialization ──────────────────────────────────────────────────────────

/**
 * Validates and canonicalises a path: fills in missing axes, sorts by frame, drops
 * duplicate frames and resolves pivot references. Keeps a hand-edited, upstream or
 * version 1 path usable. Mirrors `trajectory.parse_path`.
 * @param {object|object[]} data Raw path object or version 1 keyframe array.
 * @returns {object} `{pivots, camera}`, sorted and complete.
 * @throws {Error} If the path is empty or a key is malformed.
 */
export function normalizePath(data) {
  if (Array.isArray(data)) data = { camera: data };
  if (!data || typeof data !== "object") throw new Error("camera_path must be an array or a path object");
  const keysOf = (items, what, axes, defaults) => {
    if (!Array.isArray(items) || !items.length) throw new Error(`${what}s must be a non-empty array`);
    const keys = items.map((item) => {
      if (!item || typeof item !== "object" || !Number.isFinite(Number(item.frame))) {
        throw new Error(`every ${what} needs a numeric frame`);
      }
      const key = { frame: Math.round(Number(item.frame)) };
      for (const name of axes) {
        const value = item[name] == null ? defaults[name] : Number(item[name]);
        if (!Number.isFinite(value)) throw new Error(`${what} ${key.frame}: ${name} is not a number`);
        key[name] = value;
      }
      return [item, key];
    });
    keys.sort((a, b) => a[1].frame - b[1].frame);
    return keys.filter(([, key], index) => index === 0 || key.frame !== keys[index - 1][1].frame);
  };

  const pivots = [];
  for (const item of data.pivots?.length ? data.pivots : [defaultPivot()]) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) {
      throw new Error("every pivot needs a string id");
    }
    if (pivots.some((pivot) => pivot.id === item.id)) throw new Error(`two pivots share the id "${item.id}"`);
    const keys = keysOf(item.keys, "pivot key", PIVOT_AXES, PIVOT_DEFAULTS).map(([, key]) => key);
    if (keys.some((key) => key.z <= 0)) throw new Error(`pivot ${item.id}: z must be positive`);
    pivots.push({ id: item.id, keys });
  }

  const camera = keysOf(data.camera, "keyframe", AXES, DEFAULTS).map(([item, key]) => {
    if (key.distance <= 0) throw new Error(`keyframe ${key.frame}: distance must be positive`);
    const pivot = item.pivot ?? pivots[0].id;
    if (!pivots.some((candidate) => candidate.id === pivot)) {
      throw new Error(`keyframe ${key.frame}: no pivot with id "${pivot}"`);
    }
    return { frame: key.frame, pivot, ...Object.fromEntries(AXES.map((name) => [name, key[name]])) };
  });
  return { pivots, camera };
}

/**
 * Path -> the JSON text the keyframes widget carries. Matches `trajectory.dumps()`
 * field order and 4-decimal rounding.
 * @param {object} path Path object.
 * @returns {string} Pretty-printed JSON.
 */
export function serializePath(path) {
  path = asPath(path);
  const round = (value) => Math.round(value * 1e4) / 1e4;
  return JSON.stringify({
    version: VERSION,
    pivots: path.pivots.map((pivot) => ({
      id: pivot.id,
      keys: pivot.keys.map((key) => ({
        frame: key.frame, ...Object.fromEntries(PIVOT_AXES.map((name) => [name, round(axis(key, name, PIVOT_DEFAULTS))])),
      })),
    })),
    camera: path.camera.map((key) => ({
      frame: key.frame, pivot: key.pivot ?? path.pivots[0].id,
      ...Object.fromEntries(AXES.map((name) => [name, round(axis(key, name))])),
    })),
  }, null, 2);
}
