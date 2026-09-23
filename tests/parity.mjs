// Reads a job from stdin, answers with what the browser modules compute.
// tests/test_parity.py compares the answer against the Python implementation.
import { readFileSync } from 'node:fs';
import { poseAt, normalizePath, serializePath } from '../js/interpolate.js';
import { orbitCamera, poseCamera, buildCloud, renderCamera, markerLattice, concatClouds, hexColor } from '../js/geometry.js';

const job = JSON.parse(readFileSync(0, 'utf8'));
const camera = ({ pose, pivot, tilt = 0, roll = 0 }) => {
  const basis = orbitCamera(pose, pivot ?? job.pivot_z, tilt, roll);
  return [basis.right, basis.down, basis.forward, basis.eye];
};

function reproject({ width, height, depth, colors, lens, pose, pivot, tilt = 0, roll = 0, splat, markers = false,
                     background = '#000000' }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = colors[i * 3];
    rgba[i * 4 + 1] = colors[i * 3 + 1];
    rgba[i * 4 + 2] = colors[i * 3 + 2];
  }
  let cloud = buildCloud(Float32Array.from(depth), rgba, width, height, lens);
  if (markers) cloud = concatClouds(cloud, markerLattice(job.pivot_z));
  const target = {
    data: new Uint8ClampedArray(width * height * 4), width, height,
    depth: new Float32Array(width * height),
  };
  const holes = renderCamera(cloud, orbitCamera(pose, pivot ?? job.pivot_z, tilt, roll), lens, target, splat,
                             hexColor(background));
  const pixels = new Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = target.data[i * 4];
    pixels[i * 3 + 1] = target.data[i * 4 + 1];
    pixels[i * 3 + 2] = target.data[i * 4 + 2];
  }
  return { holes, pixels, points: cloud.count };
}

const lattice = markerLattice(job.pivot_z);

process.stdout.write(JSON.stringify({
  poses: job.frames.map(frame => poseAt(job.path, frame)),
  cameras: job.cameras.map(camera),
  resolvedCameras: job.frames.map(frame => {
    const basis = poseCamera(poseAt(job.path, frame), job.pivot_z);
    return [basis.right, basis.down, basis.forward, basis.eye];
  }),
  serialized: serializePath(normalizePath(job.path)),
  renders: job.renders.map(reproject),
  lattice: {
    points: Array.from({ length: lattice.count }, (_, k) => [lattice.x[k], lattice.y[k], lattice.z[k]]),
    colors: Array.from(lattice.color),
  },
}));
