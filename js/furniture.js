/**
 * Scene furniture for the editor: things drawn in the 3D views that are not part of
 * the render. Everything here is a point cloud in the same world space as the MoGe
 * geometry (+x right, +y down, +z into the scene, source camera at the origin), so it
 * goes through the same z-buffer as the real points and sits behind or in front of
 * them correctly, instead of being an overlay.
 *
 * - The floor grid: a faint ground plane, always drawn, so the view has a sense of
 *   movement even when the scene is sparse. Never exported.
 * - The placeholder: a 1:1 frame and a person, shown until the node has run, so a
 *   move can be blocked out before there is any geometry.
 *
 * The exportable marker lattice is not here; it is part of the render contract and
 * lives in `geometry.js` next to its Python mirror.
 */
import { emptyCloud, concatClouds, orbitFrame } from './geometry.js';

/** Background of both canvases; grid lines fade towards it with distance. */
const BACKGROUND = [0x14, 0x14, 0x19];

/** Half the height of the source image at unit depth, for a 60-degree vertical lens. */
export const DEFAULT_HALF_HEIGHT = Math.tan(Math.PI / 6);

/** Golden angle in radians; spirals built on it never line up into visible rows. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Writes one point into a cloud.
 * @param {object} cloud Cloud from emptyCloud().
 * @param {number} index Slot to write.
 * @param {number[]} point [x, y, z].
 * @param {number[]} color [r, g, b] in 0..255.
 * @returns {void}
 */
function put(cloud, index, point, color) {
  cloud.x[index] = point[0];
  cloud.y[index] = point[1];
  cloud.z[index] = point[2];
  cloud.color[index * 3] = color[0];
  cloud.color[index * 3 + 1] = color[1];
  cloud.color[index * 3 + 2] = color[2];
}

// ── Floor grid ─────────────────────────────────────────────────────────────

/**
 * The ground plane as points along grid lines. It passes through the bottom edge
 * of the source frame's footprint at unit depth -- the centre of the scene is the
 * middle of the image, so the floor is the bottom of it -- and is laid in a pivot's
 * orbit frame, so a pivot that has been straightened gets a level floor.
 * @param {number} unit Automatic pivot depth; every size below is a multiple of it.
 * @param {number} halfHeight Half the image height at unit depth, in units.
 * @param {{tilt?: number, roll?: number}} pivot The pivot whose frame the floor follows.
 * @returns {object} Cloud in world units.
 */
export function floorGrid(unit, halfHeight, pivot) {
  const extent = 2.0, spacing = 0.25, step = 0.006;
  const lines = Math.round(extent * 2 / spacing) + 1;
  const along = Math.round(extent * 2 / step) + 1;
  const frame = orbitFrame(pivot?.tilt || 0, pivot?.roll || 0);
  const right = [frame[0][0], frame[1][0], frame[2][0]];
  const forward = [frame[0][2], frame[1][2], frame[2][2]];
  const anchor = [0, halfHeight * unit, unit];
  const cloud = emptyCloud(lines * along * 2);
  let k = 0;
  for (let i = 0; i < lines; i++) {
    const fixed = -extent + i * spacing;
    const axis = Math.abs(fixed) < 1e-9;
    for (let j = 0; j < along; j++) {
      const moving = -extent + j * step;
      for (const [u, v] of [[fixed, moving], [moving, fixed]]) {
        const fade = Math.max(0, 1 - Math.hypot(u, v) / extent);
        const tone = axis ? 0x40 : 0x30;
        const color = BACKGROUND.map((base, c) => Math.round(base + ([tone, tone, tone + 8][c] - base) * fade));
        put(cloud, k++, [0, 1, 2].map(c => anchor[c] + unit * (right[c] * u + forward[c] * v)), color);
      }
    }
  }
  return cloud;
}

// ── Placeholder ────────────────────────────────────────────────────────────

/**
 * Surface points of an ellipsoid, shaded by a fixed light so the form reads.
 * @param {object} cloud Cloud to write into.
 * @param {number} start First slot.
 * @param {number} count Number of points.
 * @param {number[]} centre [x, y, z].
 * @param {number[]} radii Per-axis radii.
 * @param {number[]} tint Base colour.
 * @returns {number} Next free slot.
 */
function ellipsoid(cloud, start, count, centre, radii, tint) {
  for (let i = 0; i < count; i++) {
    // Fibonacci sphere: even coverage with no randomness.
    const y = 1 - 2 * (i + 0.5) / count;
    const r = Math.sqrt(1 - y * y), angle = i * GOLDEN;
    const n = [r * Math.cos(angle), y, r * Math.sin(angle)];
    const point = [0, 1, 2].map(c => centre[c] + n[c] * radii[c]);
    put(cloud, start + i, point, shade(n, radii, tint));
  }
  return start + count;
}

/**
 * A capsule between two points, sampled on its side and both end caps.
 * @param {object} cloud Cloud to write into.
 * @param {number} start First slot.
 * @param {number} count Number of points.
 * @param {number[]} a One end.
 * @param {number[]} b The other end.
 * @param {number} radius Capsule radius.
 * @param {number[]} tint Base colour.
 * @returns {number} Next free slot.
 */
