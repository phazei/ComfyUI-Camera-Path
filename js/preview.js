/**
 * Loads the geometry the node cached after its last run.
 *
 * Format is written by `camera_path/preview.py`: an RGB PNG plus a depth PNG with
 * 16-bit depth packed big-endian into R and G; B = 255 is invalid, 127 is pruned,
 * and 0 is kept. Depth is quantised against `z_low` / `z_high` in the metadata.
 */
import { buildCloud } from "./geometry.js";

/**
 * Decodes an image URL to raw RGBA bytes.
 * @param {string} url Image URL.
 * @returns {Promise<Uint8ClampedArray>} RGBA pixels.
 */
async function pixels(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * Unpacks the 16-bit depth PNG.
 * @param {Uint8ClampedArray} rgba Packed depth pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {number} low Depth mapped to 0.
 * @param {number} high Depth mapped to 65535.
 * @returns {Float32Array} Depth per pixel, NaN where invalid.
 */
function decodeDepth(rgba, width, height, low, high) {
  const depth = new Float32Array(width * height), span = high - low;
  for (let i = 0; i < width * height; i++) {
    depth[i] = rgba[i * 4 + 2] > 127 ? NaN : low + (rgba[i * 4] * 256 + rgba[i * 4 + 1]) / 65535 * span;
  }
  return depth;
}

/**
 * Loads the unpruned, maximum-quality samples once for local comparisons.
 * @param {object} meta The `preview` block of the node's UI payload.
 * @param {(reference: object) => string} urlFor Turns a file reference into a URL.
 * @returns {Promise<object>} Raw cache used by createPreview().
 */
export async function loadPreview(meta, urlFor) {
  const { width, height } = meta;
  const samples = await Promise.all(meta.samples.map(async (sample) => {
    const [rgba, packed] = await Promise.all([pixels(urlFor(sample.rgb)), pixels(urlFor(sample.z))]);
    const depth = decodeDepth(packed, width, height, meta.z_low, meta.z_high);
    const keep = new Uint8Array(width * height);
    for (let i = 0; i < keep.length; i++) keep[i] = packed[i * 4 + 2] === 0 ? 1 : 0;
    return { frame: sample.frame, rgba, depth, keep };
  }));
  return { meta, samples };
}

/**
 * Builds only the selected quality/pruning variant, without fetching or re-pruning.
 * @param {object} cache Raw samples returned by loadPreview().
 * @param {string} quality Named preview level.
 * @param {boolean} prune Whether to apply the source-resolution pruning mask.
 * @returns {object} Point clouds and drawing buffers for both editor panes.
 */
export function createPreview(cache, quality, prune) {
  const raw = cache.meta;
  const scale = Math.min(raw.levels[quality] / Math.max(raw.width, raw.height), 1);
  const width = Math.max(1, Math.round(raw.width * scale)), height = Math.max(1, Math.round(raw.height * scale));
  const meta = { ...raw, width, height };
  const lens = { fx: meta.fx * width, fy: meta.fy * height, cx: meta.cx * width, cy: meta.cy * height };
  const samples = cache.samples.map(sample => {
    const depth = new Float32Array(width * height), rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = Math.floor(x * raw.width / width), sy = Math.floor(y * raw.height / height);
      const from = sy * raw.width + sx, to = y * width + x;
      depth[to] = prune && !sample.keep[from] ? NaN : sample.depth[from];
      // Box-average colour, but never interpolate geometry across a silhouette.
      const endX = Math.ceil((x + 1) * raw.width / width), endY = Math.ceil((y + 1) * raw.height / height);
      let r = 0, g = 0, b = 0;
      for (let yy = sy; yy < endY; yy++) for (let xx = sx; xx < endX; xx++) {
        const i = (yy * raw.width + xx) * 4;
        r += sample.rgba[i]; g += sample.rgba[i + 1]; b += sample.rgba[i + 2];
      }
      const n = (endX - sx) * (endY - sy);
      rgba[to * 4] = r / n; rgba[to * 4 + 1] = g / n; rgba[to * 4 + 2] = b / n;
      rgba[to * 4 + 3] = 255;
    }
    return { frame: sample.frame, cloud: buildCloud(depth, rgba, width, height, lens) };
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  return {
    meta, lens, samples, quality, prune,
    pivotZ: meta.pivot_z,
    canvas, context, image,
    target: { data: image.data, width, height, depth: new Float32Array(width * height) },
    // The cache is downscaled, so the node's splat radius shrinks with it.
    splat: Math.max(1, Math.round(meta.splat * width / Math.max(1, meta.source_width))),
  };
}

/**
 * Picks the cached sample nearest a frame. Source frames are sampled sparsely, so
 * scrubbing lands on the closest captured one rather than interpolating geometry.
 * @param {object} preview Preview state from createPreview().
 * @param {number} frame Output frame index.
 * @returns {object} The nearest sample.
 */
export function sampleFor(preview, frame) {
  let best = preview.samples[0];
  for (const sample of preview.samples) {
    if (Math.abs(sample.frame - frame) < Math.abs(best.frame - frame)) best = sample;
  }
  return best;
}
