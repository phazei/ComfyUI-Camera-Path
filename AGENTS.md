# AGENTS.md

Guidelines for working on this project. Read this before making changes.

## Working Agreement

Read this part first. It outranks everything below.

### Discuss before implementing

- **Do the task that was asked, not the adjacent work you noticed.** Spotting something worth
  fixing is useful; report it and let the maintainer decide. Do not fold it into the current
  change.
- **Stop and confirm the scope before writing code** for anything beyond a small, obvious
  edit. State what you intend to touch and why, then wait. A one-line check-in is cheaper
  than an unwanted refactor.
- **Plan, don't proceed, when the request is ambiguous.** "Look at X and keep some of its
  concepts" is a discussion, not an implementation ticket.
- **Flag breaking changes before making them**, not after. Renamed node IDs, changed output
  types and moved files all break saved workflows.

### The maintainer is a resource — ask first

Before an open-ended dig through the codebase or the web, ask. He very often already has the
file, link or reference on disk and can hand it over in one message.

- Ask "is there a doc or reference for this?" before reverse-engineering an API from source.
- Ask which of several plausible approaches he wants before picking one.
- Context is a shared budget. Minutes of research that a single question would have answered
  are minutes of context that the actual work no longer has.

Concretely: `D:\AITools\ComfyUI-Enhancement-Utils\Comfyui-Nodes2-Migration-Resources.md`
already documents the V3 schema, the Nodes 2.0 renderer, the DOM widget system and the
relevant local source paths. Check it, and ask, before reading ComfyUI source to rediscover
the same things.

### Never touch git without explicit permission

No `commit`, `add`, `stage`, `checkout`, `branch`, `merge`, `rebase`, `reset`, `restore`,
`stash`, `push`, `pull`, `tag`, no `gh` PR or issue commands, and no changes to git config or
hooks — unless the maintainer asks for that specific action in that message. Read-only
inspection (`status`, `diff`, `log`, `show`) is fine at any time.

Leave finished work uncommitted and say so. He reviews before anything is recorded.

## Project Goals

A ComfyUI custom node that turns a still image or a clip plus its MoGe geometry into a
camera-move video, with the camera path authored in an interactive 3D editor on the node.

- **Generic utility, not a workflow** — it outputs a plain `IMAGE` batch. It must stay usable
  as a reference/control video by any downstream model. No model-specific resolutions,
  frame-count grids, fixed hole-colour conventions, prompt building or conditioning. The
  hole colour is a free `background` widget, black by default, precisely so that no one
  model's convention is baked in; the maintainer added it for a LoRA trained on
  CrossViewWarp's magenta holes.
- **Few knobs** — the pivot, the lens and the interpolation are derived from the geometry.
  Do not add a control unless the node genuinely cannot work without it.
- **The preview must match the render** — the JS editor re-implements the Python camera math.
  They are kept honest by a parity test; that is a hard constraint, not a nicety.
- **Well-organized, well-documented code** — every module, class and function gets a
  docstring or JSDoc comment.

## Architecture

### Layout

```
__init__.py                     V3 entry point (comfy_entrypoint, WEB_DIRECTORY)
nodes/__init__.py               ALL_NODES registry
nodes/camera_path_video.py      The node: schema + execute
camera_path/trajectory.py       Keyframe JSON parse/serialize + PCHIP interpolation
camera_path/render.py           Camera math + point-cloud splat renderer
camera_path/geometry.py         MOGE_GEOMETRY unpacking
camera_path/preview.py          Writes the cached cloud for the editor
js/camera-path.js               Extension: mounts the editor, routes the UI payload
js/editor.js                    The editor DOM widget
js/geometry.js                  Mirror of render.py, plus the editor's own scene projection
js/interpolate.js               Mirror of trajectory.py
js/preview.js                   Loads the cached cloud PNGs
js/furniture.js                 Editor-only scene furniture: floor grid, placeholder figure
tests/                          unittest + node/jsdom harnesses
```

`camera_path/` imports only torch, numpy and PIL — no ComfyUI — so it can be tested
standalone. Everything that touches ComfyUI lives in `nodes/` and `__init__.py`.

### Python

- **V3 schema** (`comfy_api.latest`) for all nodes — `io.ComfyNode`, `define_schema()`,
  `io.NodeOutput`. Do NOT use the V1 schema (`NODE_CLASS_MAPPINGS`, `INPUT_TYPES` dict).
- `NODE_CLASS_MAPPINGS` must NOT be present in `__init__.py` — its presence triggers the V1
  code path in ComfyUI's loader (`if/elif` fork in `nodes.py`) and silently blocks
  `comfy_entrypoint()`. Only `WEB_DIRECTORY` is read before the fork.
