// Drives js/editor.js inside jsdom: DOM wiring, pointer interaction, playback and the
// cached-cloud preview, none of which the pure-math parity test can reach.
// Needs a local `npm install jsdom`; tests/test_editor.py skips this when it is missing.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;

// jsdom has no 2D canvas. A recording stub is enough to prove the drawing code runs.
const calls = new Set();
const topTicks = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  let drawn, lineStart, lineEnd;
  const record = name => (...ignored) => { calls.add(name); };
  const data = (w, h) => ({ data: new window.Uint8ClampedArray(w * h * 4), width: w, height: h });
  return {
    canvas: this,
    setTransform: record('setTransform'), fillRect: record('fillRect'), clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: (...point) => { lineStart = point; calls.add('moveTo'); },
    lineTo: (...point) => { lineEnd = point; calls.add('lineTo'); },
    stroke() {
      calls.add('stroke');
      if (this.strokeStyle === '#8c4cff' && this.lineWidth === 1.5) topTicks.push([lineStart, lineEnd]);
    },
    arc: record('arc'), fill: record('fill'), fillText: record('fillText'),
    drawImage: image => { drawn = image; calls.add('drawImage'); }, putImageData: record('putImageData'),
    createImageData: data, getImageData: (x, y, w, h) => {
      const image = data(w, h);
      if (drawn?.src?.includes('z.png')) {
        for (let i = 0; i < w * h; i++) {
          const column = i % w;
          image.data[i * 4 + 2] = column < w / 4 ? 127 : column >= w - 8 ? 255 : 0;
        }
      }
      return image;
    },
  };
};
for (const [name, value] of Object.entries({ clientWidth: 400, clientHeight: 300 })) {
  Object.defineProperty(window.HTMLElement.prototype, name, { get: () => value, configurable: true });
}
// ComfyUI scales the whole graph, so getBoundingClientRect (screen pixels) and
// clientWidth/clientHeight (layout pixels) disagree at any zoom but 100%. Run the
// whole suite zoomed out; the editor has to convert between the two.
const ZOOM = 0.5;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ left: 30, top: 20, right: 30 + 400 * ZOOM, bottom: 20 + 300 * ZOOM,
     width: 400 * ZOOM, height: 300 * ZOOM, x: 30, y: 20 });
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
window.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(target) { target.resize = this.callback; }
  disconnect() {}
};
let imageLoads = 0, decodeWait = null;
window.Image = class {
  constructor() { this.naturalWidth = 768; this.naturalHeight = 576; }
  async decode() { imageLoads++; if (decodeWait) await decodeWait; }
};
const clock = { now: () => Date.now() };
window.requestAnimationFrame = callback => window.setTimeout(() => callback(clock.now()), 16);
window.cancelAnimationFrame = handle => window.clearTimeout(handle);

for (const name of ['document', 'HTMLElement', 'Image', 'ResizeObserver', 'requestAnimationFrame',
                    'cancelAnimationFrame', 'Event', 'CustomEvent']) {
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'performance', { value: clock, configurable: true, writable: true });
globalThis.window = window;

// jsdom refuses to implement confirm(); the editor only needs a yes/no.
let confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;

const { createCameraEditor, spreadMarkers } = await import(new URL('../js/editor.js', import.meta.url));
const { cameraScenePosition, poseCamera, dragOrbit, dragTruck, uprightRotation, renderScene } = await import(new URL('../js/geometry.js', import.meta.url));

// Scene splats grow without giving up clipping or depth occlusion.
{
  const target = { width: 9, height: 9, data: new Uint8ClampedArray(9 * 9 * 4), depth: new Float32Array(81) };
  const cloud = { count: 1, x: [0], y: [0], z: [1], color: [255, 0, 0] };
  const view = { yaw: 0, pitch: 0, scale: 100, originX: 4, originY: 4 };
  target.depth.fill(Infinity);
  renderScene(cloud, view, target, 1, 1, 2);
  if (target.data.filter((v, i) => i % 4 === 3 && v).length !== 13) throw Error('scene splat footprint');
  cloud.z = [0.5]; cloud.color = [0, 255, 0];
  renderScene(cloud, view, target, 1, 1, 2);
  if (target.data[(4 * 9 + 4) * 4] !== 255) throw Error('scene splat occlusion');
  view.originX = -1;
  renderScene(cloud, view, target, 1, 1, 2);
}
const { poseAt } = await import(new URL('../js/interpolate.js', import.meta.url));
const { loadPreview, createPreview } = await import(new URL('../js/preview.js', import.meta.url));

let stored = JSON.stringify([
  { frame: 0, azimuth: 0, elevation: 0, distance: 1, lateral: 0, height: 0 },
  { frame: 48, azimuth: 20, elevation: 0, distance: 1, lateral: 0, height: 0 },
]);
let markers = false;
let fps = 24;
let prune = true, quality = 'Medium (512)';
const editor = createCameraEditor({
  readPath: () => stored,
  writePath: value => { stored = value; },
  readFrameCount: () => 49,
  readFps: () => fps,
  readMarkers: () => markers,
  readPrune: () => prune,
  readQuality: () => quality,
});
window.document.body.append(editor.element);

