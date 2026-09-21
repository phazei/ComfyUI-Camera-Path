# ComfyUI-Camera-Path

Creates a reference video following a camera path based on MoGe.

One node, **Camera Path Video**. Give it an image (or a batch of frames) plus the
matching geometry from ComfyUI's built-in `Run MoGe Inference`, draw a camera move
in the node's 3D editor, and it renders the scene from those virtual camera
positions. The result is a plain `IMAGE` batch, so it drops into any workflow that
takes a control or reference video.

## Install

Clone into `ComfyUI/custom_nodes/` and restart ComfyUI. There are no extra
dependencies; it uses the torch, numpy and Pillow that ComfyUI already ships.

MoGe geometry comes from the native nodes in `image/geometry estimation`:
`Load MoGe Model` -> `Run MoGe Inference`.

## Inputs

| input | type | notes |
| --- | --- | --- |
| `source` | `IMAGE` | One image or a batch of frames. Sets the output resolution. |
| `moge_geometry` | `MOGE_GEOMETRY` | From `Run MoGe Inference` on the same image or frames. |
| `frame_count` | `INT` | Number of output frames. Defaults to 120. |
| `fps` | `FLOAT` | Rate the editor's timeline and playback run at. Defaults to 24 and does not change what is rendered. |
| `markers` | `BOOLEAN` | Burn a lattice of small coloured spheres into the video. Off by default. |
| `prune_depth_edges` | `BOOLEAN` | Remove points crossing depth discontinuities. On by default; trades streaks for holes. Preview updates immediately; rerun to update the output video. |
| `preview_quality` | `COMBO` | Low (384), Medium (512, default), High (768): displayed preview long side, capped by source size. Updates immediately. Output resolution is unchanged. |
| `keyframes` | `STRING` | Keyframes as JSON. The editor writes it, and it is hidden from the node body — the `camera_path` output carries the same JSON. |
| `camera_path` | `STRING` | Optional, connection only. A path from another node. |

`camera_path` **seeds** the editor, it does not override it. If you have not authored
anything yet the editor adopts the connected path on the next run; otherwise the
button becomes **Reset to input** and the path is only loaded when you ask. Running
the workflow can never overwrite keyframes you have placed.

Frame `i` of the output uses source frame `i` and its geometry. Once the source
runs out, its last frame and last geometry frame are reused, so one still image
plus `frame_count = 120` is the same scene seen from 120 camera positions. The
input batch is never interpolated in time.

`markers` adds a regular grid of small spheres to the scene, hanging in the air
around the subject. They are real points in the same space as the geometry — the
subject hides the ones behind it, the near ones pass in front, and each keeps its
own colour through the move — so a downstream video model gets an unambiguous read
on the parallax. The editor shows them in both views while the box is ticked.

Higher preview quality retains more points in the path view, at the cost of slower CPU
redraws. Path-view points grow with zoom, capped at a 3 CSS-pixel radius to avoid chunky
blocks. This does not change the video renderer's splat size. Pruning is computed before
preview downsampling, so every quality level uses the same source-resolution validity mask.

Each run caches up to eight unpruned samples at High quality, plus their pruning masks.
Changing pruning or quality rebuilds the displayed cloud locally, without another run or
download. Low still reduces redraw work, but no longer reduces the cache size. After
upgrading from the older, pruned-only cache, run the node once to enable live comparisons.

## Outputs

| output | type | notes |
| --- | --- | --- |
| `camera_video` | `IMAGE` | `[frame_count, height, width, 3]`, matching the source resolution. |
| `camera_path` | `STRING` | The keyframes that were rendered; route it on, or into another node's `camera_path`. |
| `video_mask` | `MASK` | 1 wherever no point was reprojected, including holes left by depth-edge pruning. |

## Camera path format

A JSON object with the pivots the camera can orbit and the camera keyframes, placed
on output frames, not seconds:

```json
{
  "version": 2,
  "pivots": [
    { "id": "p1", "keys": [{ "frame": 0, "x": 0, "y": 0, "z": 1, "tilt": 0, "roll": 0 }] }
  ],
  "camera": [
    { "frame": 0,  "pivot": "p1", "azimuth": 0,  "elevation": 0, "distance": 1 },
    { "frame": 30, "pivot": "p1", "azimuth": 20, "elevation": 5, "distance": 1.1 },
    { "frame": 60, "pivot": "p1", "azimuth": 45, "elevation": 0, "distance": 1.2, "lateral": 0.1, "lock": 1 }
  ]
}
```

A bare array of camera keyframes is the older format and still loads.

### Pivots

A pivot is the point the camera circles, and the frame it circles it in. Its position
is in units of the pivot depth the node finds by itself, so `(0, 0, 1)` is the subject
in the middle of the frame and a path drops onto other footage without rescaling. Add
one per subject and pick which pivot each keyframe orbits; a keyframe that switches
pivot eases the camera across to the new one instead of jumping.

`tilt` and `roll` on a pivot straighten the orbit when the shot was pitched or rolled:
without them, circling a subject in a photo taken looking down comes out tilted.
Select the pivot and adjust until the scene stands upright in the viewport.

`heading` sets where camera azimuth zero starts, turning all attached cameras around
the pivot's corrected up axis. Positive heading turns the same way as positive
azimuth; each camera keeps its own azimuth offset. It does not rotate the overview
or change the floor's orientation. The pivot's forward tick shows the heading.
**Snap to auto** resets heading to zero along with the other pivot settings.

