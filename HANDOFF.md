# Handoff

Working notes for whoever picks this up next. Read `AGENTS.md` first — especially the
**Working Agreement** at the top, which is not optional. This file only covers what is
left to do and the decisions already taken, so you do not have to relitigate them.

## Where things stand

The node works in real ComfyUI and has been exercised by the maintainer. Everything in
the working tree is **uncommitted** unless he has committed it himself, and it stays that
way until he asks.

``
python -m unittest discover -s tests -t .
``

86 tests, including the editor smoke suite, pass. `test_editor.py` needs a local
`npm install jsdom` and `test_node.py` needs `COMFYUI_PATH` set unless the repo sits in
`custom_nodes/`; both skip themselves otherwise, so check the skip count before trusting
a green run.

Recently finished: the pointer/hit-test fixes, the resizable layout, the `keyframes` /
`camera_path` two-input split, the `lock` / `pan` / `tilt` / `roll` axes, and the
**pivot rework** — version 2 path format, multiple pivots with position and orbit frame,
per-keyframe pivot choice, and pivot-relative cameras with a shared distance unit.
All documented in `AGENTS.md`; read the Path format and Camera model sections before
touching either.

The pivot rework and subsequent pivot-relative correction were tested and approved
by the maintainer: reset cameras inherit the pivot frame and distance 1
means the same radius everywhere. Snap to auto + Reset key preserves source alignment;
use a second pivot for an offset destination. No match-source mode or frozen entities.
The keyframe delete button now lives beside the camera resets.

Pivot Heading is also implemented: a slider/numeric field that offsets every attached
camera's azimuth about the corrected up axis. Snap to auto clears it. The overview and
floor deliberately ignore heading; the pivot's forward tick shows it. Tested and approved.
Heading ranges from -180 to +180 degrees; both pivot pointers were shortened by half.

Also done, **not yet seen in ComfyUI by the maintainer**: the always-on floor grid,
the placeholder figure and the exportable marker lattice behind the `markers` checkbox.
See "Scene furniture" below. The scene view's pan (shift/middle-drag), recentre
(double-click) and zoom range have been used and approved.

## Controls, sizes and markers — tested and approved

### New: two-pivot capture and selection fixes (awaiting visual testing)

- Camera keys now carry explicit `pivot_target` and `pivot_blend` (0..1). The camera
  panel exposes a destination dropdown and percentage slider. Missing targets are
  inferred from the next distinct pivot; inserted keys capture the evaluated pair
  and ratio while retaining the preceding primary pivot. No multi-pivot-weight UI.
- Compatible handoffs share a scalar PCHIP blend across their keys; this avoids a
  forced stop at every inserted camera. All pivot components follow that same ratio.
  Incompatible endpoint blends use smoothstep between resolved pivots. Both runtimes
  match, including pivot tilt, roll, heading and animated tracks.
- Adding a key verifies the effective pivot can be represented before writing. A span
  that needs three pivots (blend A/B into blend B/C — which is what he hit after deleting
  the middle camera of three) is **fitted** rather than refused: attach to the previous
  key's blend target and solve the orbit and aim from the camera on show
  (`geometry.solvePose`). He asked for best effort over a block, since working around
  the block means moving cameras, which changes the path anyway. Measured exact to
  ~1e-15 on the test fixture; `approximate` in the notice means an axis limit clamped.
  The fitted key reads oddly — large pan/roll, zero truck/boom/dolly — by design.
- The status line now has a transient half (`setNotice`, 10s). The old insertion error
  stayed up forever, which he reported. Keep parse errors sticky.
- Existing multi-pivot motion can change with this interpolation model. Insertion
  preserves the shot at the sampled frame within saved precision, not the surrounding
  curve. Camera axes still use automatic PCHIP slopes. Visual smoothness needs feedback.
- Deletion clears selection, holds time and the overview pivot frame, and hides the
  camera controls until a camera is selected. Removing a defining key can still change
  the rendered shot at the held time. Clicking the live ring between keys no longer
  seeks to or edits an unrelated selected camera; at the selected key it remains a handle.