- `WEB_DIRECTORY = "./js"` (docs convention).
- Node IDs are prefixed with `CameraPath_` (e.g. `CameraPath_Video`).
- Node categories use existing ComfyUI categories (`image/video`), not a custom top-level one.
- Python logging via `logging.getLogger("camerapath.module.name")`.
- New nodes: add to `nodes/`, import in `nodes/__init__.py`, add to `ALL_NODES`.
- `has_intermediate_output=True` on any node with an interactive UI region — it makes
  ComfyUI cache and resend the node's UI output after a page refresh. Without it the
  editor loses its point cloud on every reload.

### JavaScript

- Plain JS, no build step. Files in `js/` are auto-loaded via `WEB_DIRECTORY`.
- Import pattern: `import { app } from "../../scripts/app.js"`, same for `api.js`.
- One extension registration: `app.registerExtension({ name: "phazei.CameraPath", ... })`.
- Console warnings use prefix: `[CameraPath]`.
- The editor is a **DOM widget** (`node.addDOMWidget`). That is deliberate: the Nodes 2.0
  Vue renderer wraps DOM widgets in `WidgetDOM`, so the node works on both renderers with
  no extra work. Do not move any of it to canvas-drawn widgets.
- `js/editor.js` is renderer- and ComfyUI-agnostic. It receives `readPath`, `writePath` and
  `readFrameCount` accessors and returns `{ element, sync, loadPath, setPreview, destroy }`.
  Keep ComfyUI specifics in `camera-path.js`.

### The node

`CameraPath_Video` (`nodes/camera_path_video.py`):

- Inputs: `source` (IMAGE), `moge_geometry` (MOGE_GEOMETRY), `frame_count` (INT, 120),
  `fps` (FLOAT, 24), `markers` (BOOLEAN), `background` (COLOR, `#000000`),
  `prune_depth_edges` (BOOLEAN, true),
  `preview_quality` (COMBO, Medium (512)), `keyframes` (STRING), `camera_path` (STRING,
  socket only).
- Outputs: `camera_video` (IMAGE, source resolution), `camera_path` (STRING, round-trips
  into the input), `video_mask` (MASK, 1 where nothing was reprojected).
- `fps` is the editor's timeline and playback rate and nothing else. The output is a plain
  image batch with no rate of its own, so `execute` never reads it and the render is
  identical at any value; the editor reads the widget through a `readFps` accessor and
  falls back to 24. It is a real input rather than an editor-local control so the rate is
  saved with the workflow and can be driven from upstream.

**The two path inputs are not interchangeable.** `keyframes` is the widget the editor writes
to, hidden from the node body by `js/camera-path.js`, and it is what actually renders.
`camera_path` is `force_input=True` — a connection dot with no box — and is a **seed, not an
override**: the node hands it back untouched in the UI payload, the editor adopts it only if
nothing has been authored yet, and otherwise it waits behind the Use input button, shown
only while an input is connected. Clear path always returns to the source camera; that
result is pristine, so the next run re-adopts a connected input. A
connected input that silently replaced the widget would destroy the user's edits on every
run, which is exactly what the old single-input design did.
- UI output: `{"camera_path": [json]}` carrying `{path, frame_count, markers, input_path, preview}`.
- `markers` appends the marker lattice (below) to every frame's cloud before splatting.
  The editor does not wait for the payload to hear about it: `js/camera-path.js` hands it
  a `readMarkers` accessor on the widget, so toggling the checkbox shows or hides the
  lattice in both panes at once and the preview matches the render by construction.
- `background` is the hole colour, an `io.Color` widget (a native picker on both
  renderers). `render.hex_color` parses it for `PointCloud.render`; `geometry.hexColor`
  does the same for `renderCamera`, reached through a `readBackground` accessor, so the
  render pane repaints its holes the moment the colour changes. Only the render pane: the
  overview's dark backdrop is editor chrome, not output. `video_mask` is independent of it.
- Output frame `i` uses source frame `i`; once the source runs out its last frame and last
  geometry frame are held. The input batch is never interpolated in time.
- The lens and the **automatic pivot depth** are read from the **anchor frame (index 0)**
  and reused for the whole clip, so they cannot drift mid-move. That depth is the unit every
  pivot position is expressed in.

### Path format

Version 2 is an object; a bare array of camera keyframes is version 1 and still loads.

```json
{
  "version": 2,
  "pivots": [{"id": "p1", "keys": [{"frame": 0, "x": 0, "y": 0, "z": 1, "tilt": 0, "roll": 0}]}],
  "camera": [{"frame": 0, "pivot": "p1", "azimuth": 0, "...": "..."}]
}
```

- A **pivot** is a point plus the frame the camera orbits it in. Its position is in units of
  the automatic pivot depth, so `(0, 0, 1)` is the subject the node found on its own and a
  path carries over to other footage without rescaling. There is deliberately no absolute
  mode: MoGe is scale-free, so an absolute coordinate would mean nothing on another image.
- Pivots are referenced **by id**, never by index, so deleting one cannot silently reassign
  every keyframe below it. A keyframe without `pivot` orbits the first one.
- A pivot's `keys` is a track. The editor writes exactly one key today, but the shape is the
  temporal pivot (a subject that moves) waiting to be data rather than a migration.
