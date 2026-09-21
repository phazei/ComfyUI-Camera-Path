# Handoff

Working notes for whoever picks this up next. Read `AGENTS.md` first — especially the
**Working Agreement** at the top, which is not optional. This file only covers what is
left to do and the decisions already taken, so you do not have to relitigate them.

## Where things stand

The node works in real ComfyUI and has been exercised by the maintainer. Everything in
the working tree is **uncommitted**, and stays that way until he asks.

``
python -m unittest discover -s tests -t .
``

74 tests, including the editor smoke suite, pass. `test_editor.py` needs a local
`npm install jsdom` and `test_node.py` needs `COMFYUI_PATH` set unless the repo sits in
`custom_nodes/`; both skip themselves otherwise, so check the skip count before trusting
a green run.

Recently finished: the pointer/hit-test fixes, the resizable layout, the `keyframes` /
`camera_path` two-input split, the `lock` / `pan` / `tilt` / `roll` axes, and the
**pivot rework** — version 2 path format, multiple pivots with position and orbit frame,
per-keyframe pivot choice, and pivot-relative cameras with a shared distance unit.
All documented in `AGENTS.md`; read the Path
format and Camera model sections before touching either.

The pivot rework and subsequent pivot-relative correction were tested and approved
by the maintainer: reset cameras inherit the pivot frame and distance 1
means the same radius everywhere. Snap to auto + Reset key preserves source alignment;
use a second pivot for an offset destination. No match-source mode or frozen entities.
The keyframe delete button now lives beside the camera resets.

Pivot Heading is also implemented: a slider/numeric field that offsets every attached
camera's azimuth about the corrected up axis. Snap to auto clears it. The overview and
floor deliberately ignore heading; the pivot's forward tick shows it. Tested and approved.
Heading ranges from -180 to +180 degrees; both pivot pointers were shortened by half.

Also done since, **not yet seen in ComfyUI by the maintainer**: the always-on floor grid,
the placeholder figure and the exportable marker lattice behind the `markers` checkbox.
See "Scene furniture" below for what he is expected to tune. The scene view's pan
(shift/middle-drag), recentre (double-click) and zoom range have been used and approved.

## Round controls, dolly and the input pass — all tested and approved

The azimuth dial and the pan/tilt puck replaced those three sliders, after the maintainer
used Camera H3, whose orbit dial he liked but whose sizing wrecked the node layout.

| Control | Drives | Behaviour |
| --- | --- | --- |
| Orbit dial | `azimuth` | Drag around the ring. **Accumulates past 360°** within the existing ±720 range — 370° stays 370°. The value sits in the centre of the dial and is editable there; double-click it to zero. |
| Aim puck | `pan`, `tilt` | Drag a puck inside a circle: x maps to pan, y to tilt, both ±90. The circle maps to the full square so both limits are reachable together. **Recentre** zeroes pan and tilt only, leaving `roll` alone. |

Both are 68px, which is the constraint that matters: oversizing is what made H3's layout
unusable. Everything else stays a slider — `elevation` (clamped ±89, so a dial would imply
a wraparound that does not exist), `distance`, `dolly`, `lateral`, `height`, `roll`, the
lock checkbox, the pivot dropdown and the whole pivot panel. `js/editor.js` stays
renderer-agnostic: these are DOM elements, not canvas widgets. The `.wide` layout puts the
fields in three columns, so check both.

He called the controls good, with the numeric input inside the dial specifically liked. He
said the layout "could be laid out better" but had no better arrangement in mind, so do
not rearrange it speculatively — wait for a concrete request.

**Dolly** (tested and approved) translates along the final aimed forward axis, after
pan/tilt/roll, without re-aiming. Slider plus numeric entry, ±3 shared units, default 0.
It is a real path axis, mirrored in both renderers, and interpolates like the rest. He
noted that changing pan/tilt with dolly set is confusing to watch, which is expected: the
offset follows wherever the lens ends up pointing.

The **Reset aim** button was removed as redundant once Recentre existed; `roll` has numeric
entry and **Reset key** clears every camera axis.

`frame_count` now defaults to **120** and there is an **`fps`** input (default 24) that
drives only the editor's timeline clock and playback speed. The render is a plain image
batch with no rate, so `execute` never reads it — see the node section of `AGENTS.md`.
`warp_mask` was renamed **`video_mask`**; the meaning is unchanged. The **Copy JSON**
button is gone, since the `camera_path` output carries the same JSON.

Note `spec.txt` predates all of this and still says the node exposes no FPS. It is the
original brief, left as written; `AGENTS.md` and `README.md` are the current documents.

**Sizes are a first pass and not yet seen.** He said everything read too small, so the widget
font went 13px → 15px with the smaller labels up by 2px to match, the round controls 68px →
76px, the viewport hint to white, and the scene markers to H3-sized numbered discs (9px and
11px radius) with white numbers and overlap spreading. Expect a round of tuning. The parts
most likely to need it: the fixed label and input widths in the CSS, which now have less
slack, and `MIN_EDITOR_HEIGHT` (still 520) — the taller fixed rows leave the two canvases
less room at the smallest node size.

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