const element = editor.element;
const scene = element.querySelector('.scene');
const path = () => JSON.parse(stored).camera;
const pivots = () => JSON.parse(stored).pivots;
const check = (label, condition) => {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`ok  ${label}`);
};
const click = action => element.querySelector(`[data-action=${action}]`)
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const pointer = (target, type, x, y = 10, init = {}) => target.dispatchEvent(
  new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...init }));

/** Layout pixels inside the scene canvas -> the screen coordinates an event carries. */
const onScreen = (x, y) => [30 + x * ZOOM, 20 + y * ZOOM];

/**
 * The editor's own scene projector, to predict where a gizmo is drawn. The view turns
 * about `centre`, which is the view pivot's scene position (the origin until a pivot is
 * moved or another one selected).
 */
const project = ([x, y, z], centre = [0, 0, 0]) => {
  const yaw = 0.55, pitch = 0.45, scale = Math.min(400 * 0.105, 58);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  x -= centre[0]; y -= centre[1]; z -= centre[2];
  return [200 + (x * cy - z * sy) * scale, 300 * 0.54 - (y * cp - (x * sy + z * cy) * sp) * scale];
};

/** Drags from one point in scene layout space to another, in screen coordinates. */
const dragScene = (from, to, init = {}) => {
  pointer(scene, 'pointerdown', ...onScreen(...from), init);
  pointer(scene, 'pointermove', ...onScreen(...to), init);
  pointer(scene, 'pointerup', ...onScreen(...to), init);
};

const groups = [...element.querySelectorAll('.groups[data-panel=camera] .group')];
check('builds the viewport, timeline and axis fields',
      element.querySelectorAll('.groups[data-panel=camera] .field:not(.lock)').length === 10
      && element.querySelectorAll('.fields[data-panel=pivot] .field').length === 6
      && element.querySelector('.fields[data-panel=pivot]').hidden
      && element.querySelector('.field.lock') !== null
      && element.querySelectorAll('.key').length === 2
      && element.querySelector('.scene') !== null);
check('groups the camera axes by what they do',
      groups.map(group => group.querySelector('legend').textContent).join() === 'Orbit,Aim,Position,Pivot'
      && groups.map(group => group.querySelectorAll('.field').length).join() === '3,3,3,2'
      && groups[0].querySelector('[data-role=orbit-dial]') !== null
      && groups[1].querySelector('.field.lock') !== null
      && groups[3].querySelector('[data-role=pivot]') !== null
      && groups[3].querySelector('[data-role=pivot-target]') !== null);
check('draws the scene', calls.has('arc') && calls.has('stroke'));
{
  const saved = stored;
  editor.loadPath([{ frame: 0, roll: 0 }]);
  const upright = topTicks.at(-1);
  editor.loadPath([{ frame: 0, roll: 180 }]);
  const inverted = topTicks.at(-1);
  const centre = project([0, 0, 0]);
  check('frustum top tick follows a 180-degree camera roll',
        upright && inverted && Math.hypot(upright[1][0] - upright[0][0], upright[1][1] - upright[0][1]) > 1
        && upright.every((point, end) => point.every((value, axis) =>
          Math.abs(value + inverted[end][axis] - 2 * centre[axis]) < 1e-9)));
  editor.loadPath(JSON.parse(saved));
}
check('delete keyframe lives beside reset key and reset aim is removed',
      element.querySelector('[data-action=remove]').parentElement
      === element.querySelector('[data-action=reset-key]').parentElement
      && !element.querySelector('[data-action=reset-aim]'));

/** The round controls' CSS size, which jsdom cannot lay out for itself. */
const ROUND = 76;
const dial = element.querySelector('[data-role=orbit-dial]');
const puck = element.querySelector('[data-role=aim-puck]');
for (const control of [dial, puck]) {
  control.getBoundingClientRect = () => ({ left: 30, top: 20, width: ROUND * ZOOM, height: ROUND * ZOOM });
}
const azimuth = dial.querySelector('input');
const aimNumber = name => element.querySelector(`input[aria-label^="${name}"]`);
/** Circle coordinates, right/up positive, converted to screen pixels at graph zoom. */
const roundPointer = (control, type, x, y) => pointer(control, type,
  30 + (ROUND / 2 + x * ROUND * 0.4) * ZOOM, 20 + (ROUND / 2 - y * ROUND * 0.4) * ZOOM);