- Camera keys also store `pivot_target` (a pivot id) and `pivot_blend` (0..1). The
  effective pivot is the linear blend of the primary and target pivot components,
  each resolved at that camera key's frame. Missing targets are inferred once from
  the next distinct camera pivot, or the primary pivot if none follows; missing blend is 0.
- Compatible contiguous runs involving the same two pivots interpolate one PCHIP blend
  ratio, shared by all six pivot components. Unblended keys can join either adjacent
  handoff. Spans involving more pivots ease between resolved endpoints with smoothstep.
  Camera axes retain their independent PCHIP curves. This changes existing multi-pivot
  paths' intermediate motion, not their authored unblended endpoint shots.
- Insertion captures camera axes and `pivotBlendAt`'s two-pivot state, retaining the
  preceding primary pivot. Before committing, it checks the effective pivot matches.
  When it cannot — a span mixing three pivots, or an animated track — the keyframe is
  **fitted** instead: `editor.estimatedKey` attaches it to the previous keyframe's blend
  target (its primary pivot when it is not blending) and `geometry.solvePose` solves
  azimuth/elevation/distance for the eye and pan/tilt/roll for the basis, with truck,
  boom, dolly and lock zeroed because they are redundant there. It is exact to floating
  point unless an axis limit clamps; the notice then says `approximate`. No stored
  multi-pivot weights, no automatically created pivots, and insertion is never refused.
- Changing a camera's primary pivot re-solves its axes through the same `editor.fitPose`
  when **Keep shot** is ticked, so the camera holds still while its numbers change. The
  maintainer asked for it once `solvePose` existed; the earlier decision was that pivot
  reassignment never preserved the pose. Lock cannot survive — it is a behaviour, not a
  pose, so a held camera comes back unlocked and stops following its pivot. The checkbox is
  editor-local and resets with the page.
- Insertion preserves the sampled shot within serialization precision, not the entire
  surrounding curve: automatic slopes are recalculated. Explicit targets survive
  neighbouring insertions/reordering and count as references when protecting pivot deletion.

### Camera model

Everything is in the MoGe/OpenCV frame: `+x` right, `+y` **down**, `+z` into the scene,
source camera at the origin. **Camera settings are relative to their pivot's position and
frame.** All cameras share the automatic pivot depth as their distance unit.

| Axis | Meaning |
| --- | --- |
| `azimuth` | degrees around the pivot's up axis, + orbits the camera right |
| `elevation` | degrees around the pivot's right axis, + raises the camera |
| `distance` | orbit radius in shared automatic-depth units; 1 is the same radius for every pivot |
| `lateral` | truck: slides the camera along its own right axis, in units of pivot depth |
| `height` | boom: raises the camera along the pivot's up, in units of pivot depth |
| `dolly` | moves along the final aimed camera forward axis in shared units; positive forward, negative backward |
| `lock` | 0 = the target travels with the camera, 1 = it stays on the pivot |
| `pan` | degrees about the camera's own vertical, + aims right |
| `tilt` | degrees about the camera's own right axis, + aims up |
| `roll` | degrees about the camera's own forward axis, + rolls the camera clockwise |

The camera basis is `orbit_frame @ rotY(-azimuth) @ rotX(-elevation)` and its position is
`pivot - forward * distance * unit`, before truck, boom and aim. Tested invariants:

- Reset cameras inherit their pivot's orientation and sit one shared unit behind it.
- Moving or straightening a pivot moves or turns its cameras, including a reset camera.
- Orbiting keeps the pivot centred until truck, boom or aim shifts the framing.
- **Snap to auto + Reset key** reproduces the source camera exactly. To keep the original
  starting frame, leave its pivot at auto and use another pivot for the destination.

Every axis is optional in the JSON and defaults to the pivot-relative reset pose
(`trajectory.axis` / `interpolate.axis`). No keyframe or pivot is frozen or special.

**Pivot `tilt` and `roll`** turn the frame the orbit happens in (`render.orbit_frame`). A
shot that was pitched down or rolled has an image vertical that is not the scene's, so every
orbit about it looks tilted, and camera roll can only fake a fix at one azimuth. Straightening
the pivot fixes every camera on it at once, and leaves camera `roll` free for cinematography.
The pivot exposes tilt and roll for straightening, plus `heading` to set camera azimuth
zero. Its frame is `rotZ(roll) @ rotX(tilt) @ rotY(-heading)`: heading turns around the
corrected up axis, with the same sign as camera azimuth. Each camera keeps its own azimuth
offset. Heading is a pivot track axis, defaults to zero, and Snap to auto clears it.
The overview and floor use only tilt/roll, so changing heading visibly rotates the cameras
rather than rotating the view with them. The pivot marker has up and forward ticks.

`lateral` and `height` move the camera **and its target** together, so the lens keeps its
direction and the subject travels across the frame. `azimuth`/`elevation` swing around the
pivot instead.