- Reset key clears blend to 0%; changing primary pivot also clears blend and still
  moves the shot. This is not a general preserve-world-pose pivot reassignment tool.
- Tests cover repeated insertion with oriented pivots/aim/lock/dolly, UI blend editing,
  mixed-span rejection, deletion without seek, live-ring clicks, persistence, validation,
  blend smoothness and Python/JS pose and camera-matrix parity. No changes to editor sizing.

The azimuth dial and the pan/tilt puck replaced those three sliders, after the maintainer
used Camera H3, whose orbit dial he liked but whose sizing wrecked the node layout.

| Control | Drives | Behaviour |
| --- | --- | --- |
| Orbit dial | `azimuth` | Drag around the ring. **Accumulates past 360°** within the existing ±720 range — 370° stays 370°. The value sits in the centre of the dial and is editable there; double-click it to zero. |
| Aim puck | `pan`, `tilt` | Drag a puck inside a circle: x maps to pan, y to tilt, both ±90. The circle maps to the full square so both limits are reachable together. **Recentre** zeroes pan and tilt only, leaving `roll` alone. |

Both are 76px, and **size is the constraint that matters**: oversizing is what made H3's
layout unusable. Everything else stays a slider — `elevation` (clamped ±89, so a dial would
imply a wraparound that does not exist), `distance`, `dolly`, `lateral`, `height`, `roll`,
the lock checkbox, the pivot dropdown and the whole pivot panel. `js/editor.js` stays
renderer-agnostic: these are DOM elements, not canvas widgets. The `.wide` layout puts the
fields in three columns, so check both.

He called the controls good, with the numeric input inside the dial specifically liked. He
said the layout "could be laid out better" but had no better arrangement in mind, so do
not rearrange it speculatively — wait for a concrete request.

**Dolly** (approved) translates along the final aimed forward axis, after pan/tilt/roll,
without re-aiming. Slider plus numeric entry, ±3 shared units, default 0. It is a real path
axis, mirrored in both renderers, and interpolates like the rest. He noted that changing
pan/tilt with dolly set is confusing to watch, which is expected: the offset follows
wherever the lens ends up pointing.

The **Reset aim** button was removed as redundant once Recentre existed; `roll` has numeric
entry and **Reset key** clears every camera axis.

**The size pass is approved** ("the look of everything else is good") and the editor's own
dimensions are explicitly fine — `MIN_EDITOR_HEIGHT` (520) and `chromeHeight` were left
alone on purpose and **need no attention**. Widget font 13px → 15px, smaller labels +2px,
round controls 68px → 76px, viewport hint to white, scene markers to numbered discs
(9px, 11px selected) with white numbers.

Overlapping markers are spread apart by `editor.spreadMarkers` with a leader line back to
the point each one stands for; see the Editor scene view section of `AGENTS.md` for the
rules it follows and why. The camera frustum is drawn **before** the markers — over a disc
its four converging lines cross out the number.

`frame_count` defaults to **120** and there is an **`fps`** input (default 24) that drives
only the editor's timeline clock and playback speed. The render is a plain image batch with
no rate, so `execute` never reads it. `warp_mask` was renamed **`video_mask`**; the meaning
is unchanged. The **Copy JSON** button is gone, since the `camera_path` output carries the
same JSON.

Note `spec.txt` predates most of this and still says the node exposes no FPS. It is the
original brief, left as written; `AGENTS.md` and `README.md` are the current documents.

---

## Implemented: pruning, preview quality, and the dust

All three changes are implemented and tested, awaiting visual comparison in ComfyUI.
Restart ComfyUI, refresh the frontend, and run the node once to regenerate the cache.
After that, both new inputs update both preview panes immediately without another run
or fetch. This was the maintainer's follow-up request, to make comparisons easy.
Only changing the output video still needs another execution.

### 1. Depth-edge pruning, **default ON**

