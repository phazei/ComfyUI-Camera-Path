/**
 * Loads the geometry the node cached after its last run.
 *
 * Format is written by `camera_path/preview.py`: an RGB PNG plus a depth PNG with
 * 16-bit depth packed big-endian into R and G, and B = 255 marking invalid pixels.
 * Both are quantised against the `z_low` / `z_high` range in the metadata.
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
 * Loads every cached sample into point clouds plus the buffers the editor draws with.
 * @param {object} meta The `preview` block of the node's UI payload.
 * @param {(reference: object) => string} urlFor Turns a file reference into a URL.
 * @returns {Promise<object>} Preview state for the editor.
 */
export async function loadPreview(meta, urlFor) {
  const { width, height } = meta;
  const lens = { fx: meta.fx * width, fy: meta.fy * height, cx: meta.cx * width, cy: meta.cy * height };
  const samples = await Promise.all(meta.samples.map(async (sample) => {
    const [rgba, packed] = await Promise.all([pixels(urlFor(sample.rgb)), pixels(urlFor(sample.z))]);
    const depth = decodeDepth(packed, width, height, meta.z_low, meta.z_high);
    return { frame: sample.frame, cloud: buildCloud(depth, rgba, width, height, lens) };
  }));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  return {
    meta, lens, samples,
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
 * @param {object} preview Preview state from loadPreview().
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