`lock` blends the target back onto the pivot: `target = pivot + (1 - lock) * carried`. It is
a **number, not a boolean**, precisely so it can be interpolated — a keyframe that turns
locking on eases into it instead of popping. The editor presents it as a checkbox that
writes 0 or 1, which is a UI detail, not the storage format. The look-at's roll reference is
the camera's own down carried through the orbit, so a locked camera stays level in the
pivot's frame rather than the image's.

`pan`, `tilt` and `roll` are applied by `render.aim` *after* the look-at, as a rotation of
the camera basis about its own axes. They do not move the camera, only turn it, so they
compose with everything above. `FIELDS` allows pan and tilt +-180 while the puck's surface
only maps +-90, so the extra half is reachable by typing and a dragged puck rewrites a
typed value back into its own range; `refresh` clamps the mark to the rim so it cannot be
drawn outside the circle. The wider limit also lets `solvePose` land a fit that needs to
look backwards, which used to clamp and report `approximate`. The puck's Recentre zeros
pan/tilt only; roll has numeric
entry and Reset key clears all camera axes. There is no separate Reset aim button.

`dolly` is applied last: `eye += forward * dolly * unit`, using the final aimed forward
axis. It does not re-aim or recompute lock. Its default is zero; the editor slider spans
-3 to +3 shared units. With other axes held constant, animating only dolly is a straight
move. The orbit drag solver excludes this final offset just as it excludes truck/boom.

Historical note: the previous rigid-source model kept every reset camera at the source,
regardless of pivot edits. This also made distance 1 mean different radii and prevented
reset cameras from inheriting pivot straightening. The maintainer chose pivot-relative
poses instead, with a second pivot when the starting shot must stay at the source. A
special "match source" mode was discussed and deliberately not added.

- Automatic pivot depth: lower quartile of the depth across the central region
  (`render.pivot_depth`). The quartile lands on the subject rather than the backdrop.
- Lens: MoGe's normalised intrinsics, `fx_px = K[0,0] * width`, `fy_px = K[1,1] * height`.
  Panorama geometry has no intrinsics, so `render.estimate_focal` least-squares fits one
  from the point map (exact for a perspective map, 60° fallback if the fit degenerates).
- Interpolation: monotone cubic (PCHIP) per axis on the frame index. Keyframes are hit
  exactly, nothing overshoots, the path is held outside the first/last keyframe.

### Renderer

`render.PointCloud.render` splats each point over a `(2*splat+1)²` window with a z-buffer,
in torch, on `comfy.model_management.get_torch_device()`. Roughly 6 ms per 720p frame on a
GPU, 140 ms on CPU. Holes (pixels no point reached) come back in the `background` colour and are reported in
`video_mask`.

### Marker lattice

`render.marker_lattice(unit)` is a grid of small spheres — 24 points each on a Fibonacci
spiral — laid out in units of the automatic pivot depth (`LATTICE_SPACING`,
`LATTICE_CENTRE`, `LATTICE_HALF`, `LATTICE_ANCHOR`, `LATTICE_RADIUS`, `LATTICE_POINTS`).

- **Staggered.** The grid is a **3D checkerboard**: counting whole steps from the anchor,
  spheres whose steps sum to an odd number move half a spacing along +x, +y and +z. Every
  axis line holds every other sphere and the moved half fills the lines between, so the
  density is a plain grid's — one sphere per cubic spacing — but nothing stacks behind
  anything along an axis, the source camera's line of sight included. It is a diamond
  lattice.
- **Anchored.** `LATTICE_ANCHOR` is `(0, 0, 0.5)`, the sphere dead ahead of the source
  camera, and it never moves. The stagger is counted from it rather than from a box corner
  so that resizing the box cannot flip which half moves; with the other half, the view axis
  first meets a sphere at depth 1.5 and `test_the_lattice_is_occluded_by_nearer_geometry`
  finds nothing in front of its wall.
- **Centred on the pivot plane.** The box is `LATTICE_CENTRE ± LATTICE_HALF`,
  `(0, 0, 1) ± 3`, and every sphere landing inside it is kept: 273 of them. It used to sit
  entirely in front of the source camera, so a camera orbited round to face it saw almost
  nothing; now it is as deep behind the pivot as in front and as wide as it is deep. Raising
  the half-width raises the count, never the density. The tint spans the box.

Each sphere is coloured by where it sits (x → red,
y → green, z → blue) so it keeps one colour through a move, with a light Lambert shade so it
reads as a sphere. `geometry.markerLattice` is the mirror; `test_lattice_matches` compares
the points at float32 precision and the colours to within one level.

The lattice is **points appended to the cloud** (`PointCloud.joined`, `concatClouds`), not
an overlay. That is what makes it worth having: the z-buffer occludes it behind the subject,
perspective shrinks it with distance, and the preview and the render agree for free. Do not
turn it into a 2D pass. Lattice pixels count as reprojected in `video_mask`; they are content.