const beforeRound = stored;
editor.loadPath([{ frame: 0, azimuth: 350, roll: 12 }]);
azimuth.focus();
roundPointer(dial, 'pointerdown', 0, 1);
for (let turn = 0; turn < 2; turn++) {
  for (const [x, y] of [[1, 0], [0, -1], [-1, 0], [0, 1]]) roundPointer(dial, 'pointermove', x, y);
  if (!turn) check('orbit dial accumulates beyond a full turn', path()[0].azimuth === 710);
}
check('orbit dial respects the existing multiple-turn limit', path()[0].azimuth === 720);
check('dial updates the number after numeric editing', azimuth.value === '720');
roundPointer(dial, 'pointerup', 0, 1);
roundPointer(dial, 'pointermove', 1, 0);
check('releasing the dial ends the gesture', path()[0].azimuth === 720);
azimuth.value = '-350';
azimuth.dispatchEvent(new window.Event('input', { bubbles: true }));
roundPointer(dial, 'pointerdown', 0, 1);
for (const [x, y] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) roundPointer(dial, 'pointermove', x, y);
check('reverse orbit dial passes the angle seam without wrapping', path()[0].azimuth === -710);
roundPointer(dial, 'pointercancel', 0, 1);
roundPointer(dial, 'pointermove', -1, 0);
check('cancelling the dial ends the gesture', path()[0].azimuth === -710);
azimuth.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
check('double-clicking the dial centre zeros azimuth', path()[0].azimuth === 0 && azimuth.value === '0');
roundPointer(puck, 'pointerdown', 0.5, 0);
check('aim puck uses graph-zoom independent coordinates', path()[0].pan === 45 && path()[0].tilt === 0);
roundPointer(puck, 'pointermove', 1, 1);
check('aim puck reaches both axis limits', path()[0].pan === 90 && path()[0].tilt === 90);
roundPointer(puck, 'pointerup', 1, 1);
const shownX = (parseFloat(puck.querySelector('i').style.left) - 50) / 40;
const shownY = (50 - parseFloat(puck.querySelector('i').style.top)) / 40;
roundPointer(puck, 'pointerdown', shownX, shownY);
roundPointer(puck, 'lostpointercapture', shownX, shownY);
roundPointer(puck, 'pointermove', -1, 0);
check('puck display round-trips its aim and losing capture stops edits', path()[0].pan === 90 && path()[0].tilt === 90);
aimNumber('Tilt').value = '-23';
aimNumber('Tilt').dispatchEvent(new window.Event('input', { bubbles: true }));
check('aim keeps precise numeric entry', path()[0].tilt === -23);
aimNumber('Pan').value = '150';
aimNumber('Pan').dispatchEvent(new window.Event('input', { bubbles: true }));
check('typing reaches the half turn the puck cannot, parking the mark on its rim',
      path()[0].pan === 150
      && Math.abs(parseFloat(puck.querySelector('i').style.left) - 50) <= 40
      && Math.abs(parseFloat(puck.querySelector('i').style.top) - 50) <= 40);
aimNumber('Pan').value = '0';
aimNumber('Pan').dispatchEvent(new window.Event('input', { bubbles: true }));
click('recentre-aim');
check('puck recentre leaves roll and orbit alone',
      path()[0].pan === 0 && path()[0].tilt === 0 && path()[0].roll === 12 && path()[0].azimuth === 0);
check('each round control leads the group it belongs to, ahead of that group\'s sliders',
      !element.classList.contains('wide')
      && [dial, puck].every((round, index) =>
        round.closest('.group') === groups[index]
        && round.parentElement.nextElementSibling.classList.contains('stack')));
Object.defineProperty(element, 'clientWidth', { value: 800, configurable: true });
element.resize();
check('wide layout retains both round controls and numeric entry',
      element.classList.contains('wide') && element.contains(dial) && element.contains(aimNumber('Pan')));
delete element.clientWidth;
element.resize();
editor.loadPath(JSON.parse(beforeRound));

// Orbit and truck gestures must use the same local axes even far from the source.
const tilted = poseAt({
  pivots: [{ id: 'far', keys: [{ frame: 0, x: 3, y: -2, z: 20, tilt: -25, roll: 15 }] }],
  camera: [{ frame: 0, pivot: 'far', azimuth: 20, elevation: 10, distance: 1.4 }],
}, 0);
const upright = uprightRotation(tilted.pivot);
const stationary = dragOrbit(tilted, 2, 0, 0, 42, 0.55, 0.45, upright);
check('zero orbit drag preserves angles around a distant tilted pivot',
      Math.abs(stationary.azimuth - tilted.azimuth) < 1e-9
      && Math.abs(stationary.elevation - tilted.elevation) < 1e-9);
const local = { ...tilted, pivot: { ...tilted.pivot, x: 0, y: 0, z: 1 } };
const distantDrag = dragOrbit(tilted, 2, 3, -2, 42, 0.55, 0.45, upright);
const localDrag = dragOrbit(local, 2, 3, -2, 42, 0.55, 0.45, upright);
check('orbit dragging is independent of pivot position',
      Math.abs(distantDrag.azimuth - localDrag.azimuth) < 1e-9
      && Math.abs(distantDrag.elevation - localDrag.elevation) < 1e-9);
const headed = { ...tilted, pivot: { ...tilted.pivot, heading: 65 } };
const heldHeading = dragOrbit(headed, 2, 0, 0, 42, 0.55, 0.45, upright);
const heldDolly = dragOrbit({ ...headed, pan: 50, tilt: 20, dolly: 2 }, 2, 0, 0, 42, 0.55, 0.45, upright);
check('orbit dragging excludes the final dolly offset',
      Math.abs(heldDolly.azimuth - headed.azimuth) < 1e-9
      && Math.abs(heldDolly.elevation - headed.elevation) < 1e-9);
check('orbit dragging preserves azimuth relative to heading',
      Math.abs(heldHeading.azimuth - headed.azimuth) < 1e-9
      && Math.abs(heldHeading.elevation - headed.elevation) < 1e-9);
check('pivot heading does not rotate the overview',
      JSON.stringify(uprightRotation(headed.pivot)) === JSON.stringify(upright));
const tiltedTruck = dragTruck(tilted, 3, -2, 42, 0.55, 0.45, upright);
const flatTruck = dragTruck({ ...local, pivot: { ...local.pivot, tilt: 0, roll: 0 } },
                            3, -2, 42, 0.55, 0.45);
check('truck dragging uses the pivot axes in the upright view',
      Math.abs(tiltedTruck.lateral - flatTruck.lateral) < 1e-9
      && Math.abs(tiltedTruck.height - flatTruck.height) < 1e-9);