Drop points whose local depth neighbourhood straddles a discontinuity — the "flying pixels"
that interpolate across a silhouette, belong to neither surface, and smear into long
streaks as soon as the camera moves off-axis. The reference implementation is
`meridian_keep` in H3's `depth_warp.py` (itself from Meridian's training code): resample
depth to a fixed 512 long side, take the 3×3 min/max, and drop any window whose relative
spread exceeds 30%. A masked-invalid neighbour counts as a discontinuity; the frame border
does not.

- It **trades smear for holes**. The pruned pixels become honest holes, flagged in
  `video_mask`, instead of dishonest streaks. That is the point.
- It is a new boolean input, default ON. Saved-workflow compatibility is not a concern.
- Implementation: `geometry.prune_edges` supplies both render and preview validity masks
  at source resolution. The cache already contains the pruned mask, so JS consumes it
  directly, without duplicated pruning maths or a second pass at preview resolution.
  This supersedes the earlier plan for a JS mirror. The cache now retains unpruned depth
  with separate keep flags (B=0 kept, B=127 pruned, B=255 truly invalid); switching pruning
  off restores points without ever restoring invalid geometry. Anchor lens and unit are
  computed before pruning.

### 2. Preview quality, named levels

`preview_quality` is a named dropdown: Low (384), Medium (512, default), High (768).
`PREVIEW_LEVELS` in `camera_path/preview.py` maps them to displayed long-side limits; the
source is never upscaled. The backend always caches High, even when Low is selected.
`preview.write` includes `levels` and cache dimensions in metadata. `loadPreview` retains
raw decoded samples; `createPreview` builds only the chosen quality/pruning variant.
The host reads both widgets and routes their callbacks to `editor.sync`. Only a setting
change rebuilds the clouds; camera dragging does not. Settings changed during an async
cache load are respected when it completes. Old caches lacking `levels` prompt a rerun.

Performance details:

- The old ~90k-point scene-view limit is removed: all points at the chosen level are drawn.
- Our preview reprojects **in JavaScript on the CPU, single-threaded, on every redraw**,
  unlike CrossViewWarp's server-rendered one. Cost is linear in point count, so 384 → 768
  is 4x the points per drag frame. All levels now share the same High-sized PNG cache,
  with pruning flags packed into the existing depth PNG rather than another file.
  The level trades drag responsiveness, not video resolution or cache size. Only raw
  samples plus the active variant are retained, not all six quality/pruning variants.

### 3. Zoom-aware scene point sizes

`geometry.renderScene` now accepts a circular splat radius and depth-tests every covered
pixel, with a small depth bias favouring each point's centre. `editor.drawScene` scales
the radius with view scale / cache focal length, at least 1 device pixel and at most
3 CSS pixels (rounded to device pixels). All points are drawn. The floor retains radius 0;
the camera-preview/video renderer is unchanged. The maintainer's target is between the
old chunky particles and the former single-pixel dust; visual tuning is still pending.

Note this is separate from the preview resolution: more points will not fix a 1px splat at
high zoom, and a bigger splat will not add detail. Both are needed, which is why he asked
for both.

---

## Resolution: what is capped and what is not

This came up because decreasing MoGe's `resolution_level` from 7 to 1 changed little
visibly. MoGe quality can change depth estimates, but not the number of cached points:

- **The render is not capped.** The output is allocated at the source image's resolution
  (`nodes/camera_path_video.py:148`).
- **The geometry is resampled to the source resolution**, nearest-neighbour
  (`camera_path/geometry.py:58-62`), so the cloud is always **exactly one point per source
  pixel**. MoGe below source is nearest-upsampled and comes out blocky; MoGe above source
  is subsampled and the extra detail is discarded. Raising `resolution_level` past roughly
  the source resolution is wasted work.
- **The editor preview is capped** by the selected quality level over 8 sampled frames.
  It was previously fixed at 384.
- The maintainer explicitly **does not want a higher output resolution** — the source is
  already resized to the intended video resolution. Only the on-screen preview is at issue.

---

