/**
 * Camera math and point splatting for the editor preview.
 *
 * Mirrors `camera_path/render.py` so the live view matches the render: OpenCV frame
 * (+x right, +y down, +z into the scene), source camera at the origin, orbit pivot
 * anywhere in the scene. `tests/test_parity.py` compares both sides.
 *
 * Two projections live here. `renderCamera` is the virtual camera -- the same
 * perspective splat the node renders with. `renderScene` is the editor's own
 * orthographic overview, which shares its projection with the wireframe.
 */

/** Depth bias across a splat window; identical to render.SPLAT_BIAS. */
const SPLAT_BIAS = 1e-4;

const rad = (value) => value * Math.PI / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scaled = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// ── Camera ─────────────────────────────────────────────────────────────────

/**
 * Applies rotY(-azimuth) * rotX(-elevation) to a vector.
 * @param {object} pose Pose with azimuth and elevation in degrees.
 * @param {number[]} v Vector to rotate.
 * @returns {number[]} Rotated vector.
 */
function rotate(pose, v) {
  const ca = Math.cos(rad(-pose.azimuth)), sa = Math.sin(rad(-pose.azimuth));
  const ce = Math.cos(rad(-pose.elevation)), se = Math.sin(rad(-pose.elevation));
  const x = v[0], y = ce * v[1] - se * v[2], z = se * v[1] + ce * v[2];
  return [ca * x + sa * z, y, -sa * x + ca * z];
}

/**
 * Camera basis looking from eye to target.
 * @param {number[]} eye Camera position.
 * @param {number[]} target Point to look at.
 * @param {number[]} [down] Reference the camera's own down is squared against; world down by default.
 * @returns {{eye: number[], right: number[], down: number[], forward: number[]}} Basis vectors.
 */
export function lookAt(eye, target, down = [0, 1, 0]) {
  const delta = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const forward = scaled(delta, 1 / Math.max(norm(delta), 1e-12));
  let right = cross(down, forward);
  let length = norm(right);
  if (length < 1e-6) {
    // Straight up or down: the down reference is degenerate, roll around z instead.
    right = cross([0, 0, 1], forward);
    length = norm(right);
  }
  right = scaled(right, 1 / Math.max(length, 1e-12));
  return { eye, right, down: cross(forward, right), forward };
}

/**
 * Pivot as a 3-vector. A bare number is a depth on the optical axis. Mirrors
 * `render.pivot_point`.
 * @param {number|number[]} pivot Depth, or [x, y, z].
 * @returns {number[]} [x, y, z].
 */
export function pivotPoint(pivot) {
  return typeof pivot === 'number' ? [0, 0, pivot] : [pivot[0], pivot[1], pivot[2]];
}

/** Row-major 3x3 helpers, enough for the orbit frame. */
const mulMat = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const mulVec = (m, v) => m.map((row) => dot(row, v));
const transpose = (m) => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * Rotation from the source camera's axes to a pivot's orbit frame. Mirrors
 * `render.orbit_frame`: tilt/roll straightening followed by heading about corrected up.
 * @param {number} tilt Degrees.
 * @param {number} roll Degrees.
 * @param {number} [heading] Azimuth-zero heading in degrees.
 * @returns {number[][]} Row-major 3x3.
 */
export function orbitFrame(tilt, roll, heading = 0) {
  if (!tilt && !roll && !heading) return IDENTITY;
  const ct = Math.cos(rad(tilt)), st = Math.sin(rad(tilt));
  const cr = Math.cos(rad(roll)), sr = Math.sin(rad(roll));
  const rx = [[1, 0, 0], [0, ct, -st], [0, st, ct]];
  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  const ch = Math.cos(rad(-heading)), sh = Math.sin(rad(-heading));
  return mulMat(mulMat(rz, rx), [[ch, 0, sh], [0, 1, 0], [-sh, 0, ch]]);
}