const track = element.querySelector('.track');
const trackX = (fraction) => 30 + fraction * 400 * ZOOM;
{
  const saved = stored;
  const fixture = {
    pivots: [
      { id: 'a', keys: [{ frame: 0, x: -0.4, z: 1.3, tilt: 12, roll: -5, heading: 25 }] },
      { id: 'b', keys: [{ frame: 0, x: 0.8, y: 0.2, z: 2, tilt: -10, roll: 8, heading: 110 }] },
      { id: 'c', keys: [{ frame: 0, x: -1, z: 1.8 }] },
    ],
    camera: [{ frame: 0, pivot: 'a', azimuth: 120, pan: 15, dolly: 0.2 },
             { frame: 48, pivot: 'b', azimuth: 190, elevation: 12, lock: 1, height: 0.3 }],
  };
  editor.loadPath(fixture);
  for (const frame of [24, 36, 12, 30]) {
    pointer(track, 'pointerdown', trackX(frame / 48));
    pointer(track, 'pointerup', trackX(frame / 48));
    const before = poseCamera(poseAt(JSON.parse(stored), frame), 1);
    click('add');
    const inserted = path().find(key => key.frame === frame);
    const after = poseCamera(poseAt(JSON.parse(stored), frame), 1);
    check(`insertion at ${frame} inherits the explicit pivot pair`,
          inserted?.pivot === 'a' && inserted.pivot_target === 'b' && inserted.pivot_blend > 0 && inserted.pivot_blend < 1);
    check(`insertion at ${frame} preserves position and orientation`,
          ['eye', 'right', 'down', 'forward'].every(name => before[name].every((value, i) => Math.abs(value - after[name][i]) < 0.001)));
  }
  const blendInput = [...element.querySelectorAll('.field')].find(field => field.textContent.startsWith('Blend %')).querySelector('input[type=number]');
  blendInput.value = '25';
  blendInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('blend percentage is editable and stored as a fraction', path().find(key => key.frame === 30).pivot_blend === 0.25);
  const target = element.querySelector('[data-role=pivot-target]');
  target.value = 'c';
  target.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('blend target is explicitly editable', path().find(key => key.frame === 30).pivot_target === 'c');
  // A span mixing three pivots cannot be stored as a blend, so it is fitted instead.
  pointer(track, 'pointerdown', trackX(27 / 48));
  pointer(track, 'pointerup', trackX(27 / 48));
  const mixed = poseCamera(poseAt(JSON.parse(stored), 27), 1);
  const timers = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => (delay === 10000 ? timers.push(callback) && 0 : realTimeout(callback, delay));
  click('add');
  const estimated = path().find(key => key.frame === 27);
  const fitted = poseCamera(poseAt(JSON.parse(stored), 27), 1);
  check('a mixed span still inserts, on the pivot the camera was heading for',
        estimated?.pivot === 'b' && estimated.pivot_target === 'b' && estimated.pivot_blend === 0
        && estimated.lateral === 0 && estimated.height === 0 && estimated.dolly === 0);
  check('the fitted keyframe reproduces the shot it was inserted at',
        ['eye', 'right', 'down', 'forward'].every(name =>
          fitted[name].every((value, i) => Math.abs(value - mixed[name][i]) < 0.005)));
  const notice = element.querySelector('.status');
  check('the estimate is announced without claiming an error',
        /^Added on pivot 2; pose (estimated|approximate)\.$/.test(notice.textContent)
        && !notice.classList.contains('error'));
  timers.pop()();
  check('the notice clears itself instead of staying forever', notice.textContent === '');
  globalThis.setTimeout = realTimeout;
  pointer(track, 'pointerdown', trackX(40 / 48));
  pointer(track, 'pointerup', trackX(40 / 48));
  click('add');
  check('an exact insertion says nothing', notice.textContent === '');

  editor.loadPath([{ frame: 0, azimuth: -90 }, { frame: 48, azimuth: 90 }]);
  click('view-reset');
  pointer(element.querySelectorAll('.key')[1], 'pointerdown', trackX(1));
  pointer(track, 'pointerup', trackX(1));
  pointer(track, 'pointerdown', trackX(0.5));
  pointer(track, 'pointerup', trackX(0.5));
  const live = project(cameraScenePosition(poseAt(JSON.parse(stored), 24), 1));
  const beforeRing = stored;
  dragScene(live, [live[0] + 20, live[1] + 10]);
  check('live ring does not seek to or modify the selected distant key',
        element.querySelector('.cursor').style.left === '50%' && stored === beforeRing);
  click('remove');
  check('deleting the last key also clears selection without seeking',
        path().length === 1 && !element.querySelector('.key.selected')
        && element.querySelector('.cursor').style.left === '50%'
        && element.querySelector('.groups[data-panel=camera]').hidden);
  const afterDelete = stored;
  element.querySelector('.viewport').dispatchEvent(new window.WheelEvent('wheel', {
    bubbles: true, altKey: true, deltaY: 50,
  }));
  check('distance gesture cannot edit a camera after deletion cleared selection', stored === afterDelete);

  // Keep shot re-solves the camera around its new pivot instead of letting it jump.
  const reattach = JSON.stringify({ pivots: fixture.pivots, camera: [
    { frame: 0, pivot: 'a', azimuth: 35, elevation: 12, distance: 1.3,
      lateral: 0.2, height: -0.15, dolly: 0.1, pan: 6, tilt: -4, roll: 9 },
    { frame: 48, pivot: 'a', azimuth: 60 }] });
  const hold = element.querySelector('[data-role=hold-pose]');
  const pick = element.querySelector('[data-role=pivot]');
  const reassign = keep => {
    editor.loadPath(JSON.parse(reattach));
    const was = poseCamera(poseAt(JSON.parse(stored), 0), 1);
    hold.checked = keep;
    pick.value = 'b';
    pick.dispatchEvent(new window.Event('change', { bubbles: true }));
    return [was, poseCamera(poseAt(JSON.parse(stored), 0), 1)];
  };
  const [was, moved] = reassign(false);
  check('changing pivot leaves the camera behind by default',
        path()[0].pivot === 'b' && path()[0].azimuth === 35
        && moved.eye.some((value, i) => Math.abs(value - was.eye[i]) > 0.05));
  const [, kept] = reassign(true);
  check('keep shot re-solves the axes so the camera stays where it was',
        path()[0].pivot === 'b' && path()[0].azimuth !== 35
        && path()[0].lateral === 0 && path()[0].height === 0 && path()[0].dolly === 0
        && ['eye', 'right', 'down', 'forward'].every(name =>
          kept[name].every((value, i) => Math.abs(value - was[name][i]) < 0.005)));
  check('and the notice names the pivot it was moved to',
        /^Moved to pivot 2; pose (estimated|approximate)\.$/.test(element.querySelector('.status').textContent));
  editor.loadPath(JSON.parse(saved));
}
pointer(track, 'pointerdown', trackX(0.5));
pointer(track, 'pointerup', trackX(0.5));
check('scrubbing moves the playhead', element.querySelector('.cursor').style.left !== '0%');

