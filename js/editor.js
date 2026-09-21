/**
 * Interactive camera path editor: 3D scene, timeline, keyframes, pivots and a live
 * reprojection of the point cloud the node cached on its last run.
 *
 * Mounted as a DOM widget by `camera-path.js`, so it renders identically on the
 * LiteGraph canvas and under the Nodes 2.0 Vue renderer. It owns no ComfyUI state --
 * the host passes read/write accessors for the `keyframes` and `frame_count`
 * widgets, and everything else lives in this closure.
 *
 * Two kinds of thing can be selected: a camera keyframe, which shows the camera's
 * axes, or a pivot, which shows its position. The pivot a keyframe orbits is chosen
 * from a dropdown on the keyframe.
 */
import { poseAt, pivotAt, normalizePath, serializePath, identityPose, defaultPath, defaultPivot,
         PIVOT_AXES, PIVOT_DEFAULTS } from './interpolate.js';
import { poseCamera, cameraScenePosition, pivotWorld, scenePoint, worldOffset, screenBasis, orbitFrame,
         uprightRotation, dragOrbit, dragTruck, renderCamera, renderScene, markerLattice,
         concatClouds } from './geometry.js';
import { loadPreview, sampleFor } from './preview.js';
import { floorGrid, placeholderPreview, DEFAULT_HALF_HEIGHT } from './furniture.js';

/** Timeline rate when the host has no fps widget to read. */
const DEFAULT_FPS = 24;

/** Upper bound on keyframes, to keep the timeline readable. */
const MAX_KEYS = 64;

/** Upper bound on pivots; the dropdown and the scene both stop being readable past this. */
const MAX_PIVOTS = 16;

/** #141419 packed little-endian as ABGR, to clear the point-cloud buffer in one pass. */
const BACKGROUND = 0xff191414;

/** The camera axes, their UI ranges and step sizes. */
const FIELDS = [
  { name: 'azimuth', label: 'Azimuth \u00b0', min: -720, max: 720, step: 1 },
  { name: 'elevation', label: 'Elevation \u00b0', min: -89, max: 89, step: 1 },
  { name: 'distance', label: 'Distance \u00d7', min: 0.1, max: 4, step: 0.01 },
  { name: 'dolly', label: 'Dolly \u00d7', min: -3, max: 3, step: 0.01 },
  { name: 'lateral', label: 'Lateral \u00d7', min: -3, max: 3, step: 0.01 },
  { name: 'height', label: 'Height \u00d7', min: -3, max: 3, step: 0.01 },
  { name: 'pan', label: 'Pan \u00b0', min: -90, max: 90, step: 1 },
  { name: 'tilt', label: 'Tilt \u00b0', min: -90, max: 90, step: 1 },
  { name: 'roll', label: 'Roll \u00b0', min: -180, max: 180, step: 1 },
];
const DISTANCE = FIELDS.find(field => field.name === 'distance');

/** A pivot's position, in units of the automatic pivot depth, and its orbit frame. */
const PIVOT_FIELDS = [
  { name: 'x', label: 'X \u00d7', min: -3, max: 3, step: 0.01 },
  { name: 'y', label: 'Y \u00d7', min: -3, max: 3, step: 0.01 },
  { name: 'z', label: 'Z \u00d7', min: 0.05, max: 6, step: 0.01 },
  { name: 'tilt', label: 'Tilt \u00b0', min: -90, max: 90, step: 0.5 },
  { name: 'roll', label: 'Roll \u00b0', min: -180, max: 180, step: 0.5 },
  { name: 'heading', label: 'Heading \u00b0', min: -180, max: 180, step: 1 },
];
/** The pivot fields a drag on its marker moves. */
const PIVOT_POSITION = PIVOT_FIELDS.slice(0, 3);

/** Below this widget width the scene and the render stay stacked. */
const SIDE_BY_SIDE_WIDTH = 720;

/** Scene marker radii, in layout pixels: [unselected, selected]. */
const KEY_RADIUS = [9, 11];
const PIVOT_RADIUS = [7, 9];

/** Clear space kept between two markers, and how far one may be pushed to get it. */
const MARKER_GAP = 3;
const MARKER_SPREAD = 90;

/**
 * Nudges overlapping scene markers apart, so a path that doubles back or flattens
 * into the view still shows every keyframe as its own readable, grabbable disc.
 *
 * It is a plain relaxation: each pass separates every overlapping pair by exactly the
 * overlap, so markers that already clear each other never move at all and the common
 * case costs one pass. Callers draw at `at` and hit test against it, and draw a leader
 * back to `point` -- the place the marker actually stands for.
 * @param {{point: number[], radius: number}[]} markers Projected markers.
 * @returns {{point: number[], radius: number, at: number[]}[]} The same markers, each
 *   with the position it should be drawn at.
 */
export function spreadMarkers(markers) {
  const spread = markers.map(marker => ({ ...marker, at: [marker.point[0], marker.point[1]] }));
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < spread.length; i++) {
      for (let j = i + 1; j < spread.length; j++) {
        const a = spread[i], b = spread[j];
        const clear = a.radius + b.radius + MARKER_GAP;
        let dx = b.at[0] - a.at[0], dy = b.at[1] - a.at[1];
        let distance = Math.hypot(dx, dy);
        if (distance >= clear) continue;
        // Markers on the same pixel have no axis to separate along. Fan them out by
        // index instead, so the arrangement is the same on every redraw.
        if (distance < 1e-6) {
          const angle = (i * spread.length + j) * 2.39996;
          [dx, dy, distance] = [Math.cos(angle), Math.sin(angle), 1];
        }
        const push = (clear - distance) / (2 * distance);
        a.at = [a.at[0] - dx * push, a.at[1] - dy * push];
        b.at = [b.at[0] + dx * push, b.at[1] + dy * push];
        moved = true;
      }
    }
    if (!moved) break;
  }
  // A crowd of markers would otherwise walk the outermost ones off the viewport.
  for (const marker of spread) {
    const dx = marker.at[0] - marker.point[0], dy = marker.at[1] - marker.point[1];
    const reach = Math.hypot(dx, dy);
    if (reach > MARKER_SPREAD) {
      marker.at = [marker.point[0] + dx * MARKER_SPREAD / reach,
                   marker.point[1] + dy * MARKER_SPREAD / reach];
    }
  }
  return spread;
}