function capsule(cloud, start, count, a, b, radius, tint) {
  const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...axis);
  const along = axis.map(v => v / length);
  // Two directions across the axis.
  const seed = Math.abs(along[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = cross(along, seed);
  u = u.map(v => v / Math.hypot(...u));
  const w = cross(along, u);
  const side = Math.round(count * length / (length + Math.PI * radius));
  const caps = count - side;
  let k = start;
  for (let i = 0; i < side; i++) {
    const t = (i + 0.5) / side, angle = i * GOLDEN;
    const n = [0, 1, 2].map(c => u[c] * Math.cos(angle) + w[c] * Math.sin(angle));
    const point = [0, 1, 2].map(c => a[c] + axis[c] * t + n[c] * radius);
    put(cloud, k++, point, shade(n, [1, 1, 1], tint));
  }
  for (let i = 0; i < caps; i++) {
    const y = 1 - 2 * (i + 0.5) / caps;
    const r = Math.sqrt(1 - y * y), angle = i * GOLDEN;
    const local = [r * Math.cos(angle), y, r * Math.sin(angle)];
    const n = [0, 1, 2].map(c => u[c] * local[0] + along[c] * local[1] + w[c] * local[2]);
    const end = local[1] < 0 ? a : b;
    put(cloud, k++, [0, 1, 2].map(c => end[c] + n[c] * radius), shade(n, [1, 1, 1], tint));
  }
  return k;
}

/** Light from above, left and in front of the figure (y is down). */
const LIGHT = [-0.45, -0.7, -0.55];

/**
 * Lambert shading of a surface normal against the fixed light.
 * @param {number[]} n Unit normal on the unit sphere.
 * @param {number[]} radii Ellipsoid radii, to bend the normal onto the surface.
 * @param {number[]} tint Base colour.
 * @returns {number[]} Shaded colour.
 */
function shade(n, radii, tint) {
  const bent = [n[0] / radii[0], n[1] / radii[1], n[2] / radii[2]];
  const length = Math.hypot(...bent) || 1;
  const lit = (bent[0] * LIGHT[0] + bent[1] * LIGHT[1] + bent[2] * LIGHT[2]) / length;
  const level = 0.5 + 0.5 * Math.max(0, lit);
  return tint.map(v => Math.round(v * level));
}

/**
 * A person standing on the floor, facing the camera, built from a handful of
 * ellipsoids and capsules. Deliberately a rounded silhouette rather than a boxy
 * mannequin. Roughly 2,400 points.
 * @param {number} unit Automatic pivot depth.
 * @param {number} halfHeight Half the image height at unit depth, in units.
 * @returns {object} Cloud in world units.
 */
export function placeholderFigure(unit, halfHeight) {
  const h = 1.6 * halfHeight * unit;          // figure height
  const top = (halfHeight * unit) - h;        // y of the top of the head; feet on the floor
  const z = unit;
  const skin = [172, 178, 196];
  const at = (x, y, depth = 0) => [x * h, top + y * h, z + depth * h];
  const parts = [
    [ellipsoid, 320, at(0, 0.075), [0.062 * h, 0.075 * h, 0.068 * h]],
    [capsule, 60, at(0, 0.14), at(0, 0.18), 0.028 * h],
    [ellipsoid, 520, at(0, 0.31), [0.14 * h, 0.15 * h, 0.075 * h]],
    [ellipsoid, 260, at(0, 0.49), [0.115 * h, 0.075 * h, 0.07 * h]],
  ];
  for (const side of [-1, 1]) {
    parts.push([capsule, 240, at(side * 0.165, 0.2), at(side * 0.2, 0.54), 0.035 * h]);
    parts.push([capsule, 320, at(side * 0.065, 0.53), at(side * 0.075, 0.96), 0.05 * h]);
    parts.push([ellipsoid, 70, at(side * 0.08, 0.975, -0.02), [0.05 * h, 0.025 * h, 0.075 * h]]);
  }
  const cloud = emptyCloud(parts.reduce((sum, [, count]) => sum + count, 0));
  let k = 0;
  for (const [build, count, ...shape] of parts) k = build(cloud, k, count, ...shape, skin);
  return cloud;
}

/**
 * A square outline at unit depth, the height of the source frame: a stand-in for the
 * footprint of the image the node has not seen yet. Square on purpose, so it is not
 * guessing at the aspect.
 * @param {number} unit Automatic pivot depth.
 * @param {number} halfHeight Half the image height at unit depth, in units.
 * @returns {object} Cloud in world units.
 */
export function placeholderFrame(unit, halfHeight) {
  const side = halfHeight * unit, step = 0.004 * unit;
  const per = Math.round(side * 2 / step);
  const cloud = emptyCloud(per * 4);
  const color = [0x5a, 0x5a, 0x70];
  let k = 0;
  for (let i = 0; i < per; i++) {
    const t = -side + i * step;
    put(cloud, k++, [t, -side, unit], color);
    put(cloud, k++, [t, side, unit], color);
    put(cloud, k++, [-side, t, unit], color);
    put(cloud, k++, [side, t, unit], color);
  }
  return cloud;
}

/**
 * A preview in the shape `preview.loadPreview` returns, holding the placeholder
 * scene instead of cached geometry, so the editor draws it through exactly the same
 * path and the camera pane reprojects it too.
 * @param {number} size Side of the square camera-pane target, in pixels.
 * @returns {object} Preview state with `placeholder: true`.
 */
export function placeholderPreview(size = 384) {
  const halfHeight = DEFAULT_HALF_HEIGHT;
  const fy = 0.5 / halfHeight;
  const meta = { width: size, height: size, source_width: size, source_height: size,
                 fx: fy, fy, cx: 0.5, cy: 0.5, pivot_z: 1, splat: 1 };
  const lens = { fx: fy * size, fy: fy * size, cx: 0.5 * size, cy: 0.5 * size };
  const cloud = concatClouds(placeholderFrame(1, halfHeight), placeholderFigure(1, halfHeight));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  return {
    placeholder: true,
    meta, lens, pivotZ: 1,
    samples: [{ frame: 0, cloud }],
    canvas, context, image,
    target: { data: image.data, width: size, height: size, depth: new Float32Array(size * size) },
    splat: 2,
  };
}