click('add');
check('add inserts a keyframe on the playhead', path().length === 3 && path().some(key => key.frame === 24));
click('remove');
check('remove drops it again', path().length === 2);
check('deleting leaves the playhead in place and clears selection',
      element.querySelector('.cursor').style.left === '50%'
      && !element.querySelector('.key.selected')
      && element.querySelector('[data-role=selection]').textContent === 'No camera selected');
pointer(element.querySelector('.key'), 'pointerdown', trackX(0));
pointer(track, 'pointerup', trackX(0));

const slider = [...element.querySelectorAll('.field')].find(field => field.textContent.startsWith('Elevation')).querySelector('input[type=range]');
slider.value = '35';
slider.dispatchEvent(new window.Event('input', { bubbles: true }));
check('a slider edits the selected keyframe', path().some(key => key.elevation === 35));

dragScene([8, 8], [48, 38]);
check('dragging the background only turns the view', path().length === 2);

// The gizmo sits where the projector puts it, in layout pixels; the pointer arrives in
// screen pixels. Regression for the two being conflated, which broke grabbing at any
// graph zoom but 100%.
click('view-reset');
stored = JSON.stringify([{ frame: 0, azimuth: 0, elevation: 0, distance: 1, lateral: 0, height: 0 }]);
editor.sync();
const gizmo = project(cameraScenePosition(poseAt(JSON.parse(stored), 0), 1));
pointer(scene, 'pointermove', ...onScreen(...gizmo));
check('hovering the gizmo offers a grab cursor', scene.style.cursor === 'grab');

for (let i = 0; i < 8; i++) click('zoom-in');
const magnification = 1.25 ** 8;
pointer(scene, 'pointermove', ...onScreen(
  200 + (gizmo[0] - 200) * magnification,
  162 + (gizmo[1] - 162) * magnification));
check('zoom buttons magnify beyond the old 4x limit', scene.style.cursor === 'grab');
click('view-reset');
element.querySelector('.viewport').dispatchEvent(new window.WheelEvent('wheel', {
  bubbles: true, deltaY: -Math.log(5) / 0.0015,
}));
pointer(scene, 'pointermove', ...onScreen(200 + (gizmo[0] - 200) * 5, 162 + (gizmo[1] - 162) * 5));
check('wheel zoom magnifies beyond the old 4x limit', scene.style.cursor === 'grab');
click('view-reset');

// Panning slides everything with the pointer, so the gizmo is no longer where it was
// and the path is untouched; a double-click on the background brings it back.
const untouched = stored;
dragScene([8, 8], [38, 8], { shiftKey: true });
pointer(scene, 'pointermove', ...onScreen(...gizmo));
check('shift+drag pans the view without touching the path',
      scene.style.cursor === 'move' && stored === untouched);
pointer(scene, 'pointermove', ...onScreen(gizmo[0] + 30, gizmo[1]));
check('the gizmo moved with the pan', scene.style.cursor === 'grab');
dragScene([8, 8], [8, 28], { button: 1 });
pointer(scene, 'pointermove', ...onScreen(gizmo[0] + 30, gizmo[1] + 20));
check('the middle button pans too', scene.style.cursor === 'grab');
scene.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 30 + 8 * ZOOM, clientY: 20 + 8 * ZOOM }));
pointer(scene, 'pointermove', ...onScreen(...gizmo));
check('double-clicking the background recentres the view', scene.style.cursor === 'grab');