## Scene furniture — done, awaiting the maintainer's eye on the tuning

All three pieces landed together; the vocabulary is kept straight because "grid"
originally meant two different things in the same conversation.

| Piece | Where | Exported |
| --- | --- | --- |
| Floor grid | `js/furniture.js` `floorGrid` | no |
| Placeholder frame + figure | `js/furniture.js` `placeholderPreview` | no |
| Marker lattice | `render.marker_lattice` / `geometry.markerLattice` | behind `markers` |

All three are point clouds splatted through the shared z-buffer, never overlays; that is
what buys occlusion and perspective and it must stay that way. `AGENTS.md` has the
details.

### The values, and where they live

He said to pick values and adjust once he could see them; the lattice has since had one
round of that. Where each lives:

- **Lattice** (`LATTICE_*` in `render.py`, mirrored in `geometry.js` — change both or
  `test_lattice_matches` fails): spacing **1.0**, x ±2, y ±1, z 0.5..3.5, radius 0.015,
  24 points per sphere, 60 spheres. The first pass was much denser (0.25 spacing, ±1.5 by
  ±1.0); the maintainer thinned it to these values, so treat them as his picks rather than
  as defaults waiting to be tuned.
- **Lattice colour**: position → RGB (x red, y green, z blue) plus a light Lambert shade.
  Chosen over hue-by-depth because each marker keeps one colour through the move, which
  is what a video model can track. Easy to swap in `marker_lattice` if he prefers depth.
- **Floor**: ±2 units at 0.25 spacing, in the view pivot's frame, through the bottom of
  the footprint. Fades towards the background with distance.
- **Placeholder figure**: 1.6× the half-height tall, feet on the floor, ~2,400 points.
  Proportions are in `placeholderFigure`'s parts table.

---

## Prior art: what was already researched, and the conclusions

Both neighbouring packages have been read in full. **Do not re-derive this.**

`custom_nodes/ComfyUI-CrossViewWarp` (Apache-2.0, cseti007) is the origin of the camera
math both it and Camera H3 use. Conclusions:

- **Its renderer is worse than ours; do not borrow it.** No z-buffer — depth is resolved by
  sorting far→near and overwriting, but the splat offsets are the *outer* loops and the
  points the inner one (`crossview_warp_node.py:66-68`, `:336-341`). The last pass
  therefore wins everywhere, translating the output ~2px down-right and letting background
  eat foreground silhouettes. It is frozen deliberately because their LoRA was trained on
  output containing the artefact.
- It has **no mask output**; holes are magenta `(255,0,255)` for the LoRA to key on. H3's
  Meridian path uses grey 128 for the same reason. Both are single-model conventions. Our
  black + `video_mask` is the better contract and should stay.
- Its `depth_ratio`, `smooth_depth`, `invert_depth` and clip-global depth normalisation are
  all **relative-depth machinery**, inert when MoGe metric geometry is connected. Not
  applicable to us.
- Its Catmull-Rom interpolation overshoots and needs post-hoc clamps on elevation and
  distance. Our PCHIP is monotone and needs none. Keep ours.
- Already checked against our code and **already handled**: the `widget.serialize = false`
  DOM-widget gotcha (`js/camera-path.js:163`), the `look_at` pole degeneracy guard
  (`camera_path/render.py:59-62`), angle unwrapping across ±180 (our azimuth accumulates to
  ±720 and is never wrapped, so the seam does not exist), and holding rather than
  extrapolating outside the keyframe span.
- Its preview is a **server round-trip** — the browser POSTs a pose and gets a JPEG from the
  same Python that renders the output, so the two cannot drift. We took the other branch: a
  JS mirror kept honest by `test_parity.py`. Both are defensible; we are not switching.

Ideas from it that were raised and **not** adopted, with reasons:

- `keep_source_aim` — decouples the look-at target from the orbit centre. Our camera always
  looks at its pivot, so dragging a pivot off the optical axis re-centres the subject even
  at zero orbit; the auto pivot sits at `(0,0,1)` where the two aims coincide, which is why
  "Snap to auto + Reset key reproduces the source" still holds. The maintainer was shown
  this and did not ask for it. `pan` recovers the framing by hand.