Only the render contract cares about it. The floor grid and the placeholder figure in
`js/furniture.js` are clouds too — for the same occlusion reason — but they are editor-only
and never reach Python.

### Editor scene view

The overview is orthographic (`editor.projector`, `geometry.renderScene`). It turns about
the **view pivot** — the selected pivot, or the one the current pose orbits — offset by any
pan, and is first stood upright in that pivot's orbit frame. Plain drag on the background
turns it, shift-drag or the middle button pans, double-click on the background zeroes the
pan, wheel zooms. All the drag maths in `geometry.js` is in screen-plane deltas, so the
rotation centre never enters it; only `project` and `renderScene` subtract the centre.

The floor grid and the cloud share one z-buffer per redraw, so the floor sits behind the
geometry rather than being painted over it. The floor is laid in the view pivot's frame
through the bottom edge of the source footprint at unit depth: `y = 0.5 / fy_norm` there,
or a 60° lens's worth until the node has run.

Until the node has run the editor draws a placeholder — a square frame and a rounded
figure at `(0, 0, 1)` — through a `preview`-shaped object (`placeholderPreview`) so both
panes work from day one and `preview` is never null. `preview.placeholder` is the flag
where the two must differ (the label, the floor height).

Keyframes and pivots are numbered discs (`KEY_RADIUS`, `PIVOT_RADIUS`). A path that doubles
back, or a view that flattens it, would otherwise stack them into one unreadable and
ungrabbable blob, so `editor.spreadMarkers` nudges overlapping discs apart and each one that
moved keeps a leader line back to the point it stands for. Its `at` is where the marker is
drawn **and hit tested**; its `point` is where it really is. Consequences worth knowing:

- Pivots and keyframes are spread as one set. A reset camera sits on its own pivot, so
  separating the two kinds independently would leave them stacked on each other.
- The relaxation only acts on pairs that actually overlap, so an uncrowded scene draws
  exactly where it projects and nothing drifts. Coincident markers have no axis to separate
  along, so they fan out by index — deliberately deterministic, or the scene would reshuffle
  on every redraw.
- Displacement is capped at `MARKER_SPREAD`, without which a dense cluster walks its
  outermost markers off the viewport.
- The playhead ring is **not** spread: it marks where the live camera is, so it stays on the
  true position even when the keyframe disc for that frame has been nudged aside.
  It only edits the selected key when the playhead is exactly at that key. Between keys
  clicking it is informational, never a seek to the selected camera elsewhere.
- The camera panel is four `fieldset.group`s — Orbit, Aim, Position, Pivot — built by
  `editor.buildGroup`, each holding an optional round control and a `.stack` of rows. The
  **group** is what responds to width: `.group .body` wraps, so a puck's axes sit beside it
  when the group is wide enough and underneath it when not, and no individual control needs
  a breakpoint. `min-width:0` on `.group` is load-bearing — a fieldset's default
  `min-inline-size` is `min-content`, which would stop the grid column shrinking. Both
  `.round-controls` columns are fixed at the same width, wider than the dial's lone label
  needs, so Orbit and Aim wrap at the same width rather than one at a time. The label
  column is `--label` on the group, 70px by default and 46px for Aim, whose single slider
  row has no siblings to line up with; a group of uniform rows wants the wider default. The
  lock
  checkbox is right-aligned because it has no number box to line up with. Rows
  inside a group lose the tile border and padding, which pays for the legends; the panel is
  within ~10px of the flat grid it replaced, and `.fields` keeps the tile look for the
  pivot panel. The pivot dropdown moved out of the tools row into the Pivot group.
- `editor.setNotice` owns the transient half of the status line: `error || notice ||
  status`, ten seconds, cleared by the next insertion and by `destroy`. Parse errors are
  still sticky, because they describe the path rather than something that just happened.
- Deleting a camera clears selection (`selected = -1`) and retains the playhead and
  overview pivot frame. Camera controls stay hidden until a camera is selected again.
  The held overview frame is released by explicit selection, timeline scrubbing, loading
  a path, insertion or Reset view. The rendered shot can change when its defining key is removed.

### Preview cache

After a run the node writes downscaled samples to the
`camera_path` subfolder of ComfyUI's temp directory — `preview.SUBFOLDER`, kept out of the
temp root because people read that folder for their own outputs. The file references in the
payload already carried `subfolder`, and `camera-path.js` forwards it to `/view`, so the
frontend needed no change.

`sample_frames` takes **every `PREVIEW_STRIDE`-th (5th) distinct source frame**, so the
count follows the clip instead of a constant: near enough five a second at 24 or 30 fps
without the node reading `fps`, which it must not. `PREVIEW_FLOOR` (10) keeps a short clip
worth scrubbing, `PREVIEW_SAMPLES` (120) is the ceiling, and the last distinct frame always
joins the set so the end of the timeline previews what it will be rendered from. A source
with fewer distinct frames than the floor is cached whole, which is why a still image has
always been exact. A clip past the ceiling — over 20 s at 30 fps — goes back to being
coarser than the render, and that is the one case where the preview understates the
frame-to-frame jitter of MoGe's per-frame reconstructions.