/**
 * Camera basis for a pivot-relative pose. Equivalent to `render.orbit_matrix`, as
 * columns. The camera inherits the pivot frame and orbits at distance * unit.
 * @param {object} pose Pose with any of the axes.
 * @param {number|number[]} pivot Orbit centre: [x, y, z], or a depth on the axis.
 * @param {number} [tilt] Orbit frame tilt, degrees.
 * @param {number} [roll] Orbit frame roll, degrees.
 * @param {number} [unit] Shared automatic depth; defaults to a scalar pivot or 1.
 * @param {number} [heading] Pivot heading in degrees.
 * @returns {{eye: number[], right: number[], down: number[], forward: number[]}} Basis vectors.
 */
export function orbitCamera(pose, pivot, tilt = 0, roll = 0, unit = typeof pivot === 'number' ? pivot : 1, heading = 0) {
  const p = pivotPoint(pivot);
  const d = pose.distance;
  const frame = orbitFrame(tilt, roll, heading);
  const turn = (v) => mulVec(frame, rotate(pose, v));
  const back = turn([0, 0, -unit]);
  const eye = [p[0] + d * back[0], p[1] + d * back[1], p[2] + d * back[2]];
  // Unlocked translations carry the target along with the camera.
  const carried = [0, 0, 0];
  const height = pose.height || 0, lateral = pose.lateral || 0;
  if (height || lateral) {
    // Boom and truck translate the camera and its target together, so the lens keeps
    // its direction and the subject travels across the frame. `lock` blends the target
    // back onto the pivot, which keeps the subject centred instead.
    const right = turn([1, 0, 0]);
    const up = mulVec(frame, [0, -1, 0]);
    for (let i = 0; i < 3; i++) {
      const shift = height * unit * up[i] + lateral * unit * right[i];
      eye[i] += shift;
      carried[i] += shift;
    }
  }
  const held = 1 - (pose.lock || 0);
  const target = [p[0] + held * carried[0], p[1] + held * carried[1], p[2] + held * carried[2]];
  // The camera's own down, carried with it, is the roll reference: a locked camera
  // then stays level in the orbit frame rather than in the image frame.
  const camera = aim(lookAt(eye, target, turn([0, 1, 0])), pose.pan || 0, pose.tilt || 0, pose.roll || 0);
  for (let i = 0; i < 3; i++) camera.eye[i] += (pose.dolly || 0) * unit * camera.forward[i];
  return camera;
}

/**
 * Camera basis for a pose from `poseAt`, whose pivot is in units of `unit`.
 * Mirrors `render.pose_matrix`.
 * @param {object} pose Pose with `pivot: {x, y, z, tilt, roll, heading}`.
 * @param {number} unit Automatic pivot depth.
 * @returns {{eye: number[], right: number[], down: number[], forward: number[]}} Basis vectors.
 */
export function poseCamera(pose, unit) {
  const { x, y, z, tilt = 0, roll = 0, heading = 0 } = pose.pivot;
  return orbitCamera(pose, [x * unit, y * unit, z * unit], tilt, roll, unit, heading);
}

/**
 * Turns a camera basis about its own axes, leaving the eye alone. Mirrors `render.aim`.
 * @param {{eye: number[], right: number[], down: number[], forward: number[]}} basis Camera basis.
 * @param {number} pan Degrees; positive aims right.
 * @param {number} tilt Degrees; positive aims up.
 * @param {number} [roll] Degrees; positive rolls clockwise.
 * @returns {{eye: number[], right: number[], down: number[], forward: number[]}} Turned basis.
 */
export function aim(basis, pan, tilt, roll = 0) {
  if (!pan && !tilt && !roll) return basis;
  const cp = Math.cos(rad(pan)), sp = Math.sin(rad(pan));
  const ct = Math.cos(rad(tilt)), st = Math.sin(rad(tilt));
  const cr = Math.cos(rad(roll)), sr = Math.sin(rad(roll));
  // Columns of rotY(pan) @ rotX(tilt), then rotZ(roll) mixes the first two.
  const c0 = [cp, 0, -sp], c1 = [sp * st, ct, cp * st], c2 = [sp * ct, -st, cp * ct];
  const columns = [
    [0, 1, 2].map((i) => c0[i] * cr + c1[i] * sr),
    [0, 1, 2].map((i) => -c0[i] * sr + c1[i] * cr),
    c2,
  ];
  const apply = (column) => [0, 1, 2].map((row) =>
    basis.right[row] * column[0] + basis.down[row] * column[1] + basis.forward[row] * column[2]);
  return { eye: basis.eye, right: apply(columns[0]), down: apply(columns[1]), forward: apply(columns[2]) };
}