- `vertical_shift` — a target-side principal-point offset, i.e. a shift lens: reframes
  vertically with no camera move, so parallax is unchanged and verticals stay parallel (no
  keystone, unlike `tilt`). Explained, not requested.
- `LOAD3D_CAMERA` input — an exact pose from ComfyUI's Load 3D viewport, bypassing the orbit
  model. Noted, not requested.

Camera H3's four extra options were also researched. Three of them (`Freeze Frame`,
`Motion Frame`, `Action Frame`) are one `frame_mode` dropdown choosing **which source frame
feeds each output frame**; `Action Frame` is byte-identical to `Freeze Frame` in the video
and differs only in generated prompt text. The fourth, `Depth Warp`, is an on/off for the
entire reprojection pipeline — the thing our node always does. Everything else those modes
control is prompt authoring and H3/MiniMax routing, which is out of scope by project goal.
**We are permanently equivalent to Motion Frame**: output frame `i` uses source frame `i`,
holding the last once the source runs out. The only genuinely generic idea in the set is
their Advanced-only `warp_hold_at` / `warp_hold_frames`, which freeze the source mid-clip
for a bullet-time beat inside a moving shot. Mentioned, not requested.

---

## Known nits, deliberately left

- **Orbit drag is slightly loose at large `lateral`.** Measured ~1.5px of gizmo travel
  per 1px of pointer at `lateral = 0.8`. Inherent: the truck offset lives in the
  camera's rotating frame, so changing azimuth also swings the offset. Exact tracking
  needs an iterative solve. Ctrl+drag gives direct control of those axes, so it was left
  alone. Raised with the maintainer; not currently a problem in practice.
- **A pivot's track has one key in the editor.** The format allows many; the editor
  reads and writes `keys[0]` only (`pivotKey` in `editor.js`). A multi-key pivot loaded
  from outside interpolates correctly but only its first key is editable. This is the
  deliberate seam for the future moving pivot.
- **Pivot drag moves in the screen plane.** Depending on the view angle that changes z
  as well as x/y. Fine in practice, but it is why the smoke test's marker prediction
  has to account for all three.
- **`lock` defaults to 0**, preserving the original truck/boom behaviour where the
  subject drifts out of frame. Flipping the default to 1 is a one-line change in
  `trajectory.DEFAULTS` plus the JS mirror, if that turns out to be the better default
  once it has seen some use.
- **`chromeHeight` in `js/camera-path.js` is empirically tuned**, not derived. It was
  adjusted twice against the rendered node. If the node gains or loses slots or widgets,
  expect to retune it — and keep it an over-estimate, for the reason given in AGENTS.md.
- **Saved workflows break on input changes** (`widgets_values` shifts; the node has to be
  re-added). The maintainer has said this is **not a concern** — the node is new and
  nobody has workflows to protect yet. Do not raise it again; just change the inputs.
- **The render is not bit-reproducible.** Two identical runs can differ on a few pixels:
  where two points tie on the biased depth for one pixel, the second pass writes both and
  the last write wins in whatever order the backend scatters in (`PointCloud.render`,
  end of `render.py`). Ties are common on flat, equal-depth geometry — synthetic test
  planes especially. Found while adding the fps test, which is why that test compares
  frames loosely. Raised with the maintainer; **not fixed, and not authorised to be.**

## Open questions

1. Lattice colour scheme — position → RGB is in and the density has been tuned; the colour
   choice itself has not been commented on.
2. Whether a pan offset should survive selecting a different pivot. Today it does (the
   offset is relative to the view pivot, so it carries over); he was told and did not
   object, but has not used it yet.
3. Saved/preset paths. He has raised the idea of a manage flow or a preset list but has
   nothing specific in mind, so there is nothing to design yet. **Copy JSON was removed
   rather than kept as a placeholder for it.**