const STYLE = `
/* overflow:hidden is load-bearing: the fixed rows plus the two canvas minimums can
   exceed a short widget, and without it the render pane lands on top of the fields. */
.cpath{box-sizing:border-box;width:100%;height:100%;overflow:hidden;padding:10px;background:#1b1b20;
  color:#e8e8ee;border:1px solid #32323c;border-radius:10px;font:15px system-ui,sans-serif;
  user-select:none;display:flex;flex-direction:column;gap:8px}
.cpath *{box-sizing:border-box}
.cpath [hidden]{display:none !important}
.cpath button{font:inherit;color:#d8d3e6;background:#26242e;border:1px solid #433f50;border-radius:6px;padding:5px 9px;cursor:pointer}
.cpath button:hover{border-color:#7f5cff}
.cpath button:disabled{opacity:.35;cursor:default;border-color:#433f50}
.cpath select{font:inherit;color:#d8d3e6;background:#17161c;border:1px solid #3c3847;border-radius:6px;padding:4px 6px}
.cpath .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:0 0 auto}
.cpath .spacer{margin-left:auto}
.cpath .scene{display:block;width:100%;height:100%;touch-action:none;cursor:move}
/* The stage takes every spare pixel and hands it to the two canvases; everything
   else keeps its natural height. Without this the axis fields absorb the slack. */
.cpath .stage{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;min-width:0}
.cpath .viewport{position:relative;flex:3 1 0;min-height:120px;min-width:0;background:#141419;
  border:1px solid #32323c;border-radius:8px;overflow:hidden}
.cpath .hint{position:absolute;left:8px;bottom:6px;right:8px;font-size:12px;color:#fff;
  pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpath .render{position:relative;flex:2 1 0;min-height:90px;min-width:0;background:#141419;
  border:1px solid #32323c;border-radius:8px;overflow:hidden}
.cpath .render canvas{display:block;width:100%;height:100%}
.cpath.wide .stage{flex-direction:row}
.cpath .render .label{position:absolute;left:8px;top:6px;font-size:12px;color:#c7c0d8;background:#0009;padding:2px 6px;border-radius:4px}
.cpath .track{position:relative;height:26px;margin:2px 8px;touch-action:none;flex:0 0 auto}
.cpath .rail{position:absolute;top:11px;left:0;right:0;height:4px;border-radius:3px;background:#3a3746}
.cpath .key{position:absolute;top:7px;width:12px;height:12px;margin-left:-6px;background:#4c9e8e;border-radius:3px;
  transform:rotate(45deg);border:1px solid #1b1b20}
.cpath .key.selected{background:#a77dff}
.cpath .key.beyond{background:#6a6577}
.cpath .cursor{position:absolute;top:0;height:26px;width:2px;margin-left:-1px;background:#a77dff;pointer-events:none}
.cpath .tools{padding:0 2px}
.cpath .tools .name{font-size:13px;color:#9a93ad}
.cpath .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;flex:0 0 auto}
.cpath.wide .fields{grid-template-columns:repeat(3,minmax(0,1fr))}
.cpath .field{display:flex;align-items:center;gap:7px;padding:5px 8px;background:#22212a;border:1px solid #36323f;border-radius:7px}
.cpath .field span{font-size:13px;color:#9a93ad;width:70px}
.cpath .field input[type=range]{flex:1;min-width:0;accent-color:#7f5cff}
.cpath .field input[type=number]{width:68px;background:#17161c;border:1px solid #3c3847;border-radius:5px;color:#e8e8ee;
  font:13px ui-monospace,monospace;padding:3px 4px;text-align:right}
.cpath .field.lock{cursor:pointer}
.cpath .field.lock span{width:auto;color:#c7c0d8}
.cpath .field.lock input{accent-color:#7f5cff;width:17px;height:17px}
.cpath .field.round{gap:8px;min-width:0}
.cpath .round-controls{display:flex;flex-direction:column;gap:3px;min-width:0}
.cpath .round-controls label{display:flex;align-items:center;gap:3px;font-size:13px;color:#9a93ad}
.cpath .round-controls input[type=number]{width:54px;min-width:0}
.cpath .round-controls button{font-size:12px;padding:2px 5px}
.cpath .round-surface{position:relative;width:76px;height:76px;flex:0 0 76px;border-radius:50%;
  border:1px solid #625275;background:#17161c;touch-action:none;cursor:grab}
.cpath .round-surface:active{cursor:grabbing}
.cpath .round-surface::before{content:'';position:absolute;inset:8px;border:1px solid #36323f;border-radius:50%;pointer-events:none}
.cpath .round-surface input[type=number]{position:absolute;left:10px;top:26px;width:56px;padding:2px;
  text-align:center;font-size:13px;appearance:textfield}
.cpath .round-surface input::-webkit-inner-spin-button{appearance:none}
.cpath .round-mark{position:absolute;width:7px;height:7px;border-radius:50%;background:#b398ed;
  transform:translate(-50%,-50%);pointer-events:none}
.cpath .aim-puck{width:10px;height:10px;background:#73b9aa}
.cpath .status{font:13px ui-monospace,monospace;color:#8d87a0;min-height:16px;white-space:pre-wrap;flex:0 0 auto}
.cpath .status.error{color:#ff9d9d}
.cpath .count{font:14px ui-monospace,monospace;color:#b9b2cc}
`;

/**
 * Builds the editor.
 * @param {object} host Accessors for the node's widgets.
 * @param {() => string} host.readPath Current keyframes JSON.
 * @param {(value: string) => void} host.writePath Writes keyframes back to the widget.
 * @param {() => number} host.readFrameCount Current frame_count.
 * @param {() => number} [host.readFps] Current fps; the timeline and playback rate only,
 *   since the node renders a plain image batch that carries no rate of its own.
 * @param {() => boolean} [host.readMarkers] Whether the node's markers checkbox is on;
 *   the lattice is shown in both views while it is, so the preview matches the render.
 * @returns {{element: HTMLElement, sync: Function, loadPath: Function, setInputPath: Function, setPreview: Function, destroy: Function}}
 *   Editor handle. `element` goes into addDOMWidget().
 */