/**
 * Scene-space position of a world point: the automatic pivot at the origin, the
 * source camera 1.8 units toward the viewer.
 * @param {number} x World x (OpenCV, right).
 * @param {number} y World y (OpenCV, down).
 * @param {number} z World z (OpenCV, into the scene).
 * @param {number} unit Automatic pivot depth.
 * @returns {number[]} Editor scene coordinates (y up, z toward the viewer).
 */
export function scenePoint(x, y, z, unit) {
  const s = 1.8 / unit;
  return [x * s, -y * s, -(z - unit) * s];
}

/**
 * A scene-space offset back to world units.
 * @param {number[]} delta Scene offset.
 * @param {number} unit Automatic pivot depth.
 * @returns {number[]} World offset.
 */
export function worldOffset(delta, unit) {
  const s = unit / 1.8;
  return [delta[0] * s, -delta[1] * s, -delta[2] * s];
}

/**
 * A resolved pivot's position -> world coordinates.
 * @param {{x: number, y: number, z: number}} pivot Position in pivot-depth units.
 * @param {number} unit Automatic pivot depth.
 * @returns {number[]} World position.
 */
export function pivotWorld(pivot, unit) {
  return [pivot.x * unit, pivot.y * unit, pivot.z * unit];
}

/**
 * Where a pose puts the camera in the editor's scene space.
 * @param {object} pose Pose from `poseAt`.
 * @param {number} unit Automatic pivot depth.
 * @returns {number[]} Editor scene coordinates.
 */
export function cameraScenePosition(pose, unit) {
  const { eye } = poseCamera(pose, unit);
  return scenePoint(eye[0], eye[1], eye[2], unit);
}

/**
 * The scene-space rotation that stands a pivot's orbit frame upright on screen: the
 * inverse of its frame, carried across the world-to-scene axis flip.
 * @param {{tilt?: number, roll?: number}} pivot Resolved pivot.
 * @returns {number[][]|null} Row-major 3x3, or null when the frame is the identity.
 */
export function uprightRotation(pivot) {
  if (!pivot.tilt && !pivot.roll) return null;
  const flip = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  return mulMat(flip, mulMat(transpose(orbitFrame(pivot.tilt || 0, pivot.roll || 0)), flip));
}

// ── Point cloud ────────────────────────────────────────────────────────────

/**
 * An empty cloud with room for `count` points, in the layout `buildCloud` produces.
 * @param {number} count Number of points.
 * @returns {{count: number, x: Float32Array, y: Float32Array, z: Float32Array, color: Uint8Array}} Cloud.
 */
export function emptyCloud(count) {
  return {
    count,
    x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
    color: new Uint8Array(count * 3),
  };
}

/**
 * Joins clouds end to end. Mirrors `torch.cat` on the Python side, where the lattice
 * is appended to the geometry before splatting.
 * @param {...object} clouds Clouds from buildCloud() or emptyCloud().
 * @returns {object} One cloud holding every point, in order.
 */
export function concatClouds(...clouds) {
  const parts = clouds.filter((cloud) => cloud && cloud.count > 0);
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((sum, cloud) => sum + cloud.count, 0);
  const out = emptyCloud(total);
  let offset = 0;
  for (const cloud of parts) {
    out.x.set(cloud.x.subarray(0, cloud.count), offset);
    out.y.set(cloud.y.subarray(0, cloud.count), offset);
    out.z.set(cloud.z.subarray(0, cloud.count), offset);
    out.color.set(cloud.color.subarray(0, cloud.count * 3), offset * 3);
    offset += cloud.count;
  }
  return out;
}

// ── Marker lattice ─────────────────────────────────────────────────────────

/** Lattice layout in units of pivot depth; identical to render.LATTICE_*. */
const LATTICE_SPACING = 1.0;
const LATTICE_EXTENT = [[-2.0, 2.0], [-1.0, 1.0], [0.5, 3.5]];
const LATTICE_RADIUS = 0.015;
const LATTICE_POINTS = 24;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const LATTICE_LIGHT = [-0.45, -0.7, -0.55];