for (const chosen of [0, 1]) {
  editor.loadPath([{ frame: 0 }, { frame: 48 }]);
  pointer(element.querySelectorAll('.key')[chosen], 'pointerdown', 0);
  pointer(track, 'pointerup', 0);
  dragScene(gizmo, [gizmo[0] + 30, gizmo[1]]);
  check(`overlapping cameras keep selected camera ${chosen + 1} draggable`,
        path()[chosen].azimuth !== 0 && path()[1 - chosen].azimuth === 0);
}
editor.loadPath([{ frame: 0 }, { frame: 48 }]);
click('add-pivot');
dragScene(gizmo, [gizmo[0] + 30, gizmo[1]]);
check('without a selected camera the last drawn overlapping marker wins',
      path()[1].azimuth !== 0 && path()[0].azimuth === 0);
editor.loadPath([{ frame: 0 }]);
dragScene(gizmo, [gizmo[0] + 30, gizmo[1]]);
check('the gizmo can be grabbed and orbited while the graph is zoomed', path()[0].azimuth !== 0);

// Markers that would stack are nudged apart so each one stays readable and grabbable.
const apart = (a, b) => Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
const clear = spreadMarkers([{ point: [100, 100], radius: 9 }, { point: [100, 100], radius: 11 }]);
// A relaxation converges on the gap rather than landing on it, hence the tolerance.
check('markers on the same pixel are pushed clear of each other', apart(...clear) > 9 + 11 + 2.99);
check('a spread marker still knows the point it stands for',
      clear.every(mark => mark.point[0] === 100 && mark.point[1] === 100));
const same = spreadMarkers([{ point: [10, 10], radius: 9 }, { point: [100, 100], radius: 9 }]);
check('markers that already clear each other are not moved',
      same.every(mark => mark.at[0] === mark.point[0] && mark.at[1] === mark.point[1]));
const crowd = spreadMarkers(Array.from({ length: 24 }, () => ({ point: [100, 100], radius: 9 })));
check('a crowd of markers stays within reach of the point it came from',
      crowd.every(mark => Math.hypot(mark.at[0] - 100, mark.at[1] - 100) <= 90.001));
check('spreading is deterministic, so the scene does not shuffle on every redraw',
      JSON.stringify(spreadMarkers([{ point: [5, 5], radius: 9 }, { point: [5, 5], radius: 9 },
                                    { point: [5, 5], radius: 9 }]))
      === JSON.stringify(spreadMarkers([{ point: [5, 5], radius: 9 }, { point: [5, 5], radius: 9 },
                                        { point: [5, 5], radius: 9 }])));

stored = JSON.stringify([{ frame: 0, azimuth: 0, elevation: 0, distance: 1, lateral: 0, height: 0 }]);
editor.sync();
dragScene(gizmo, [gizmo[0] + 30, gizmo[1] - 20], { ctrlKey: true });
check('ctrl+drag trucks and booms instead of orbiting',
      path()[0].azimuth === 0 && path()[0].lateral > 0 && path()[0].height > 0);

click('reset-key');
check('reset key returns the selected keyframe to the source camera',
      path()[0].lateral === 0 && path()[0].height === 0 && path()[0].frame === 0);

const lock = element.querySelector('.field.lock input');
lock.checked = true;
lock.dispatchEvent(new window.Event('change', { bubbles: true }));
check('lock on target is stored as a number so it can be interpolated', path()[0].lock === 1);

const pan = aimNumber('Pan');
pan.value = '25';
pan.dispatchEvent(new window.Event('input', { bubbles: true }));
check('pan is editable', path()[0].pan === 25);
const dollyField = [...element.querySelectorAll('.field')].find(field => field.textContent.startsWith('Dolly'));
const dollySlider = dollyField.querySelector('input[type=range]');
dollySlider.value = '0.75';
dollySlider.dispatchEvent(new window.Event('input', { bubbles: true }));
check('dolly slider serializes a forward move without changing aim', path()[0].dolly === 0.75 && path()[0].pan === 25);
const dollyNumber = dollyField.querySelector('input[type=number]');
dollyNumber.value = '-0.25';
dollyNumber.dispatchEvent(new window.Event('input', { bubbles: true }));
check('dolly supports precise backward movement', path()[0].dolly === -0.25);
click('recentre-aim');
check('recentre zeroes pan and tilt but leaves dolly and lock alone',
      path()[0].pan === 0 && path()[0].tilt === 0 && path()[0].roll === 0 && path()[0].lock === 1);
check('recentre preserves dolly', path()[0].dolly === -0.25);
click('reset-key');
check('reset key clears dolly', path()[0].dolly === 0 && dollyNumber.value === '0');

editor.loadPath([{ frame: 0 }, { frame: 48, azimuth: 30 }]);
confirmAnswer = false;
click('reset');
check('reset path is abandoned when the confirmation is declined', path().length === 2);
confirmAnswer = true;
click('reset');
check('reset leaves one keyframe on the source camera', path().length === 1 && path()[0].distance === 1);

// camera_path seeds the editor; it must never quietly replace authored keyframes.
editor.setInputPath([{ frame: 0, azimuth: 12 }, { frame: 20, azimuth: 40 }]);
check('an unauthored editor adopts the connected path on its own',
      path().length === 2 && path()[0].azimuth === 12);
editor.setInputPath([{ frame: 0, azimuth: 99 }]);
check('a connected path never overwrites an authored one', path()[0].azimuth === 12);
check('the reset button offers the connected path instead',
      element.querySelector('[data-action=reset]').textContent === 'Reset to input');