`createPreview` builds every sample's cloud up front: roughly 8 MB each in the tab, so
about 1 GB at the ceiling. The maintainer measured 60 samples as costing nothing
noticeable. Building each cloud on first visit was discussed and deliberately deferred; it
is the move to make if a long clip ever makes the editor sluggish.

Each sample is an RGB PNG plus a depth PNG with 16-bit depth packed big-endian into R and G, and
`B = 255` marking invalid, `B = 127` marking a valid but pruned point, and `B = 0` kept.
The metadata (normalised `fx/fy/cx/cy`, `pivot_z`, `z_low/z_high`,
`splat`, sample filenames) rides along in the UI payload. `js/preview.js` decodes it back
into point clouds so dragging the path reprojects live without re-running MoGe.

`preview_quality` selects Low (384), Medium (512, default), or High (768) long side,
never upscaling the source. All points at the selected quality are drawn; there is no separate 90k-point
stride limit. `renderScene` uses circular, depth-tested splats whose radius follows view
scale relative to the cache focal length, capped at 3 CSS pixels. The floor keeps its
single-pixel points. Neither change affects output resolution or video splatting.

`geometry.prune_edges` inspects depth at a 512-long-side scale: 3x3 relative depth spread
over 30%, or an invalid neighbour, rejects the point; the frame border does not. Bilinear
resizing of the keep mask back to source size requires all contributing neighbours to
survive. Pruning defaults ON and is applied after the anchor lens/unit are chosen, so
toggling it cannot move cameras. The same function supplies the render and cached validity
mask, before preview downsampling. JS consumes that mask directly rather than running a
second, resolution-dependent pruning pass. The cache is always unpruned at the maximum
level (768), independent of selected quality/pruning. Metadata includes the `levels` mapping
and records the last run's `prune_depth_edges` and `quality`.

`loadPreview` retains decoded RGB, depth, and keep flags; `createPreview` builds only the
selected variant, with box-averaged colour and nearest-sampled depth/masks. The host's
`readQuality` / `readPrune` accessors and widget callbacks trigger `editor.sync`, which
rebuilds only if those settings changed, not during dragging. Both panes update without
network requests or another run. A load finishing later uses the current widget values.
Old caches without `levels` show a one-time rerun message rather than pretending they can
restore discarded points. Output video changes still require execution.

## Code Style

### Python

- Module-level docstring explaining what the file does and, where relevant, the data format
  it reads or writes.
- Docstrings on all classes and public functions.
- Type hints where practical. Target is Python 3.10+, so `X | None` and `list[int]` are fine.
- `from __future__ import annotations` is not used — keep it simple.
- Imports: standard library, then third-party, then ComfyUI, then local.
- Use `@classmethod` for V3 node methods (`execute`, `define_schema`).

### JavaScript

- JSDoc comments on all functions with `@param` and `@returns`.
- Section headers use `// ── Section Name ──────────` (single-line box-drawing chars).
- `const` by default, `let` only when reassignment is needed, never `var`.
- Arrow functions for callbacks and short lambdas.
- Defensive checks: `node.widgets?.find(...)`, `message?.camera_path?.[0]`.

## Key Gotchas

Things that caused bugs or required non-obvious solutions:

### Splat depth bias
With a plain z-buffer, a fronto-parallel surface makes every point in a splat window tie on
depth, and the last write wins — the whole image comes out shifted by one splat offset.
`render.splat_bias()` multiplies depth by `1 + 1e-4 * (dy² + dx²)` so a point always outranks
its own skirt. `js/geometry.js` repeats the same bias with the same constant. Without it,
`test_default_pose_reproduces_the_source` fails.

### Pixel-centre convention
MoGe unprojects at pixel centres (`(i + 0.5) / W`) with `cx = cy = 0.5` normalised. So the
renderer projects to a continuous `u` and takes `floor(u)`, not `round(u)`. Getting this
wrong shifts everything by half a pixel and breaks the identity-pose test.

### Masked geometry is `inf`, not NaN
`Run MoGe Inference` with `apply_mask` on writes `inf` into `points`/`depth` for sky and
invalid pixels. Filter with `torch.isfinite(...).all(-1) & (z > EPS)` and the separate `mask`
tensor. Anything that computes percentiles or min/max must exclude them first.

### MOGE_GEOMETRY resolution can differ from the source
`points`/`mask` come back at the resolution of the image that was fed to MoGe, which need
not be the `source` wired into this node. `Geometry` resamples with nearest-neighbour.
Normalised intrinsics are resolution-independent, so they need no rescaling.

### Float32 vs float64 at pixel edges
The JS preview projects in float64, torch in float32. A point sitting exactly on a pixel edge
can round either way, so exact pixel parity is not achievable. `test_parity.py` allows up to
0.5% differing pixels for that reason — interpolation and the camera matrices, which are not
subject to this, are compared at 1e-12.