/**
 * The marker lattice as a cloud, mirroring `render.marker_lattice` point for point:
 * small spheres on a regular grid, each coloured by where it sits so it keeps one
 * colour through a move. `tests/test_parity.py` compares the two.
 * @param {number} unit Automatic pivot depth.
 * @returns {object} Cloud in world units.
 */
export function markerLattice(unit) {
  const counts = LATTICE_EXTENT.map(([low, high]) => Math.round((high - low) / LATTICE_SPACING) + 1);
  const spans = LATTICE_EXTENT.map(([low, high]) => high - low);
  const surface = [], lit = [];
  for (let i = 0; i < LATTICE_POINTS; i++) {
    const y = 1 - 2 * (i + 0.5) / LATTICE_POINTS;
    const r = Math.sqrt(1 - y * y), angle = i * GOLDEN;
    const n = [r * Math.cos(angle), y, r * Math.sin(angle)];
    surface.push(n);
    lit.push(0.7 + 0.3 * Math.max(0, dot(n, LATTICE_LIGHT)));
  }
  const cloud = emptyCloud(counts[0] * counts[1] * counts[2] * LATTICE_POINTS);
  let k = 0;
  for (let kz = 0; kz < counts[2]; kz++) {
    for (let jy = 0; jy < counts[1]; jy++) {
      for (let ix = 0; ix < counts[0]; ix++) {
        const cell = [ix, jy, kz];
        const centre = cell.map((step, a) => LATTICE_EXTENT[a][0] + step * LATTICE_SPACING);
        const tint = centre.map((value, a) => 0.35 + 0.6 * (value - LATTICE_EXTENT[a][0]) / spans[a]);
        for (let i = 0; i < LATTICE_POINTS; i++, k++) {
          cloud.x[k] = (centre[0] + surface[i][0] * LATTICE_RADIUS) * unit;
          cloud.y[k] = (centre[1] + surface[i][1] * LATTICE_RADIUS) * unit;
          cloud.z[k] = (centre[2] + surface[i][2] * LATTICE_RADIUS) * unit;
          for (let c = 0; c < 3; c++) {
            cloud.color[k * 3 + c] = Math.round(Math.min(1, tint[c] * lit[i]) * 255);
          }
        }
      }
    }
  }
  return cloud;
}

/**
 * Unprojects a preview depth map into a coloured point cloud.
 * @param {Float32Array} depth Per-pixel depth; NaN or <= 0 is dropped.
 * @param {Uint8Array|Uint8ClampedArray} rgba Colour source, 4 bytes per pixel.
 * @param {number} width Depth map width.
 * @param {number} height Depth map height.
 * @param {{fx: number, fy: number, cx: number, cy: number}} lens Intrinsics in preview pixels.
 * @returns {{count: number, x: Float32Array, y: Float32Array, z: Float32Array, color: Uint8Array}} Cloud.
 */
export function buildCloud(depth, rgba, width, height, lens) {
  const total = width * height;
  let kept = 0;
  for (let i = 0; i < total; i++) if (Number.isFinite(depth[i]) && depth[i] > 0) kept++;
  const cloud = emptyCloud(kept);
  let k = 0;
  for (let i = 0; i < total; i++) {
    const d = depth[i];
    if (!(Number.isFinite(d) && d > 0)) continue;
    const column = i % width, row = (i - column) / width;
    // Pixel centres, matching MoGe's own unprojection convention.
    cloud.x[k] = (column + 0.5 - lens.cx) / lens.fx * d;
    cloud.y[k] = (row + 0.5 - lens.cy) / lens.fy * d;
    cloud.z[k] = d;
    cloud.color[k * 3] = rgba[i * 4];
    cloud.color[k * 3 + 1] = rgba[i * 4 + 1];
    cloud.color[k * 3 + 2] = rgba[i * 4 + 2];
    k++;
  }
  return cloud;
}