click('reset');
check('reset adopts the connected path on request',
      path().length === 1 && path()[0].azimuth === 99);
editor.setInputPath(null);
check('disconnecting restores the plain reset',
      element.querySelector('[data-action=reset]').textContent === 'Reset path');

// Pivots: a second one can be added, selected, positioned, assigned and straightened,
// and the version 2 format carries all of it.
editor.loadPath([{ frame: 0 }, { frame: 48, azimuth: 30 }]);
check('a version 1 array loads onto one automatic pivot',
      pivots().length === 1 && path().every(key => key.pivot === pivots()[0].id)
      && element.querySelector('[data-role=pivot]').disabled);
click('add-pivot');
check('add pivot appends one and selects it',
      pivots().length === 2
      && element.querySelector('[data-role=selection]').textContent.startsWith('pivot 2')
      && !element.querySelector('.fields[data-panel=pivot]').hidden
      && element.querySelector('.groups[data-panel=camera]').hidden);
check('a fresh pivot has nothing to snap and can be removed',
      element.querySelector('[data-action=snap-pivot]').disabled
      && !element.querySelector('[data-action=remove-pivot]').disabled);
const pivotX = [...element.querySelectorAll('.fields[data-panel=pivot] .field')]
  .find(field => field.textContent.startsWith('X')).querySelector('input[type=number]');
pivotX.value = '0.4';
pivotX.dispatchEvent(new window.Event('input', { bubbles: true }));
check('a pivot slider moves the selected pivot', pivots()[1].keys[0].x === 0.4);
const pivotTilt = [...element.querySelectorAll('.fields[data-panel=pivot] .field')]
  .find(field => field.textContent.startsWith('Tilt')).querySelector('input[type=number]');
pivotTilt.value = '-15';
pivotTilt.dispatchEvent(new window.Event('input', { bubbles: true }));
check('a pivot can be tilted to straighten the orbit', pivots()[1].keys[0].tilt === -15);
const headingInput = [...element.querySelectorAll('.fields[data-panel=pivot] .field')]
  .find(field => field.textContent.startsWith('Heading')).querySelector('input[type=number]');
headingInput.value = '90';
headingInput.dispatchEvent(new window.Event('input', { bubbles: true }));
check('pivot heading is editable and serialized', pivots()[1].keys[0].heading === 90);
click('snap-pivot');
check('snap to auto puts it back on the subject',
      pivots()[1].keys[0].x === 0 && pivots()[1].keys[0].tilt === 0 && pivots()[1].keys[0].heading === 0);

// Without a preview the unit is 1, so a pivot at (x, y, z) sits at scene 1.8 * (x, -y, 1 - z).
const sceneOf = ({ x, y, z }) => [1.8 * x, -1.8 * y, 1.8 * (1 - z)];
// The view turns about the selected pivot, or the one the keyframe under the playhead
// orbits (the playhead follows the selected keyframe, which is keyframe 1 throughout).
const viewCentre = () => {
  const label = element.querySelector('[data-role=selection]').textContent;
  const match = /^pivot (\d+)/.exec(label);
  return sceneOf(match ? pivots()[Number(match[1]) - 1].keys[0] : poseAt(JSON.parse(stored), 0).pivot);
};
const markerOf = index => project(sceneOf(pivots()[index].keys[0]), viewCentre());
const origin = markerOf(1);
dragScene(origin, [origin[0] + 40, origin[1]]);
check('dragging the selected pivot marker moves it', pivots()[1].keys[0].x !== 0);

const selectKey = () => {
  pointer(element.querySelector('.key'), 'pointerdown', 0);
  pointer(track, 'pointerup', 0);
};
selectKey();
check('selecting a keyframe brings the camera fields back',
      element.querySelector('.fields[data-panel=pivot]').hidden
      && element.querySelector('[data-role=selection]').textContent.startsWith('keyframe 1'));
const select = element.querySelector('[data-role=pivot]');
check('the keyframe offers both pivots', select.options.length === 2 && !select.disabled);
select.value = pivots()[1].id;
select.dispatchEvent(new window.Event('change', { bubbles: true }));
check('a keyframe can be assigned to another pivot', path()[0].pivot === pivots()[1].id);
check('a keyframe in flight between pivots orbits a blend of them',
      Math.abs(poseAt(JSON.parse(stored), 24).pivot.x - pivots()[1].keys[0].x / 2) < 1e-9);

let second = markerOf(1);
dragScene(second, [second[0] + 3, second[1]]);
check('clicking a pivot marker selects it',
      element.querySelector('[data-role=selection]').textContent.startsWith('pivot 2'));
check('a used pivot cannot be removed',
      element.querySelector('[data-action=remove-pivot]').disabled && pivots().length === 2);
selectKey();
select.value = pivots()[0].id;
select.dispatchEvent(new window.Event('change', { bubbles: true }));
second = markerOf(1);
dragScene(second, [second[0] + 3, second[1]]);
click('remove-pivot');
check('an unused pivot can be removed', pivots().length === 1 && path().every(key => key.pivot === pivots()[0].id));

check('the copy json button is gone', !element.querySelector('[data-action=copy]'));