### Tab switching and subgraph navigation destroy node instances
All `LGraphNode` instances are rebuilt when the user switches workflow tabs or enters a
subgraph, so anything stored on the node (like `node.cameraPathEditor`) is lost. The last UI
payload lives in a module-level `Map` in `camera-path.js`, keyed by node id, and is replayed
in `onConfigure` and `afterConfigureGraph`.

### `node.id` is a string
Frontend 1.46 branded it (`NodeId = string & {__brand}`). Always key maps with
`String(node.id)`; never compare against a `Number(...)`.

### `setDirtyCanvas()` is a no-op under Nodes 2.0
It still matters for the LiteGraph canvas, so the calls stay, but never rely on it to make
something appear in the Vue renderer.

### Screen pixels are not layout pixels
`getBoundingClientRect()` reports post-transform screen pixels; `clientWidth`/`clientHeight`
report untransformed layout pixels. ComfyUI scales the whole graph, so the two disagree at
any zoom but 100%. The scene projector works in layout pixels, so pointer coordinates must
be converted (`editor.pointerInScene`) before they are compared against anything drawn — the
gizmo was ungrabbable at any zoom until this was fixed. The timeline was immune only because
`trackFrame` divides by `box.width` on both sides, so the ratio cancels. `editor_smoke.mjs`
runs the whole suite at 50% zoom with an offset origin to keep this from coming back.

### A DOM widget that fills its node needs three different heights
The layout never hands a DOM widget the node's spare height, so the editor has to claim it:
`claim() = node.size[1] - chromeHeight(node)`. Three call sites want a height and they must
not all get the same one, which took three attempts to get right:

| Lever | Must return | If it returns the claim instead |
| --- | --- | --- |
| `widget.computeSize` | the live claim | a fixed floor pins the editor and reopens the gap |
| `options.getMinHeight` | `MIN_EDITOR_HEIGHT` | the layout minimum follows the node up |
| `node.computeSize` | the sum **less** the claim's excess | the node ratchets — every height it reaches becomes one it cannot leave |

That last one is the subtle one: LiteGraph sums `widget.computeSize()` to derive the node's
minimum, so a claim equal to the current height makes the minimum equal the current height.

`chromeHeight` is an empirical over-estimate on purpose. Under-estimate it and the widget
asks for more than the node has, the node grows to fit, and the next pass asks for more
again. Its row constants are tuned against the rendered node, not LiteGraph's nominal ones.

### The timeline ruler is in frames, not seconds

`editor.timelineTicks` labels frame numbers on the smallest step of 1, 2, 5, 10, 20, 50, …
whose labels clear 40px, and ticks every frame once frames are 6px apart. The quarter,
half and three-quarter points turn the nearest already-drawn tick gold; they never add one.
Labels are centred on their tick. Frames, because
the play button's readout already converts to seconds; no snapping, by choice. The ruler
fits inside the track's existing 26px and is rebuilt only when the frame count or the
track width changes.

### Timeline markers are rebuilt on every redraw
`refresh()` replaces the `.key` elements, so a marker being dragged is detached mid-drag.
This works in a browser only because `track.setPointerCapture()` reroutes the pointer events
to the track. jsdom does not implement pointer capture, which is why `editor_smoke.mjs`
dispatches `pointermove` at the track rather than at the marker.

### ComfyUI loader fork
`NODE_CLASS_MAPPINGS` and `comfy_entrypoint` are mutually exclusive in ComfyUI's node loading
code. If `NODE_CLASS_MAPPINGS` exists — even as an empty dict — the V1 path fires and
`comfy_entrypoint()` is never called.

## Adding New Features

### New node

1. Create `nodes/my_node.py` using the V3 pattern (`camera_path_video.py` is the reference).
2. Import it in `nodes/__init__.py` and add it to `ALL_NODES`.
3. Prefix the `node_id` with `CameraPath_`; add `search_aliases` for discoverability.
4. Put any real logic in `camera_path/` so it is testable without ComfyUI.
5. If it needs client-side JS, extend `js/camera-path.js` or add a sibling file in `js/`.

The spec anticipates preset/path-generator nodes that emit a `camera_path` STRING. Those
should reuse `camera_path/trajectory.py` for the format and emit `trajectory.dumps()`.

### Changing the camera math or the keyframe format

Any change to `camera_path/render.py` or `camera_path/trajectory.py` needs the mirrored
change in `js/geometry.js` or `js/interpolate.js`. `tests/test_parity.py` will fail loudly
if they drift. Run it before assuming a change is done.

A new camera axis touches: `trajectory.AXES`/`DEFAULTS`, `interpolate.AXES`/`DEFAULTS`,
`render.orbit_matrix` or `render.aim`, `geometry.orbitCamera` or `geometry.aim`, `FIELDS` in
`js/editor.js` **and the `stacks` table that puts it in a group** — an axis missing from
that table has no row at all — and a pose in `tests/test_parity.py` that exercises it. A new pivot axis is
the same list with `PIVOT_AXES`/`PIVOT_DEFAULTS` and `PIVOT_FIELDS`.