/**
 * Reprojects the cloud from a virtual camera into an ImageData buffer, z-buffered.
 * @param {object} cloud Cloud from buildCloud().
 * @param {object} camera Basis from orbitCamera().
 * @param {{fx: number, fy: number, cx: number, cy: number}} lens Intrinsics in target pixels.
 * @param {{data: Uint8ClampedArray, width: number, height: number, depth: Float32Array}} target Output buffer.
 * @param {number} splat Splat radius in pixels.
 * @returns {number} Fraction of pixels no point reached.
 */
export function renderCamera(cloud, camera, lens, target, splat) {
  const { data, width, height, depth } = target;
  const pixels = width * height;
  data.fill(0);
  for (let i = 0; i < pixels; i++) {
    data[i * 4 + 3] = 255;
    depth[i] = Infinity;
  }
  const { eye, right, down, forward } = camera;
  let covered = 0;
  for (let k = 0; k < cloud.count; k++) {
    const px = cloud.x[k] - eye[0], py = cloud.y[k] - eye[1], pz = cloud.z[k] - eye[2];
    const zc = px * forward[0] + py * forward[1] + pz * forward[2];
    if (!(zc > 1e-6)) continue;
    const xc = px * right[0] + py * right[1] + pz * right[2];
    const yc = px * down[0] + py * down[1] + pz * down[2];
    const u = Math.floor(xc / zc * lens.fx + lens.cx), v = Math.floor(yc / zc * lens.fy + lens.cy);
    for (let dy = -splat; dy <= splat; dy++) {
      const ty = v + dy;
      if (ty < 0 || ty >= height) continue;
      for (let dx = -splat; dx <= splat; dx++) {
        const tx = u + dx;
        if (tx < 0 || tx >= width) continue;
        const t = ty * width + tx;
        // Same outward depth bias as render.py: a point owns its own pixel on ties.
        const zb = zc * (1 + SPLAT_BIAS * (dy * dy + dx * dx));
        if (zb >= depth[t]) continue;
        if (depth[t] === Infinity) covered++;
        depth[t] = zb;
        data[t * 4] = cloud.color[k * 3];
        data[t * 4 + 1] = cloud.color[k * 3 + 1];
        data[t * 4 + 2] = cloud.color[k * 3 + 2];
      }
    }
  }
  return 1 - covered / pixels;
}

/**
 * Draws the cloud into the editor's orthographic scene view, sharing the wireframe's
 * projection so points and gizmos line up.
 * @param {object} cloud Cloud from buildCloud().
 * @param {{yaw: number, pitch: number, scale: number, originX: number, originY: number,
 *   centre?: number[], upright?: object}} view
 *   Projection. `upright`, when set, is `{centre, rotation}`: scene points are turned
 *   by the rotation about the centre first, which stands a pivot's frame upright.
 *   `centre` is the scene point the view turns about, drawn at the origin.
 * @param {{data: Uint8ClampedArray, width: number, height: number, depth: Float32Array}} target Output buffer.
 * @param {number} pivotZ Orbit centre depth.
 * @param {number} stride Draw every nth point.
 * @param {number} radius Scene-only splat radius in device pixels.
 * @returns {void}
 */
export function renderScene(cloud, view, target, pivotZ, stride, radius = 0) {
  const { data, width, height, depth } = target;
  const { yaw, pitch, scale, originX, originY, upright } = view;
  const [ox, oy, oz] = view.centre ?? [0, 0, 0];
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const s = 1.8 / pivotZ;
  const m = upright?.rotation, c = upright?.centre;
  for (let k = 0; k < cloud.count; k += stride) {
    let ex = cloud.x[k] * s, ey = -cloud.y[k] * s, ez = -(cloud.z[k] - pivotZ) * s;
    if (m) {
      const dx = ex - c[0], dy = ey - c[1], dz = ez - c[2];
      ex = c[0] + m[0][0] * dx + m[0][1] * dy + m[0][2] * dz;
      ey = c[1] + m[1][0] * dx + m[1][1] * dy + m[1][2] * dz;
      ez = c[2] + m[2][0] * dx + m[2][1] * dy + m[2][2] * dz;
    }
    ex -= ox;
    ey -= oy;
    ez -= oz;
    const rx = ex * cy - ez * sy, rz = ex * sy + ez * cy;
    const d = ey * sp + rz * cp;
    const px = (originX + rx * scale) | 0, py = (originY - (ey * cp - rz * sp) * scale) | 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = px + dx, y = py + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const t = y * width + x, biased = d + 1e-4 * (dx * dx + dy * dy);
      if (biased >= depth[t]) continue;
      depth[t] = biased;
      data[t * 4] = cloud.color[k * 3];
      data[t * 4 + 1] = cloud.color[k * 3 + 1];
      data[t * 4 + 2] = cloud.color[k * 3 + 2];
      data[t * 4 + 3] = 255;
    }
  }
}