// fps is the timeline's rate only; the path and the frame count are untouched by it.
const seconds = () => element.querySelector('.count').textContent.match(/([\d.]+)s/)[1];
pointer(track, 'pointerdown', trackX(0.5));
pointer(track, 'pointerup', trackX(0.5));
const atDefaultRate = seconds();
fps = 48;
editor.sync();
check(`fps rescales the timeline clock (${atDefaultRate}s -> ${seconds()}s)`,
      Math.abs(Number(atDefaultRate) / 2 - Number(seconds())) < 0.02);
fps = 0;
editor.sync();
check('a missing or zero fps falls back to 24', seconds() === atDefaultRate);
fps = 24;

editor.loadPath([{ frame: 0 }, { frame: 48, azimuth: 30 }]);
check('loadPath adopts an upstream path and fills in defaults',
      path().length === 2 && path()[1].distance === 1);

click('play');
await new Promise(resolve => window.setTimeout(resolve, 120));
const played = element.querySelector('.cursor').style.left;
click('play');
check(`playback advances the playhead (${played})`, played !== '0%');

stored = '[{"frame": 0, "azimuth": "nope"}]';
editor.sync();
check('a broken path is reported instead of thrown',
      element.querySelector('.status').textContent.startsWith('camera_path:'));

editor.loadPath([{ frame: 0 }, { frame: 48, azimuth: 30 }]);
await editor.setPreview(null, () => '');
check('without cached geometry the placeholder stands in and says so',
      /placeholder/.test(element.querySelector('.render .label').textContent)
      && calls.has('putImageData'));

const cacheMeta = {
  width: 768, height: 576, source_width: 1024, source_height: 768,
  levels: { 'Low (384)': 384, 'Medium (512)': 512, 'High (768)': 768 },
  fx: 0.9, fy: 1.2, cx: 0.5, cy: 0.5, pivot_z: 2.0, splat: 1, z_low: 1.5, z_high: 3.5,
  samples: [{ frame: 0, rgb: { filename: 'rgb.png', type: 'temp' }, z: { filename: 'z.png', type: 'temp' } }],
};
const urlFor = reference => `http://localhost/view?filename=${reference.filename}`;
await editor.setPreview({ ...cacheMeta, levels: undefined }, urlFor);
check('old pruned-only caches request a one-time rerun', /Run the node once/.test(element.querySelector('.status').textContent));
{
  const cache = await loadPreview(cacheMeta, urlFor);
  const full = createPreview(cache, 'High (768)', false);
  const low = createPreview(cache, 'Low (384)', false);
  const pruned = createPreview(cache, 'High (768)', true);
  check('invalid points stay invalid with pruning off', full.samples[0].cloud.count === (768 - 8) * 576);
  check('High actually has four times the Low point density', full.samples[0].cloud.count === low.samples[0].cloud.count * 4);
  check('the cached mask, not a second edge pass, selects points', pruned.samples[0].cloud.count === (768 - 8 - 192) * 576);
  check('comparison does not mutate the raw cache', Number.isFinite(cache.samples[0].depth[0]) && cache.samples[0].keep[0] === 0);
}
await editor.setPreview(cacheMeta, urlFor);
check('the cached cloud is loaded and reprojected',
      /unseen/.test(element.querySelector('.render .label').textContent));
check('the scene view draws the cloud as well', calls.has('putImageData'));

// The lattice hangs in front of the wall as well as behind it, so switching it on
// covers pixels that were holes before.
const unseen = () => Number(/(\d+)% unseen/.exec(element.querySelector('.render .label').textContent)[1]);
editor.loadPath([{ frame: 0 }]);
const loads = imageLoads;
for (const [level, dimensions] of [['Low (384)', '384\u00d7288'], ['High (768)', '768\u00d7576'],
                                   ['Medium (512)', '512\u00d7384']]) {
  quality = level;
  editor.sync();
  check(`quality changes locally to ${level}`, element.querySelector('.render .label').textContent.includes(dimensions));
  const pruned = unseen();
  prune = false;
  editor.sync();
  check(`pruning off restores points at ${level}`, unseen() < pruned);
  prune = true;
  editor.sync();
  check(`pruning on restores the comparison at ${level}`, unseen() === pruned);
}
check('live settings do not fetch any images', imageLoads === loads);

// A setting changed during loading must win over the settings at load start.
let release;
decodeWait = new Promise(resolve => { release = resolve; });
const loading = editor.setPreview(cacheMeta, urlFor);
quality = 'Low (384)'; prune = false;
editor.sync();
release();
await loading;
decodeWait = null;
check('loading uses the latest widget settings', element.querySelector('.render .label').textContent.includes('384\u00d7288'));
const unpruned = unseen();
prune = true;
editor.sync();
check('latest pruning setting was also used during loading', unseen() > unpruned);

editor.loadPath([{ frame: 0, azimuth: 40 }]);
const before = unseen();
markers = true;
editor.sync();
check('the markers checkbox puts the lattice into the preview', unseen() < before);
markers = false;
editor.sync();
check('and takes it out again', unseen() === before);

// The markers are rebuilt on every redraw; the browser keeps the drag alive through
// setPointerCapture on the track, which jsdom does not implement, so aim there directly.
pointer(element.querySelector('.key'), 'pointerdown', 0);
pointer(track, 'pointermove', 100);
pointer(track, 'pointerup', 100);
check('dragging a timeline marker retimes its keyframe',
      path().some(key => key.frame > 0 && key.frame < 48));

editor.destroy();
console.log('\nall editor checks passed');