## Testing

```
python -m unittest discover -s tests -t .
```

Discovery must be pointed at `tests/`; a bare `unittest discover` tries to import the
`nodes/` package as a test module and fails without ComfyUI on the path.

| File | Covers | Needs |
| --- | --- | --- |
| `test_trajectory.py` | Keyframe parsing, validation, PCHIP behaviour | — |
| `test_render.py` | Camera math, pivot, focal fitting, the splat renderer | — |
| `test_node.py` | V3 entry point, schema, a full run, source-hold rule, preview cache | ComfyUI (see below) |
| `test_parity.py` | Python vs JavaScript: interpolation, orbit matrices, reprojected pixels | `node` |
| `test_editor.py` | The editor driven end to end in jsdom (`editor_smoke.mjs`), at 50% graph zoom | `node` + `npm install jsdom` |

`test_node.py` imports the real `comfy_api.latest`, so it needs a ComfyUI checkout. It is
found automatically when this repo sits in `custom_nodes/`; otherwise set `COMFYUI_PATH`.
Tests skip themselves when their tooling is missing — check the skip count before believing
a green run.

`tests/context.py` owns all the import plumbing: `camera_path` is loaded standalone, and
`load_nodes()` puts ComfyUI on `sys.path` and redirects `folder_paths.get_temp_directory()`
at a temp dir.

## Dependencies

| Package | Required | Notes |
| --- | --- | --- |
| `torch`, `numpy`, `Pillow` | Yes | Bundled with ComfyUI; nothing else is needed |
| `jsdom` (npm) | Dev only | Editor smoke test; not committed, not shipped |

The node depends on ComfyUI's **native** MoGe nodes (`comfy_extras/nodes_moge.py`):
`Load MoGe Model` → `Run MoGe Inference`. No third-party geometry packages.

## Reference

### MOGE_GEOMETRY

Produced by `Run MoGe Inference`, defined in
`ComfyUI/comfy_extras/nodes_moge.py`. A dict; every key except `image` is optional:

| Key | Shape | Notes |
| --- | --- | --- |
| `points` | `(B, H, W, 3)` | Camera-space XYZ, OpenCV axes. What this node uses. |
| `depth` | `(B, H, W)` | `points[..., 2]`. |
| `intrinsics` | `(B, 3, 3)` | Normalised: `fx` by width, `fy` by height, `cx = cy = 0.5`. Perspective only — panoramas have none. |
| `mask` | `(B, H, W)` | bool. |
| `normal` | `(B, H, W, 3)` | MoGe v2+ only. |
| `image` | `(B, H, W, 3)` | The input image, CPU, `[0, 1]`. Always present. |

With `force_projection=True` (the default) `points` is exactly the unprojection of `depth`
through `intrinsics`, which is why the preview can cache depth alone and rebuild the cloud.

### Local source

- ComfyUI: `D:\AITools\StabilityMatrixData\Packages\ComfyUI`
  - `comfy_extras/nodes_moge.py` — the MoGe nodes and the MOGE_GEOMETRY contract
  - `comfy/ldm/moge/` — model and geometry helpers (`geometry.py` has the unprojection)
  - `comfy_api/latest/_io.py` — the V3 schema; `Schema`, `io.NodeOutput`, `GET_SCHEMA()`
  - `nodes.py` (~line 2295) — the `NODE_CLASS_MAPPINGS` / `comfy_entrypoint` loader fork
  - `execution.py` (~line 566) — how a node's `ui` dict becomes the `executed` websocket message
- ComfyUI frontend: `D:\AITools\ComfyUI_frontend` — `src/scripts/domWidget.ts` is the
  `addDOMWidget` implementation and its options.
- Sibling project with the same conventions: `D:\AITools\ComfyUI-Enhancement-Utils`
  (`CLAUDE.md`, and `Comfyui-Nodes2-Migration-Resources.md` for Nodes 2.0 details).

### Prior art

The camera math and the cached-preview idea come from
`ComfyUI/custom_nodes/3d-Camera-control-H3-Minimax` (Camera H3, by bruxosdovfx), whose
`depth_warp.py` ports the orbit/look-at construction from
[ComfyUI-CrossViewWarp](https://github.com/cseti007/ComfyUI-CrossViewWarp) (Apache-2.0).
Only that math and the preview architecture were taken. Everything model-specific in that
package — H3 prompt generation, MiniMax conditioning, Meridian reference construction, the
480-class canvas ladder, grey-128 holes, fixed frame-count grids, depth ratio/inversion
controls — is deliberately absent and must stay that way.

### Links

- [ComfyUI V3 Migration Guide](https://docs.comfy.org/custom-nodes/v3_migration)
- [ComfyUI JS Extensions](https://docs.comfy.org/custom-nodes/js/javascript_overview)
- [MoGe](https://github.com/microsoft/MoGe)