// ── Interaction ────────────────────────────────────────────────────────────

/**
 * Scene-space axes of the observer's screen, matching the editor's projector:
 * `right` and `up` span the screen plane, `depth` points at the observer.
 * @param {number} yaw Observer yaw.
 * @param {number} pitch Observer pitch.
 * @returns {{right: number[], up: number[], depth: number[]}} Orthonormal basis.
 */
export function screenBasis(yaw, pitch) {
  return {
    right: [Math.cos(yaw), 0, -Math.sin(yaw)],
    up: [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), -Math.cos(yaw) * Math.sin(pitch)],
    depth: [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)],
  };
}

/**
 * The azimuth/elevation whose orbit rotation carries unit vector `u` onto `v`.
 *
 * The orbit is rotY(-azimuth) * rotX(-elevation). rotX leaves x alone and rotY
 * leaves y alone, so elevation is read off the y component and azimuth off the x/z
 * angle -- exact, with one sign choice for elevation, resolved toward the current
 * pose. Where `v` is out of reach (near the poles, for a pivot off to one side) the
 * nearest reachable direction is used.
 * @param {number[]} u Unit vector to rotate; `-pivot` normalised.
 * @param {number[]} v Unit vector to land on.
 * @param {object} pose Current pose, for branch selection and unwrapping.
 * @returns {{azimuth: number, elevation: number}} Angles in degrees.
 */
function solveOrbit(u, v, pose) {
  const rho = Math.hypot(u[1], u[2]);
  const psi = Math.atan2(u[2], u[1]);
  const reach = Math.acos(Math.min(1, Math.max(-1, v[1] / (rho || 1e-12))));
  let best = null;
  for (const sign of [1, -1]) {
    const e = sign * reach - psi;
    const elevation = -e * 180 / Math.PI;
    const wrapped = ((elevation + 180) % 360 + 360) % 360 - 180;
    const cost = Math.abs(wrapped - pose.elevation);
    if (!best || cost < best.cost) best = { e, elevation: wrapped, cost };
  }
  const ce = Math.cos(best.e), se = Math.sin(best.e);
  const w = [u[0], ce * u[1] - se * u[2], se * u[1] + ce * u[2]];
  const a = Math.atan2(v[0], v[2]) - Math.atan2(w[0], w[2]);
  const raw = -a * 180 / Math.PI;
  // Unwrap onto the current turn so multi-turn paths keep counting up.
  const azimuth = pose.azimuth + (((raw - pose.azimuth + 180) % 360) + 360) % 360 - 180;
  return { azimuth, elevation: best.elevation };
}

/**
 * A scene-space offset as it appears on screen when the view is stood upright.
 * @param {number[]} delta Scene offset.
 * @param {number[][]|null} upright Upright rotation, or null.
 * @param {boolean} [back] Invert: from the screen's rotated space back to scene space.
 * @returns {number[]} Rotated offset.
 */
const viewTurn = (delta, upright, back = false) =>
  upright ? mulVec(back ? transpose(upright) : upright, delta) : delta;

/**
 * Turns a pointer drag in the scene view into azimuth/elevation, keeping the radius.
 * The pointer ray meets the orbit sphere about the pivot; outside the silhouette it
 * clamps to the rim so the drag stays continuous.
 * @param {object} pose Pose the drag started from, from `poseAt`.
 * @param {number} unit Automatic pivot depth.
 * @param {number} dx Total pointer movement in x, in scene-canvas layout pixels.
 * @param {number} dy Total pointer movement in y.
 * @param {number} scale Scene scale at drag start.
 * @param {number} yaw Observer yaw at drag start.
 * @param {number} pitch Observer pitch at drag start.
 * @param {number[][]|null} [upright] Rotation the view was drawn with, if stood upright.
 * @returns {{azimuth: number, elevation: number}} New angles in degrees.
 */