### Camera

* `azimuth` / `elevation` — degrees around the pivot. Positive azimuth swings
  the camera right, positive elevation raises it. The pivot stays centred until
  truck, boom or aim shifts the framing.
* `distance` — orbit radius in automatic-depth units. `1` is the same distance from
  every pivot, regardless of where that pivot sits.
* `lateral` / `height` — truck and boom. They slide the camera sideways and up in
  units of the pivot depth **without** re-aiming it, so the subject travels across
  the frame instead of staying centred.
* `lock` — `1` keeps the camera pointed at the pivot while trucking and booming,
  `0` lets it drift out of frame. It is a number rather than a flag so that a
  keyframe turning it on eases into it instead of snapping.
* `pan` / `tilt` / `roll` — degrees, turning the camera about its own axes on top of
  all of the above. Positive aims right, aims up and rolls clockwise.

All axes are optional and default to a camera one unit behind its pivot, inheriting
the pivot's tilt and roll. **Snap to auto** on the pivot plus **Reset key** on the
camera reproduces the input camera alignment (with pruning off, the input image). Moving or straightening the pivot moves
its cameras too: keep the starting pivot at auto and add another for an offset
destination if the first frame should stay unchanged. Between keyframes each axis is
interpolated with a monotone cubic (PCHIP) curve: keyframes are hit exactly and
nothing overshoots. Only the camera is interpolated; source frames and geometry
never are.

The automatic pivot depth is the lower quartile of the depth across the middle of the
frame, which lands on the subject rather than the backdrop, and the lens comes from
MoGe's intrinsics.

## Editor

The node carries a 3D editor:

* a scene viewport with the orbit sphere, the camera path, numbered keyframes, the
  pivots, a floor grid and a frustum showing where the lens actually points — drag
  a keyframe or the camera to orbit, ctrl+drag to truck and boom, drag a pivot to
  move it, drag the background to turn the view, shift+drag or middle-drag to pan,
  double-click the background to recentre, wheel to zoom, alt+wheel for distance.
  The view turns about whichever pivot is selected or in use, so a subject off to
  one side stays put while you look around it
* a timeline with the keyframes on it, scrubbing and playback at the `fps` input's rate
* a compact azimuth dial and pan/tilt puck, plus sliders for the remaining camera
  axes, a lock-on-target checkbox and a pivot dropdown; selecting a pivot shows
  its position, tilt/roll and heading sliders instead
* a camera view that reprojects the real scene

Drag the node taller and the two views grow with it; make it wide and they sit side
by side. **Reset key** resets the selected camera relative to its pivot,
**Snap to auto** puts a pivot back on the subject the
node found, and **Reset path** clears everything after confirming.

Drag clockwise around the azimuth dial to increase the orbit angle. It accumulates
across full turns within the existing -720 to +720 degree range. Its centre value
is editable; double-click it to zero azimuth. Drag the aim puck right/up for
positive pan/tilt, or edit the numbers beside it. **Recentre** zeros pan/tilt only,
leaving camera roll unchanged. Both circles are 68px across.

**Dolly** moves straight along the camera's final viewing direction, after pan/tilt,
without changing its orientation. Positive moves forward; negative moves backward.
The slider spans -3 to +3 in the shared distance unit and defaults to zero. Unlike
Distance, which changes the orbit radius, Dolly follows where the lens is pointing.
Animate only Dolly for a straight push-in or pull-back; changing aim at the same time
changes the direction of that offset too. This is camera movement, not lens zoom.

Before the node has run, the editor shows a placeholder — a square frame with a
figure standing in it — so a move can be blocked out with nothing wired up. After
the node has run once it keeps a downscaled copy of the point cloud in ComfyUI's
temp folder. The editor loads it, shows it in both views and reprojects it live as
you drag the path, so previewing a different move costs nothing and does not
re-run MoGe. Changing the source or the geometry needs another run.

## Notes

* Rendering is a z-buffered point splat on whichever device ComfyUI is using.
  Around 6 ms per 720p frame on a GPU, around 140 ms on CPU.
* Regions the source camera never saw come back black and flagged in `video_mask`.
  Past roughly 40 degrees of orbit most of a single still is holes; feed the mask
  to an inpainting or video model if you need them filled.
* `js/interpolate.js` and `js/geometry.js` re-implement `camera_path/trajectory.py`
  and `camera_path/render.py` so the preview matches the render.
  `tests/test_parity.py` runs both and compares them.

## Tests

```
python -m unittest discover -s tests -t .
```

The suite covers the keyframe format, the camera math, the renderer, a full node run
and Python/JavaScript parity. Some parts skip themselves when their tools are missing:

| Test | Needs |
| --- | --- |
| `test_node.py` | A ComfyUI checkout — automatic when installed in `custom_nodes/`, otherwise set `COMFYUI_PATH` |
| `test_parity.py` | `node` on the path |
| `test_editor.py` | `node` plus a local `npm install jsdom` |

## Credits

The orbit and look-at construction is adapted from
[ComfyUI-CrossViewWarp](https://github.com/cseti007/ComfyUI-CrossViewWarp)
(Apache-2.0), by way of the Camera H3 depth warp, which also inspired the cached
point-cloud preview.
