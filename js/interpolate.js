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
 * keyframe resolves its primary/target pivot pair before a shared handoff curve
 * interpolates the effective pivot. Mirrors `trajectory.pose_at`.
 * @param {object|object[]} path Path, or camera keyframes sorted by frame.
 * @param {number} frame Output frame index; may be fractional while scrubbing.
 * @returns {object} Pose with every axis filled in and `pivot: {x, y, z, tilt, roll}`.
 */
export function poseAt(path, frame) {
  path = asPath(path);
  if (!path.camera?.length) return { ...identityPose(), pivot: { ...PIVOT_DEFAULTS } };
  const byId = new Map(path.pivots.map((pivot) => [pivot.id, pivot]));
  const { left, right, amount } = pivotSegment(path, frame);
  const resolve = key => {
    const id = key.pivot ?? path.pivots[0].id;
    const a = pivotAt(byId.get(id), key.frame);
    const b = pivotAt(byId.get(key.pivot_target ?? id), key.frame);
    return Object.fromEntries(PIVOT_AXES.map(name => [name, a[name] + (b[name] - a[name]) * (key.pivot_blend ?? 0)]));
  };
  const a = resolve(left), b = resolve(right);
  const result = interpolate(path.camera, frame, AXES, DEFAULTS);
  result.pivot = Object.fromEntries(PIVOT_AXES.map(name => [name, a[name] + (b[name] - a[name]) * amount]));
  return result;
}

/**
 * Shared pivot handoff progress; camera axes retain their independent PCHIP curves.
 * @param {object} path Camera path.
 * @param {number} frame Sample time.
 * @returns {object} Bracketing keys and shared blend progress, held outside the path.
 */
function pivotSegment(path, frame) {
  const keys = path.camera;
  if (frame <= keys[0].frame) return { left: keys[0], right: keys[0], amount: 0 };
  for (let i = 1; i < keys.length; i++) {
    if (frame > keys[i].frame) continue;
    const left = keys[i - 1], right = keys[i];
    const u = (frame - left.frame) / (right.frame - left.frame);
    let amount = u * u * (3 - 2 * u);
    const weights = key => {
      const id = key.pivot ?? path.pivots[0].id, target = key.pivot_target ?? id;
      const blend = key.pivot_blend ?? 0;
      return id === target ? new Map([[id, 1]])
        : new Map([[id, 1 - blend], [target, blend]].filter(([, value]) => value > 0));
    };
    const pair = new Set([...weights(left).keys(), ...weights(right).keys()]);
    if (pair.size === 2) {
      // One PCHIP ratio across a compatible run, not a new ease-in/out at each inserted key.
      const target = [...pair][1];
      const compatible = key => [...weights(key).keys()].every(id => pair.has(id));
      let start = i - 1, end = i;
      while (start > 0 && compatible(keys[start - 1])) start--;
      while (end + 1 < keys.length && compatible(keys[end + 1])) end++;
      const track = keys.slice(start, end + 1).map(key => ({ frame: key.frame, blend: weights(key).get(target) ?? 0 }));
      const a = weights(left).get(target) ?? 0, b = weights(right).get(target) ?? 0;
      if (a !== b) amount = (interpolate(track, frame, ['blend'], { blend: 0 }).blend - a) / (b - a);
    }
    return { left, right, amount };
  }
  return { left: keys.at(-1), right: keys.at(-1), amount: 0 };
}

/**
 * Captures a two-pivot handoff for insertion, or rejects a mixed transition.
 * @param {object} path Camera path.
 * @param {number} frame Sample time.
 * @returns {object|null} Stored pivot fields; null if more than two pivots contribute.
 */
export function pivotBlendAt(path, frame) {
  const { left, right, amount } = pivotSegment(path, frame);
  const weights = new Map();
  for (const [key, factor] of [[left, 1 - amount], [right, amount]]) {
    const id = key.pivot ?? path.pivots[0].id, blend = key.pivot_blend ?? 0;
    for (const [pivot, weight] of [[id, 1 - blend], [key.pivot_target ?? id, blend]]) {
      if (factor * weight > 1e-12) weights.set(pivot, (weights.get(pivot) ?? 0) + factor * weight);
    }
  }
  const pivot = left.pivot ?? path.pivots[0].id;
  const others = [...weights.keys()].filter(id => id !== pivot);
  if (others.length > 1) return null;
  const target = others[0] ?? left.pivot_target ?? pivot;
  return { pivot, pivot_target: target, pivot_blend: target === pivot ? 0 : weights.get(target) ?? 0 };
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

  const camera = keysOf(data.camera, "keyframe", AXES, DEFAULTS).map(([item, key], index, entries) => {
    if (key.distance <= 0) throw new Error(`keyframe ${key.frame}: distance must be positive`);
    const pivot = item.pivot ?? pivots[0].id;
    if (!pivots.some((candidate) => candidate.id === pivot)) {
      throw new Error(`keyframe ${key.frame}: no pivot with id "${pivot}"`);
    }
    const target = item.pivot_target ?? entries.slice(index + 1).map(([entry]) => entry.pivot ?? pivots[0].id)
      .find(id => id !== pivot) ?? pivot;
    const blend = Number(item.pivot_blend ?? 0);
    if (!pivots.some(candidate => candidate.id === target)) throw new Error(`keyframe ${key.frame}: missing blend target`);
    if (!Number.isFinite(blend) || blend < 0 || blend > 1) throw new Error(`keyframe ${key.frame}: pivot blend must be between 0 and 1`);
    return { frame: key.frame, pivot, pivot_target: target, pivot_blend: blend,
      ...Object.fromEntries(AXES.map((name) => [name, key[name]])) };
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
      pivot_target: key.pivot_target ?? key.pivot ?? path.pivots[0].id,
      pivot_blend: round(key.pivot_blend ?? 0),
      ...Object.fromEntries(AXES.map((name) => [name, round(axis(key, name))])),
    })),
  }, null, 2);
}