export function dragOrbit(pose, unit, dx, dy, scale, yaw, pitch, upright = null) {
  const pivot = pivotWorld(pose.pivot, unit);
  const centre = scenePoint(pivot[0], pivot[1], pivot[2], unit);
  // The sphere of orbit positions, before truck, boom and dolly slide off it.
  const { eye } = poseCamera({ ...pose, lateral: 0, height: 0, dolly: 0 }, unit);
  const at = scenePoint(eye[0], eye[1], eye[2], unit);
  const point = viewTurn([at[0] - centre[0], at[1] - centre[1], at[2] - centre[2]], upright);
  const radius = norm(point);
  if (radius < 1e-9) return { azimuth: pose.azimuth, elevation: pose.elevation };
  const basis = screenBasis(yaw, pitch);
  let x = dot(point, basis.right) + dx / scale, y = dot(point, basis.up) - dy / scale;
  const length = Math.hypot(x, y);
  if (length > radius) {
    x *= radius / length;
    y *= radius / length;
  }
  // Keep the hemisphere the drag started in, so the camera does not flip through the subject.
  const sign = dot(point, basis.depth) < 0 ? -1 : 1;
  const z = sign * Math.sqrt(Math.max(0, radius * radius - x * x - y * y));
  const next = viewTurn([0, 1, 2].map((i) => basis.right[i] * x + basis.up[i] * y + basis.depth[i] * z), upright, true);
  // Back to a world direction from the pivot, into the orbit frame, then solve the
  // orbit that produces it.
  const inverse = transpose(orbitFrame(pose.pivot.tilt || 0, pose.pivot.roll || 0, pose.pivot.heading || 0));
  const v = mulVec(inverse, scaled([next[0], -next[1], -next[2]], 1 / radius));
  return solveOrbit([0, 0, -1], v, pose);
}

/**
 * Turns a pointer drag into truck (lateral) and boom (height), leaving the orbit alone.
 *
 * Both axes are measured in units of pivotZ, and `scenePoint` scales world units by
 * 1.8/pivotZ, so one unit of either axis is 1.8 scene units. Truck runs along the
 * camera's own right axis, which tilts with elevation, so the two axes are not
 * orthogonal and the split is a 2x2 least-squares solve rather than a projection.
 * @param {object} pose Pose the drag started from, from `poseAt`.
 * @param {number} dx Total pointer movement in x, in scene-canvas layout pixels.
 * @param {number} dy Total pointer movement in y.
 * @param {number} scale Scene scale at drag start.
 * @param {number} yaw Observer yaw at drag start.
 * @param {number} pitch Observer pitch at drag start.
 * @param {number[][]|null} [upright] Rotation the view was drawn with, if stood upright.
 * @returns {{lateral: number, height: number}} New offsets, in units of pivotZ.
 */
export function dragTruck(pose, dx, dy, scale, yaw, pitch, upright = null) {
  const basis = screenBasis(yaw, pitch);
  const wanted = viewTurn([0, 1, 2].map((i) => (basis.right[i] * dx - basis.up[i] * dy) / (scale * 1.8)), upright, true);
  // The same truck and boom directions orbitCamera uses: the orbit's right axis
  // and the orbit frame's up.
  const frame = orbitFrame(pose.pivot?.tilt || 0, pose.pivot?.roll || 0, pose.pivot?.heading || 0);
  const right = mulVec(frame, rotate(pose, [1, 0, 0]));
  const up = mulVec(frame, [0, -1, 0]);
  const truck = [right[0], -right[1], -right[2]];
  const boom = [up[0], -up[1], -up[2]];
  const skew = dot(truck, boom);
  const determinant = 1 - skew * skew;
  let lateral = dot(truck, wanted), height = dot(boom, wanted);
  if (determinant > 1e-6) {
    const [a, b] = [lateral, height];
    lateral = (a - skew * b) / determinant;
    height = (b - skew * a) / determinant;
  }
  return { lateral: (pose.lateral || 0) + lateral, height: (pose.height || 0) + height };
}