export function createCameraEditor({ readPath, writePath, readFrameCount, readMarkers = () => false,
                                     readFps = () => DEFAULT_FPS }) {
  const root = document.createElement('section');
  root.className = 'cpath';
  root.innerHTML = `<style>${STYLE}</style>
    <div class="row">
      <button data-action="add">+ Keyframe</button>
      <button data-action="add-pivot" title="Add a point for the camera to orbit around">+ Pivot</button>
      <button data-action="reset" title="Delete every keyframe and start again from the source camera">Reset path</button>
      <span class="spacer"></span>
      <button data-action="zoom-out" title="Zoom out">\u2212</button>
      <button data-action="zoom-in" title="Zoom in">+</button>
      <button data-action="view-reset">Reset view</button>
    </div>
    <div class="stage">
      <div class="viewport"><canvas class="scene"></canvas>
        <div class="hint">Drag the camera or a keyframe to orbit \u00b7 ctrl+drag to truck and boom \u00b7 drag a pivot to move it \u00b7 drag the background to turn the view \u00b7 wheel to zoom \u00b7 alt+wheel for distance</div>
      </div>
      <div class="render"><canvas></canvas><div class="label"></div></div>
    </div>
    <div class="track"><div class="rail"></div><div class="keys"></div><div class="cursor"></div></div>
    <div class="row">
      <button data-action="play">\u25b6</button>
      <span class="count"></span>
      <span class="spacer"></span>
      <span class="count" data-role="selection"></span>
    </div>
    <div class="row tools" data-panel="camera">
      <span class="name">Orbits</span>
      <select data-role="pivot" title="The pivot this keyframe orbits around"></select>
      <span class="spacer"></span>
      <button data-action="reset-key" title="Reset the camera relative to its pivot, keeping its frame and pivot">Reset key</button>
      <button data-action="remove">\u2212 Keyframe</button>
    </div>
    <div class="row tools" data-panel="pivot" hidden>
      <span class="name" data-role="pivot-name"></span>
      <span class="spacer"></span>
      <button data-action="snap-pivot" title="Put the pivot back on the subject the node found by itself">Snap to auto</button>
      <button data-action="remove-pivot" title="Delete this pivot. Only pivots no keyframe uses can be deleted">\u2212 Pivot</button>
    </div>
    <div class="fields" data-panel="camera"></div>
    <div class="fields" data-panel="pivot" hidden></div>
    <div class="status"></div>`;

  const find = selector => root.querySelector(selector);
  const viewport = find('.viewport');
  const scene = find('.scene');
  const sceneContext = scene.getContext('2d');
  const renderCanvas = find('.render canvas');
  const renderContext = renderCanvas.getContext('2d');
  const track = find('.track');
  const keys = find('.keys');
  const pivotSelect = find('[data-role=pivot]');

  /**
   * Builds a slider + number pair for one axis.
   * @param {HTMLElement} into Container to append to.
   * @param {object} spec Axis spec with name, label, min, max and step.
   * @param {(spec: object, value: number) => void} onInput Called with each edit.
   * @returns {{slider: HTMLInputElement, number: HTMLInputElement, spec: object}} The inputs.
   */
  function buildField(into, spec, onInput) {
    const box = document.createElement('label');
    box.className = 'field';
    box.innerHTML = `<span>${spec.label}</span>
      <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}">
      <input type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}">`;
    const [slider, number] = box.querySelectorAll('input');
    for (const input of [slider, number]) {
      input.addEventListener('input', () => onInput(spec, input.valueAsNumber));
    }
    into.append(box);
    return { slider, number, spec };
  }

  const fields = new Map();
  const cameraFields = find('.fields[data-panel=camera]');

  /**
   * Builds a compact orbit dial or two-axis aim puck, with precise numeric entry.
   * @param {boolean} aim Whether this control edits pan/tilt instead of azimuth.
   * @returns {{surface: HTMLElement, mark: HTMLElement}} Elements updated by refresh.
   */
  function buildRound(aim) {
    const box = document.createElement('div');
    box.className = 'field round';
    box.innerHTML = `<div class="round-surface" data-role="${aim ? 'aim-puck' : 'orbit-dial'}">
      <i class="round-mark ${aim ? 'aim-puck' : ''}"></i></div><div class="round-controls"></div>`;
    const surface = box.querySelector('.round-surface');
    const controls = box.querySelector('.round-controls');
    surface.title = aim ? 'Drag right/up to pan/tilt; recentre to zero both'
      : 'Drag clockwise to increase azimuth across turns; double-click the centre to zero';
    for (const name of aim ? ['pan', 'tilt'] : ['azimuth']) {
      const spec = FIELDS.find(item => item.name === name);
      const label = document.createElement('label');
      label.textContent = aim ? spec.label.split(' ')[0] : spec.label;
      const number = document.createElement('input');
      number.type = 'number';
      number.min = spec.min;
      number.max = spec.max;
      number.step = spec.step;
      number.setAttribute('aria-label', spec.label);
      number.addEventListener('input', () => setAxis(spec, number.valueAsNumber));
      if (aim) label.append(number);
      else {
        surface.append(number);
        number.addEventListener('dblclick', () => {
          number.value = '0';
          setAxis(spec, 0);
        });
      }
      controls.append(label);
      fields.set(name, { number, spec });
    }
    if (aim) {
      const reset = document.createElement('button');
      reset.textContent = 'Recentre';
      reset.dataset.action = 'recentre-aim';
      controls.append(reset);
    }
    let gesture = null;
    /**
     * Screen coordinates normalised to the circle, independent of graph zoom.
     * @param {PointerEvent} event Pointer event.
     * @returns {number[]} Right/up coordinates relative to the circle centre.
     */
    const point = event => {
      const rect = surface.getBoundingClientRect();
      return [(event.clientX - rect.left - rect.width / 2) / (rect.width * 0.4),
              (rect.top + rect.height / 2 - event.clientY) / (rect.height * 0.4)];
    };
    /**
     * Updates the selected camera from the captured pointer.
     * @param {PointerEvent} event Pointer event.
     * @returns {void}
     */
    const move = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const [x, y] = point(event);
      if (aim) {
        // Map the disk to the full pan/tilt square, including both-axis extremes.
        const radius = Math.hypot(x, y), extent = Math.max(Math.abs(x), Math.abs(y));
        const scale = extent ? Math.min(1, radius) / extent : 0;
        key().pan = Math.round(x * scale * 90);
        key().tilt = Math.round(y * scale * 90);
        commit();
        refresh();
      } else if (Math.hypot(x, y) > 0.3) {
        const angle = Math.atan2(x, y) * 180 / Math.PI;
        const delta = ((angle - gesture.angle + 540) % 360) - 180;
        gesture.angle = angle;
        gesture.value = clamp(gesture.value + delta, -720, 720);
        setAxis(fields.get('azimuth').spec, Math.round(gesture.value));
      }
      event.preventDefault();
    };
    surface.addEventListener('pointerdown', event => {
      if (event.button !== 0 || gesture || event.target.closest('input')) return;
      const [x, y] = point(event);
      if (!aim && Math.hypot(x, y) < 0.3) return;
      if (root.contains(document.activeElement)) document.activeElement.blur();
      gesture = { id: event.pointerId, angle: Math.atan2(x, y) * 180 / Math.PI, value: key().azimuth };
      surface.setPointerCapture(event.pointerId);
      move(event);
      event.stopPropagation();
    });
    surface.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      surface.addEventListener(type, event => {
        if (!gesture || event.pointerId !== gesture.id) return;
        gesture = null;
        if (type !== 'lostpointercapture') surface.releasePointerCapture(event.pointerId);
      });
    }
    cameraFields.append(box);
    return { surface, mark: box.querySelector('.round-mark') };
  }

  const orbitDial = buildRound(false), aimPuck = buildRound(true);
  for (const spec of FIELDS) {
    if (!fields.has(spec.name)) fields.set(spec.name, buildField(cameraFields, spec, setAxis));
  }
  const pivotFields = new Map();
  for (const spec of PIVOT_FIELDS) {
    pivotFields.set(spec.name, buildField(find('.fields[data-panel=pivot]'), spec, setPivotAxis));
  }

  const lockBox = document.createElement('label');
  lockBox.className = 'field lock';
  lockBox.title = 'Keep the camera pointed at the pivot while trucking and booming. '
                + 'Stored as a number, so a keyframe that turns it on eases into it.';
  lockBox.innerHTML = '<input type="checkbox"><span>Lock on target</span>';
  const lockInput = lockBox.querySelector('input');
  lockInput.addEventListener('change', () => {
    key().lock = lockInput.checked ? 1 : 0;
    commit();
    refresh();
  });
  find('.fields[data-panel=camera]').append(lockBox);

  pivotSelect.addEventListener('change', () => {
    key().pivot = pivotSelect.value;
    commit();
    refresh();
  });

  let path = defaultPath();
  let written = '';
  let selected = 0;
  let selectedPivot = -1;
  let playhead = 0;
  let yaw = 0.55, pitch = 0.45, zoom = 1;
  /** Scene-space offset of the view's rotation centre from the view pivot, set by panning. */
  let pan = [0, 0, 0];
  let drag = null;
  /** The cloud on show: cached geometry once the node has run, the placeholder until then. */
  let preview = placeholderPreview();
  let previewToken = 0;
  let inputPath = null;
  let sceneImage = null;
  let sceneDepth = null;
  let playing = false, frameRequest = 0, playStart = 0, playFrom = 0;
  let error = '';
  let disposed = false;
  let hits = { marks: [], pivots: [], camera: [0, 0], view: null };

  const frameCount = () => Math.max(1, Math.round(readFrameCount() || 1));
  const lastFrame = () => Math.max(0, frameCount() - 1);
  /** Timeline and playback rate; the render itself is rateless. */
  const fps = () => {
    const value = Number(readFps());
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_FPS;
  };
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  /** The automatic pivot depth, which every pivot position and truck axis is scaled by. */
  const unit = () => preview.pivotZ;
  /** Half the source image's height at unit depth, in units: where the floor is. */
  const halfHeight = () => (preview.placeholder ? DEFAULT_HALF_HEIGHT : 0.5 / preview.meta.fy);
  /** The marker lattice for the current unit, rebuilt only when the unit changes. */
  let lattice = { unit: NaN, cloud: null };
  /**
   * The cloud both views draw at a frame: the sample nearest it, with the lattice
   * appended while the node's markers checkbox is on -- the same join the render does.
   * @param {number} frame Output frame.
   * @returns {object} Cloud.
   */
  const cloudAt = frame => {
    const sample = sampleFor(preview, frame).cloud;
    if (!readMarkers()) return sample;
    if (lattice.unit !== unit()) lattice = { unit: unit(), cloud: markerLattice(unit()) };
    return concatClouds(sample, lattice.cloud);
  };
  const key = () => path.camera[selected];
  const pivotOf = identifier => path.pivots.find(pivot => pivot.id === identifier) ?? path.pivots[0];
  /** The editable position of a pivot: its first key. The track can hold more, but the editor writes one. */
  const pivotKey = pivot => pivot.keys[0];
  const toScene = pivot => {
    const world = pivotWorld(pivot, unit());
    return scenePoint(world[0], world[1], world[2], unit());
  };
  const pivotScene = (pivot, frame) => toScene(pivotAt(pivot, frame));
  /**
   * The pivot whose orbit frame the scene view is stood upright in: the selected
   * pivot, or the one the current pose orbits.
   * @returns {{x: number, y: number, z: number, tilt: number, roll: number}} Resolved pivot.
   */
  const viewPivot = () => (selectedPivot >= 0
    ? pivotAt(path.pivots[selectedPivot], playhead)
    : poseAt(path, playhead).pivot);

  /**
   * Serialises the path and pushes it to the widget.
   * @returns {void}
   */
  function commit() {
    written = serializePath(path);
    writePath(written);
  }

  /**
   * Is the path still the untouched default -- one source-camera keyframe on one
   * automatic pivot? Only then may a path arriving on the camera_path socket be
   * adopted without asking.
   * @returns {boolean} True when nothing has been authored yet.
   */
  function pristine() {
    if (path.camera.length !== 1 || path.camera[0].frame !== 0 || path.pivots.length !== 1) return false;
    const blank = identityPose();
    const position = pivotKey(path.pivots[0]);
    return Object.keys(blank).every(name => path.camera[0][name] === blank[name])
      && PIVOT_AXES.every(name => position[name] === PIVOT_DEFAULTS[name]);
  }

  /**
   * Discards the current path, for the Reset path button. Falls back to the source
   * camera when nothing is connected, otherwise reloads the connected path.
   * @returns {void}
   */
  function resetPath() {
    const replacement = inputPath ? normalizePath(inputPath) : defaultPath();
    const question = inputPath
      ? 'Replace the current path with the one from the connected camera_path input?'
      : `Delete all ${path.camera.length} keyframes and start again from the source camera?`;
    if (!pristine() && globalThis.confirm?.(question) !== true) return;
    path = replacement;
    selectKey(0);
    commit();
  }

  /**
   * Selects a keyframe and parks the playhead on it.
   * @param {number} index Keyframe index.
   * @returns {void}
   */
  function selectKey(index) {
    selected = clamp(index, 0, path.camera.length - 1);
    selectedPivot = -1;
    playhead = clamp(key().frame, 0, lastFrame());
  }

  /**
   * Selects a pivot, switching the fields to its position.
   * @param {number} index Pivot index.
   * @returns {void}
   */
  function selectPivot(index) {
    selectedPivot = clamp(index, 0, path.pivots.length - 1);
  }

  /**
   * Writes one axis of the selected keyframe, clamped to its UI range.
   * @param {object} spec Entry from FIELDS.
   * @param {number} value New value.
   * @returns {void}
   */
  function setAxis(spec, value) {
    if (!Number.isFinite(value)) return;
    key()[spec.name] = clamp(value, spec.min, spec.max);
    commit();
    refresh();
  }

  /**
   * Writes one axis of the selected pivot's position, clamped to its UI range.
   * @param {object} spec Entry from PIVOT_FIELDS.
   * @param {number} value New value.
   * @returns {void}
   */
  function setPivotAxis(spec, value) {
    if (!Number.isFinite(value) || selectedPivot < 0) return;
    pivotKey(path.pivots[selectedPivot])[spec.name] = clamp(value, spec.min, spec.max);
    commit();
    refresh();
  }

  /**
   * Is a pivot referenced by any keyframe? Such a pivot cannot be deleted.
   * @param {string} identifier Pivot id.
   * @returns {boolean} True when a keyframe orbits it.
   */
  const inUse = identifier => path.camera.some(item => item.pivot === identifier);

  // -- Drawing ---------------------------------------------------------------

  /**
   * Orthographic projection for the scene view, shared by the wireframe and the cloud.
   *
   * The scene is first stood upright in the orbit frame of `viewPivot()`, turned
   * about that pivot, so a tilted or rolled shot can be straightened by eye: adjust
   * the pivot's tilt and roll until the geometry stands up. The view then turns about
   * that same pivot, offset by any pan, so what is being edited stays put on screen
   * however far from the automatic pivot it sits.
   * @param {number} width Canvas width in CSS pixels.
   * @param {number} height Canvas height in CSS pixels.
   * @returns {{scale: number, originX: number, originY: number, yaw: number, pitch: number,
   *   centre: number[], upright: object|null, project: Function}} Projection state;
   *   `project([x, y, z])` returns screen coordinates.
   */
  function projector(width, height) {
    const scale = Math.min(width * 0.105, 58) * zoom;
    const originX = width / 2, originY = height * 0.54;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const pivot = viewPivot();
    const rotation = uprightRotation(pivot);
    const focus = toScene(pivot);
    const upright = rotation ? { centre: focus, rotation } : null;
    // The pivot is fixed by the upright turn, so the centre needs no turning itself.
    const centre = [0, 1, 2].map(i => focus[i] + pan[i]);
    const project = (point) => {
      let [x, y, z] = point;
      if (upright) {
        const [c, m] = [upright.centre, upright.rotation];
        const dx = x - c[0], dy = y - c[1], dz = z - c[2];
        x = c[0] + m[0][0] * dx + m[0][1] * dy + m[0][2] * dz;
        y = c[1] + m[1][0] * dx + m[1][1] * dy + m[1][2] * dz;
        z = c[2] + m[2][0] * dx + m[2][1] * dy + m[2][2] * dz;
      }
      x -= centre[0];
      y -= centre[1];
      z -= centre[2];
      const rx = x * cy - z * sy, rz = x * sy + z * cy;
      return [originX + rx * scale, originY - (y * cp - rz * sp) * scale];
    };
    return { scale, originX, originY, yaw, pitch, centre, upright, project };
  }

  /**
   * Redraws the 3D overview: cached cloud, orbit rings, the path, keyframes, pivots
   * and the camera gizmo. Also refreshes the hit-test table the pointer handlers read.
   * @returns {void}
   */
  function drawScene() {
    const width = scene.clientWidth || 480, height = scene.clientHeight || viewport.clientHeight || 300;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    scene.width = Math.round(width * dpr);
    scene.height = Math.round(height * dpr);
    sceneContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    sceneContext.fillStyle = '#141419';
    sceneContext.fillRect(0, 0, width, height);
    const view = projector(width, height);

    // The floor and the cloud share one z-buffer, so the floor sits behind whatever is
    // in front of it rather than being painted over the top. putImageData ignores the
    // transform, so both are splatted in device pixels.
    const pixelWidth = scene.width, pixelHeight = scene.height;
    if (!sceneImage || sceneImage.width !== pixelWidth || sceneImage.height !== pixelHeight) {
      sceneImage = sceneContext.createImageData(pixelWidth, pixelHeight);
      sceneDepth = new Float32Array(pixelWidth * pixelHeight);
    }
    new Uint32Array(sceneImage.data.buffer).fill(BACKGROUND);
    sceneDepth.fill(Infinity);
    const target = { data: sceneImage.data, width: pixelWidth, height: pixelHeight, depth: sceneDepth };
    const device = { ...view, scale: view.scale * dpr, originX: view.originX * dpr, originY: view.originY * dpr };
    renderScene(floorGrid(unit(), halfHeight(), viewPivot()), device, target, unit(), 1);
    const cloud = cloudAt(playhead);
    renderScene(cloud, device, target, unit(), Math.max(1, Math.round(cloud.count / 90000)));
    sceneContext.putImageData(sceneImage, 0, 0);

    const line = (a, b, color, lineWidth = 1) => {
      const p = view.project(a), q = view.project(b);
      sceneContext.beginPath();
      sceneContext.moveTo(p[0], p[1]);
      sceneContext.lineTo(q[0], q[1]);
      sceneContext.strokeStyle = color;
      sceneContext.lineWidth = lineWidth;
      sceneContext.stroke();
    };

    // The orbit sphere uses the shared depth unit, in the pivot's own frame.
    const pose = poseAt(path, playhead);
    const centre = toScene(pose.pivot);
    const radius = 1.8 * pose.distance;
    const frame = orbitFrame(pose.pivot.tilt || 0, pose.pivot.roll || 0, pose.pivot.heading || 0);
    // Frame axes as scene directions: world (x, y, z) -> scene (x, -y, -z).
    const axisOf = v => {
      const w = [0, 1, 2].map(r => frame[r][0] * v[0] + frame[r][1] * v[1] + frame[r][2] * v[2]);
      return [w[0], -w[1], -w[2]];
    };
    const ring = vertical => {
      const [a1, a2] = vertical ? [axisOf([0, 1, 0]), axisOf([0, 0, 1])] : [axisOf([1, 0, 0]), axisOf([0, 0, 1])];
      const at = angle => [0, 1, 2].map(i =>
        centre[i] + radius * (Math.sin(angle) * a1[i] + Math.cos(angle) * a2[i]));
      for (let i = 0; i < 72; i++) {
        line(at(i * Math.PI * 2 / 72), at((i + 1) * Math.PI * 2 / 72), vertical ? '#2f2f38' : '#3d3d47');
      }
    };
    ring(false);
    ring(true);

    const samples = Math.max(2, Math.min(240, frameCount()));
    let previous = null;
    for (let i = 0; i < samples; i++) {
      const frame = i * lastFrame() / (samples - 1);
      const point = cameraScenePosition(poseAt(path, frame), unit());
      if (previous) line(previous, point, '#00a995', 1.7);
      previous = point;
    }

    const disc = (point, size, fill, stroke) => {
      sceneContext.beginPath();
      sceneContext.arc(point[0], point[1], size, 0, Math.PI * 2);
      sceneContext.fillStyle = fill;
      sceneContext.fill();
      sceneContext.strokeStyle = stroke;
      sceneContext.lineWidth = 1;
      sceneContext.stroke();
    };
    const tag = (text, point, color) => {
      sceneContext.fillStyle = color;
      sceneContext.font = 'bold 12px ui-monospace,monospace';
      sceneContext.textAlign = 'center';
      sceneContext.textBaseline = 'middle';
      sceneContext.fillText(text, point[0], point[1] + 0.5);
      sceneContext.textAlign = 'start';
      sceneContext.textBaseline = 'alphabetic';
    };
    /** Ties a marker that had to be nudged aside back to the point it stands for. */
    const leader = (from, to, color) => {
      sceneContext.beginPath();
      sceneContext.moveTo(from[0], from[1]);
      sceneContext.lineTo(to[0], to[1]);
      sceneContext.strokeStyle = color;
      sceneContext.lineWidth = 1;
      sceneContext.stroke();
      sceneContext.beginPath();
      sceneContext.arc(from[0], from[1], 1.5, 0, Math.PI * 2);
      sceneContext.fillStyle = color;
      sceneContext.fill();
    };

    // Where the lens actually points, which pan/tilt can take away from the pivot. Drawn
    // before the markers: four lines converge on the camera, and over a numbered disc
    // they cross out the number.
    const at = cameraScenePosition(pose, unit());
    const basis = poseCamera(pose, unit());
    const direction = ([x, y, z]) => [x, -y, -z];
    const along = (vector, distance) => {
      const step = direction(vector);
      return [0, 1, 2].map(i => at[i] + step[i] * distance);
    };
    const reach = 1.8 * (pose.distance || 1);
    const aspect = preview.meta.source_width / preview.meta.source_height;
    const spread = 0.34;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const point = along(basis.forward, reach);
      const right = direction(basis.right), down = direction(basis.down);
      return [0, 1, 2].map(i =>
        point[i] + right[i] * sx * spread * reach * aspect + down[i] * sy * spread * reach);
    });
    corners.forEach((corner, index) => {
      line(at, corner, '#8c4cffaa', 1);
      line(corner, corners[(index + 1) % 4], '#8c4cffaa', 1);
    });
    line(centre, at, '#6a5a8f55', 1);

    // Pivots and keyframes are spread as one set: a reset camera sits on its own pivot,
    // so separating the two kinds independently would still leave them stacked.
    const placed = spreadMarkers([
      ...path.pivots.map((pivot, index) => ({
        kind: 'pivot', index, point: view.project(pivotScene(pivot, playhead)),
        radius: PIVOT_RADIUS[index === selectedPivot ? 1 : 0],
      })),
      ...path.camera.map((item, index) => ({
        kind: 'key', index, point: view.project(cameraScenePosition(poseAt(path, item.frame), unit())),
        radius: KEY_RADIUS[index === selected && selectedPivot < 0 ? 1 : 0],
      })),
    ]);
    const pivots = placed.filter(marker => marker.kind === 'pivot');
    const marks = placed.filter(marker => marker.kind === 'key');

    // Every leader first, so none of them is drawn across a disc.
    placed.forEach(({ point, at, kind }) => {
      if (Math.hypot(at[0] - point[0], at[1] - point[1]) > 1) {
        leader(point, at, kind === 'pivot' ? '#d0a85f99' : '#4c9e8e99');
      }
    });

    pivots.forEach(({ index, at, radius }) => {
      // A tick along the pivot's up, so a straightened frame is visible from any selection.
      const resolved = pivotAt(path.pivots[index], playhead);
      const own = orbitFrame(resolved.tilt || 0, resolved.roll || 0, resolved.heading || 0);
      const up = [own[0][1], own[1][1], own[2][1]].map(v => -v);
      const foot = pivotScene(path.pivots[index], playhead);
      line(foot, [foot[0] + up[0] * 0.225, foot[1] - up[1] * 0.225, foot[2] - up[2] * 0.225], '#d0a85f88', 1);
      line(foot, [foot[0] + own[0][2] * 0.225, foot[1] - own[1][2] * 0.225,
                  foot[2] - own[2][2] * 0.225], '#d0a85f', 1);
      disc(at, radius, index === selectedPivot ? '#a77dff' : '#d0a85f', '#12121a');
      // Above the disc, not in it, so a pivot is never mistaken for a keyframe.
      if (path.pivots.length > 1) tag(String(index + 1), [at[0], at[1] - radius - 8], '#d0a85f');
    });

    // Draw the selected marker last; hit testing follows this same stack backwards.
    if (selectedPivot < 0) marks.push(...marks.splice(selected, 1));
    marks.forEach(({ index, at, radius }) => {
      disc(at, radius, index === selected && selectedPivot < 0 ? '#a77dff' : '#4c9e8e', '#12121a');
      tag(String(index + 1), at, '#fff');
    });
    hits = { marks, pivots, camera: view.project(cameraScenePosition(pose, unit())), view };

    const camera = hits.camera;
    sceneContext.beginPath();
    sceneContext.arc(camera[0], camera[1], 13, 0, Math.PI * 2);
    sceneContext.strokeStyle = '#8c4cff';
    sceneContext.lineWidth = 2;
    sceneContext.stroke();
  }

  /**
   * Redraws the camera view by reprojecting the cached cloud from the current pose.
   * @returns {void}
   */
  function drawRender() {
    const width = renderCanvas.clientWidth || 480, height = renderCanvas.clientHeight || 190;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    renderCanvas.width = Math.round(width * dpr);
    renderCanvas.height = Math.round(height * dpr);
    renderContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderContext.fillStyle = '#141419';
    renderContext.fillRect(0, 0, width, height);
    const camera = poseCamera(poseAt(path, playhead), preview.pivotZ);
    const holes = renderCamera(cloudAt(playhead), camera, preview.lens, preview.target, preview.splat);
    preview.context.putImageData(preview.image, 0, 0);
    const aspect = preview.meta.source_width / preview.meta.source_height;
    const w = Math.min(width, height * aspect), h = w / aspect;
    renderContext.imageSmoothingEnabled = false;
    renderContext.drawImage(preview.canvas, (width - w) / 2, (height - h) / 2, w, h);
    find('.render .label').textContent = preview.placeholder
      ? `frame ${Math.round(playhead)} \u00b7 placeholder \u00b7 run the node once to preview the real scene`
      : `frame ${Math.round(playhead)} \u00b7 ${Math.round(holes * 100)}% unseen \u00b7 preview ${preview.meta.width}\u00d7${preview.meta.height}`;
  }

  // -- Widgets ---------------------------------------------------------------

  /**
   * Rebuilds every widget from state and redraws both canvases. Cheap enough to call
   * on each pointer move.
   * @returns {void}
   */
  function refresh() {
    selected = clamp(selected, 0, path.camera.length - 1);
    selectedPivot = selectedPivot < 0 ? -1 : clamp(selectedPivot, 0, path.pivots.length - 1);
    playhead = clamp(playhead, 0, lastFrame());
    keys.replaceChildren();
    const span = Math.max(1, lastFrame());
    path.camera.forEach((item, index) => {
      const mark = document.createElement('div');
      mark.className = 'key' + (index === selected && selectedPivot < 0 ? ' selected' : '')
        + (item.frame > lastFrame() ? ' beyond' : '');
      mark.style.left = `${clamp(item.frame / span, 0, 1) * 100}%`;
      mark.dataset.index = index;
      mark.title = `Keyframe ${index + 1} at frame ${item.frame}`;
      keys.append(mark);
    });
    find('.cursor').style.left = `${clamp(playhead / span, 0, 1) * 100}%`;
    find('.count').textContent =
      `frame ${Math.round(playhead)} / ${lastFrame()}  ${(playhead / fps()).toFixed(2)}s`;
    find('[data-role=selection]').textContent = selectedPivot >= 0
      ? `pivot ${selectedPivot + 1} of ${path.pivots.length}`
      : `keyframe ${selected + 1} of ${path.camera.length} \u00b7 frame ${key().frame}`;
    const reset = find('[data-action=reset]');
    reset.textContent = inputPath ? 'Reset to input' : 'Reset path';
    reset.title = inputPath
      ? 'Replace the current path with the one on the camera_path input'
      : 'Delete every keyframe and start again from the source camera';
    find('[data-action=remove]').disabled = path.camera.length <= 1;
    find('[data-action=add]').disabled = path.camera.length >= MAX_KEYS
      || path.camera.some(item => item.frame === Math.round(playhead));
    find('[data-action=add-pivot]').disabled = path.pivots.length >= MAX_PIVOTS;

    const showPivot = selectedPivot >= 0;
    for (const panel of root.querySelectorAll('[data-panel]')) {
      panel.hidden = (panel.dataset.panel === 'pivot') !== showPivot;
    }
    const sync = (field, value) => {
      if (field.slider && document.activeElement !== field.slider) field.slider.value = String(value);
      if (document.activeElement !== field.number) field.number.value = String(Math.round(value * 1e4) / 1e4);
    };
    if (showPivot) {
      const pivot = path.pivots[selectedPivot];
      for (const [name, field] of pivotFields) sync(field, pivotKey(pivot)[name]);
      find('[data-role=pivot-name]').textContent = `Pivot ${selectedPivot + 1}`;
      find('[data-action=remove-pivot]').disabled = path.pivots.length <= 1 || inUse(pivot.id);
      find('[data-action=snap-pivot]').disabled =
        PIVOT_AXES.every(name => pivotKey(pivot)[name] === PIVOT_DEFAULTS[name]);
    } else {
      for (const [name, field] of fields) sync(field, key()[name]);
      const angle = key().azimuth * Math.PI / 180;
      orbitDial.mark.style.left = `${50 + Math.sin(angle) * 43}%`;
      orbitDial.mark.style.top = `${50 - Math.cos(angle) * 43}%`;
      const x = key().pan / 90, y = key().tilt / 90;
      const radius = Math.hypot(x, y);
      const scale = radius ? Math.max(Math.abs(x), Math.abs(y)) / radius : 0;
      aimPuck.mark.style.left = `${50 + x * scale * 40}%`;
      aimPuck.mark.style.top = `${50 - y * scale * 40}%`;
      lockInput.checked = (key().lock || 0) >= 0.5;
      pivotSelect.replaceChildren(...path.pivots.map((pivot, index) => {
        const option = document.createElement('option');
        option.value = pivot.id;
        option.textContent = `Pivot ${index + 1}`;
        return option;
      }));
      pivotSelect.value = key().pivot;
      pivotSelect.disabled = path.pivots.length <= 1;
    }
    const beyond = path.camera.filter(item => item.frame > lastFrame()).length;
    const status = beyond ? `${beyond} keyframe(s) sit past frame ${lastFrame()} and are held at the end.` : '';
    find('.status').textContent = error || status;
    find('.status').classList.toggle('error', Boolean(error));
    drawScene();
    drawRender();
  }

  // -- Interaction -----------------------------------------------------------

  /**
   * Pointer position in the scene canvas's own layout pixels.
   *
   * getBoundingClientRect() reports post-transform screen pixels while the projector
   * works in untransformed layout pixels, and ComfyUI scales the whole graph. Mixing
   * the two put every hit test out by the graph zoom, so the gizmo could only be
   * grabbed at exactly 100%.
   * @param {PointerEvent} event Pointer event.
   * @returns {number[]} [x, y] in the same space as `hits`.
   */
  function pointerInScene(event) {
    const box = scene.getBoundingClientRect();
    const scaleX = box.width ? (scene.clientWidth || box.width) / box.width : 1;
    const scaleY = box.height ? (scene.clientHeight || box.height) / box.height : 1;
    return [(event.clientX - box.left) * scaleX, (event.clientY - box.top) * scaleY];
  }

  /**
   * What the pointer is over, for hit testing and the hover cursor. Keyframes win
   * over pivots, and the selected pivot over the others, so a pivot just added on
   * top of another can be dragged away.
   * @param {number} x Pointer x in layout pixels.
   * @param {number} y Pointer y in layout pixels.
   * @returns {{kind: string, index: number}|null} The keyframe or pivot under the
   *   pointer, the keyframe the camera gizmo stands for, or null for background.
   */
  function grabbableAt(x, y) {
    // Against the disc as drawn, not as projected: markers nudged apart to stay legible
    // have to be grabbable where they ended up.
    const within = mark => Math.hypot(mark.at[0] - x, mark.at[1] - y) < mark.radius + 5;
    const near = [...hits.marks].reverse().find(within);
    if (near) return { kind: 'key', index: near.index };
    if (Math.hypot(hits.camera[0] - x, hits.camera[1] - y) < 16) return { kind: 'key', index: selected };
    const pivot = hits.pivots.find(mark => mark.index === selectedPivot && within(mark))
      ?? hits.pivots.find(within);
    if (pivot) return { kind: 'pivot', index: pivot.index };
    return null;
  }

  scene.addEventListener('pointerdown', event => {
    const [x, y] = pointerInScene(event);
    // Shift or the middle button pans the view; anything else on the background turns it.
    const panning = event.shiftKey || event.button === 1;
    const grab = panning ? null : grabbableAt(x, y);
    if (event.button === 1) event.preventDefault();
    scene.setPointerCapture(event.pointerId);
    if (!grab) {
      drag = { mode: panning ? 'pan' : 'view', x, y, view: hits.view };
      return;
    }
    stop();
    if (grab.kind === 'pivot') {
      selectPivot(grab.index);
      const position = pivotKey(path.pivots[grab.index]);
      drag = { mode: 'pivot', x, y, dx: 0, dy: 0, view: hits.view,
               start: PIVOT_POSITION.map(spec => position[spec.name]) };
    } else {
      selectKey(grab.index);
      drag = {
        mode: event.ctrlKey || event.metaKey ? 'truck' : 'orbit',
        x, y, dx: 0, dy: 0, pose: poseAt(path, key().frame), view: hits.view,
      };
    }
    scene.style.cursor = 'grabbing';
    refresh();
  });

  scene.addEventListener('pointermove', event => {
    const [x, y] = pointerInScene(event);
    if (!drag) {
      scene.style.cursor = grabbableAt(x, y) ? 'grab' : 'move';
      return;
    }
    const dx = x - drag.x, dy = y - drag.y;
    drag.x = x;
    drag.y = y;
    if (drag.mode === 'view') {
      // Negated so the scene follows the pointer; pitch already does.
      yaw -= dx * 0.008;
      pitch = clamp(pitch + dy * 0.008, -1.25, 1.25);
      drawScene();
      return;
    }
    if (drag.mode === 'pan') {
      // The centre moves against the pointer so the scene follows it.
      const basis = screenBasis(drag.view.yaw, drag.view.pitch);
      pan = [0, 1, 2].map(i => pan[i] - (basis.right[i] * dx - basis.up[i] * dy) / drag.view.scale);
      drawScene();
      return;
    }
    drag.dx += dx;
    drag.dy += dy;
    const upright = drag.view.upright?.rotation ?? null;
    if (drag.mode === 'pivot') {
      // Slide the pivot in the screen plane, then back through the upright turn, scene
      // units and world units.
      const basis = screenBasis(drag.view.yaw, drag.view.pitch);
      let delta = [0, 1, 2].map(i => (basis.right[i] * drag.dx - basis.up[i] * drag.dy) / drag.view.scale);
      if (upright) delta = [0, 1, 2].map(i => upright[0][i] * delta[0] + upright[1][i] * delta[1] + upright[2][i] * delta[2]);
      const world = worldOffset(delta, unit());
      const position = pivotKey(path.pivots[selectedPivot]);
      PIVOT_POSITION.forEach((spec, i) => {
        position[spec.name] = clamp(Math.round((drag.start[i] + world[i] / unit()) * 1e3) / 1e3, spec.min, spec.max);
      });
    } else {
      const next = drag.mode === 'truck'
        ? dragTruck(drag.pose, drag.dx, drag.dy, drag.view.scale, drag.view.yaw, drag.view.pitch, upright)
        : dragOrbit(drag.pose, unit(), drag.dx, drag.dy, drag.view.scale, drag.view.yaw, drag.view.pitch, upright);
      for (const [name, value] of Object.entries(next)) {
        const spec = FIELDS.find(field => field.name === name);
        key()[name] = clamp(Math.round(value * 1e3) / 1e3, spec.min, spec.max);
      }
    }
    commit();
    refresh();
  });

  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    scene.addEventListener(name, () => {
      drag = null;
      scene.style.cursor = 'move';
    });
  }

  scene.addEventListener('dblclick', event => {
    // Recentre on the view pivot; a double-click on a marker is left to the drag.
    if (grabbableAt(...pointerInScene(event))) return;
    pan = [0, 0, 0];
    drawScene();
  });

  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.altKey) {
      if (selectedPivot < 0) setAxis(DISTANCE, key().distance * Math.exp(event.deltaY * 0.001));
      return;
    }
    zoom = clamp(zoom * Math.exp(-event.deltaY * 0.0015), 0.3, 20);
    drawScene();
  }, { passive: false });

  /**
   * Pointer x -> the frame under it on the timeline.
   * @param {PointerEvent} event Pointer event.
   * @returns {number} Frame index, clamped to the timeline.
   */
  function trackFrame(event) {
    const box = track.getBoundingClientRect();
    return Math.round(clamp((event.clientX - box.left) / box.width, 0, 1) * lastFrame());
  }

  track.addEventListener('pointerdown', event => {
    stop();
    track.setPointerCapture(event.pointerId);
    const index = event.target.dataset?.index;
    if (index !== undefined) {
      selectKey(Number(index));
      drag = { mode: 'key' };
    } else {
      drag = { mode: 'scrub' };
      playhead = trackFrame(event);
    }
    refresh();
  });

  track.addEventListener('pointermove', event => {
    if (!drag || (drag.mode !== 'key' && drag.mode !== 'scrub')) return;
    const frame = trackFrame(event);
    if (drag.mode === 'scrub') {
      playhead = frame;
    } else {
      if (path.camera.some((item, index) => index !== selected && item.frame === frame)) return;
      key().frame = frame;
      path.camera.sort((a, b) => a.frame - b.frame);
      selected = path.camera.findIndex(item => item.frame === frame);
      playhead = frame;
      commit();
    }
    refresh();
  });

  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    track.addEventListener(name, () => { drag = null; });
  }

  /**
   * Stops playback.
   * @returns {void}
   */
  function stop() {
    playing = false;
    cancelAnimationFrame(frameRequest);
    find('[data-action=play]').textContent = '\u25b6';
  }

  /**
   * Playback frame callback; advances the playhead at the host's fps and stops at the end.
   * @param {number} now High-resolution timestamp.
   * @returns {void}
   */
  function tick(now) {
    if (disposed || !playing) return;
    playhead = playFrom + (now - playStart) / 1000 * fps();
    if (playhead >= lastFrame()) {
      playhead = lastFrame();
      stop();
    } else {
      frameRequest = requestAnimationFrame(tick);
    }
    refresh();
  }

  root.addEventListener('click', event => {
    const action = event.target.dataset?.action;
    if (!action) return;
    if (action === 'play') {
      if (playing) {
        stop();
      } else {
        playing = true;
        playFrom = playhead >= lastFrame() ? 0 : playhead;
        playStart = performance.now();
        find('[data-action=play]').textContent = '\u275a\u275a';
        frameRequest = requestAnimationFrame(tick);
      }
      return;
    }
    stop();
    if (action === 'add') {
      const frame = Math.round(playhead);
      if (path.camera.length >= MAX_KEYS || path.camera.some(item => item.frame === frame)) return;
      const { pivot: _position, ...pose } = poseAt(path, frame);
      // A new key inherits the pivot of the key before it, or the first key's.
      const before = [...path.camera].reverse().find(item => item.frame < frame) ?? path.camera[0];
      path.camera.push({ frame, pivot: before.pivot, ...pose });
      path.camera.sort((a, b) => a.frame - b.frame);
      selected = path.camera.findIndex(item => item.frame === frame);
      selectedPivot = -1;
      commit();
    }
    if (action === 'remove' && path.camera.length > 1) {
      path.camera.splice(selected, 1);
      selectKey(selected);
      commit();
    }
    if (action === 'add-pivot' && path.pivots.length < MAX_PIVOTS) {
      let number = path.pivots.length + 1;
      while (path.pivots.some(pivot => pivot.id === `p${number}`)) number++;
      path.pivots.push(defaultPivot(`p${number}`));
      selectPivot(path.pivots.length - 1);
      commit();
    }
    if (action === 'remove-pivot' && selectedPivot >= 0 && path.pivots.length > 1
        && !inUse(path.pivots[selectedPivot].id)) {
      path.pivots.splice(selectedPivot, 1);
      selectPivot(selectedPivot);
      commit();
    }
    if (action === 'snap-pivot' && selectedPivot >= 0) {
      Object.assign(pivotKey(path.pivots[selectedPivot]), PIVOT_DEFAULTS);
      commit();
    }
    if (action === 'recentre-aim') {
      key().pan = key().tilt = 0;
      commit();
    }
    if (action === 'reset-key') {
      path.camera[selected] = { frame: key().frame, pivot: key().pivot, ...identityPose() };
      commit();
    }
    if (action === 'reset') resetPath();
    if (action === 'zoom-in' || action === 'zoom-out') {
      zoom = clamp(zoom * (action === 'zoom-in' ? 1.25 : 0.8), 0.3, 20);
    }
    if (action === 'view-reset') {
      yaw = 0.55;
      pitch = 0.45;
      zoom = 1;
      pan = [0, 0, 0];
    }
    refresh();
  });

  // -- Host interface --------------------------------------------------------

  /**
   * Re-reads the widgets. Called when the host changes keyframes, frame_count or
   * markers. A malformed path is reported in the status line, never thrown.
   * @returns {void}
   */
  function sync() {
    const raw = readPath();
    if (raw !== written) {
      try {
        path = normalizePath(JSON.parse(raw));
        written = raw;
        error = '';
        selected = clamp(selected, 0, path.camera.length - 1);
      } catch (problem) {
        error = `camera_path: ${problem.message}`;
      }
    }
    refresh();
  }

  /**
   * Adopts a path from outside the editor, replacing whatever is loaded.
   * @param {object|object[]} data Path object or keyframe array.
   * @returns {void}
   */
  function loadPath(data) {
    try {
      path = normalizePath(data);
      error = '';
      selected = clamp(selected, 0, path.camera.length - 1);
      selectedPivot = -1;
      commit();
    } catch (problem) {
      error = `camera_path: ${problem.message}`;
    }
    refresh();
  }

  /**
   * Records the path that arrived on the camera_path socket on the last run.
   *
   * It is a seed, not an override: it is only adopted outright when nothing has been
   * authored yet. Otherwise it waits behind Reset path, so a run cannot wipe out the
   * user's edits.
   * @param {object|object[]|null} data Path from the node, or null when unconnected.
   * @returns {void}
   */
  function setInputPath(data) {
    const usable = Array.isArray(data) ? data.length > 0 : Boolean(data?.camera?.length);
    inputPath = usable ? data : null;
    if (inputPath && pristine()) {
      loadPath(inputPath);
      return;
    }
    refresh();
  }

  /**
   * Loads (or clears) the cached point cloud. Late loads are discarded by token so a
   * slow fetch cannot overwrite a newer one.
   * @param {object|null} meta The `preview` block of the node UI payload, or null.
   * @param {(reference: object) => string} urlFor Turns a file reference into a URL.
   * @returns {Promise<void>}
   */
  async function setPreview(meta, urlFor) {
    const token = ++previewToken;
    if (!meta) {
      if (!preview.placeholder) preview = placeholderPreview();
      refresh();
      return;
    }
    try {
      const loaded = await loadPreview(meta, urlFor);
      if (disposed || token !== previewToken) return;
      preview = loaded;
      error = '';
    } catch (problem) {
      if (disposed || token !== previewToken) return;
      if (!preview.placeholder) preview = placeholderPreview();
      error = 'Could not load the cached geometry preview.';
      console.warn('[CameraPath] could not load the cached geometry', problem);
    }
    refresh();
  }

  /**
   * Switches the scene and the render side by side once the widget is wide enough
   * and landscape. Done here rather than with a container query because querying
   * height needs `container-type: size`, which would stop the widget sizing itself.
   * @returns {void}
   */
  function applyLayout() {
    const width = root.clientWidth || 0, height = root.clientHeight || 0;
    root.classList.toggle('wide', width >= SIDE_BY_SIDE_WIDTH && width > height);
  }

  const observer = new ResizeObserver(() => {
    applyLayout();
    drawScene();
    drawRender();
  });
  observer.observe(root);
  applyLayout();
  sync();

  return {
    element: root,
    sync,
    loadPath,
    setInputPath,
    setPreview,
    destroy() {
      disposed = true;
      previewToken++;
      stop();
      observer.disconnect();
    },
  };
}
