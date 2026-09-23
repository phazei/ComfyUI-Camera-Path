"""Camera Path Video -- reprojects a source image or clip along an authored camera path.

Source RGB plus MoGe geometry makes a coloured point cloud; the node renders that
cloud from every pose on the camera path and returns the frames as an IMAGE batch.
The path itself is authored in the 3D editor that `js/editor.js` mounts on the node.
"""
import json
import logging

import torch
from typing_extensions import override

import comfy.model_management
import comfy.utils
import folder_paths
from comfy_api.latest import io

from ..camera_path import preview, render, trajectory
from ..camera_path.geometry import Geometry, prune_edges

logger = logging.getLogger("camerapath.nodes.camera_path_video")

MoGeGeometry = io.Custom("MOGE_GEOMETRY")

#: Splat radius in pixels. 1 gives a 3x3 window, which covers the gaps a one-point-per-pixel
#: cloud opens when the camera moves in, without smearing silhouettes.
SPLAT = 1

DEFAULT_PATH = trajectory.dumps(trajectory.parse_path([
    {"frame": 0},
    {"frame": 48, "azimuth": 20},
]))


class CameraPathVideo(io.ComfyNode):
    """Renders a camera move through MoGe geometry.

    Two inputs carry a path, and they are not interchangeable. ``keyframes`` is the
    hidden widget the editor writes to, and it is what actually renders. ``camera_path``
    is socket only: it is handed back to the editor untouched so the user can adopt it
    deliberately, and it never overrides the authored path at render time. Anything else
    would destroy the user's edits every time the workflow runs.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CameraPath_Video",
            display_name="Camera Path Video",
            category="image/video",
            search_aliases=["camera", "path", "orbit", "parallax", "moge", "reprojection", "point cloud"],
            description=(
                "Reproject a source image or clip through its MoGe geometry along a camera path "
                "authored in the node's 3D editor. Outputs the rendered frames, the path as JSON "
                "and a mask of the pixels the source camera never saw."
            ),
            # The editor is an interactive region fed by an intermediate output: this keeps the
            # cached point cloud coming back to the frontend after a page refresh.
            has_intermediate_output=True,
            inputs=[
                io.Image.Input(
                    "source",
                    tooltip="One image or a batch of frames. Supplies the colour of the point "
                            "cloud and the output resolution.",
                ),
                MoGeGeometry.Input(
                    "moge_geometry",
                    tooltip="Geometry from Run MoGe Inference for the same image or frames.",
                ),
                io.Int.Input(
                    "frame_count",
                    default=120, min=1, max=8192,
                    tooltip="Number of output frames.",
                ),
                io.Float.Input(
                    "fps",
                    default=24.0, min=0.1, max=240.0, step=0.1,
                    tooltip="Rate the editor's timeline and playback run at. The output is a "
                            "plain image batch, so this does not change what is rendered; set "
                            "the same rate on whichever node saves the video.",
                ),
                io.Boolean.Input(
                    "markers",
                    default=False,
                    tooltip="Burn a lattice of small coloured spheres into the video. They sit in "
                            "the scene with the geometry, so a downstream model can read the "
                            "parallax from them. The editor shows them while this is on.",
                ),
                io.Color.Input(
                    "background", default="#000000",
                    tooltip="Colour of the pixels no point reached -- the holes video_mask "
                            "marks. Match whatever your downstream model was trained on; "
                            "CrossViewWarp-style warp videos use magenta, #ff00ff.",
                ),
                io.Boolean.Input(
                    "prune_depth_edges", default=True,
                    tooltip="Remove depth-edge streaks, trading them for holes in video_mask. "
                            "The preview updates immediately; run again to update the video.",
                ),
                io.Combo.Input(
                    "preview_quality", options=list(preview.PREVIEW_LEVELS), default="Medium (512)",
                    tooltip="Editor preview detail only. Higher levels cost more while dragging. "
                            "Updates immediately from the cache; output resolution is unchanged.",
                ),
                # Written by the editor and hidden from the node body by js/camera-path.js.
                # It is still a real widget so the authored path is saved with the workflow.
                io.String.Input(
                    "keyframes",
                    default=DEFAULT_PATH, multiline=False,
                    tooltip="Camera keyframes as JSON. The editor writes this for you.",
                ),
                # Socket only, so it gets a connection dot instead of a box. Seeds the
                # editor rather than overriding it -- see the class docstring.
                io.String.Input(
                    "camera_path",
                    optional=True, force_input=True,
                    tooltip="Optional path from another node. Press Reset path in the editor "
                            "to load it; it never silently replaces what you have authored.",
                ),
            ],
            outputs=[
                io.Image.Output(
                    display_name="camera_video",
                    tooltip="The rendered camera move, at the source resolution.",
                ),
                io.String.Output(
                    display_name="camera_path",
                    tooltip="The camera path as JSON. Feed it back into camera_path to reuse or route it.",
                ),
                io.Mask.Output(
                    display_name="video_mask",
                    tooltip="1 wherever no point was reprojected, including depth-pruning holes.",
                ),
            ],
        )

    @classmethod
    def execute(cls, source, moge_geometry, frame_count, fps, markers, background, prune_depth_edges,
                preview_quality, keyframes, camera_path=None) -> io.NodeOutput:
        path = trajectory.parse_path(keyframes)
        fill = render.hex_color(background)
        # fps is the editor's timeline rate only: the output is a plain image batch and
        # carries no rate, so nothing here reads it.
        count = max(1, int(frame_count))
        source = source[..., :3].float().cpu()
        frames, height, width = int(source.shape[0]), int(source.shape[1]), int(source.shape[2])
        geometry = Geometry(moge_geometry, (width, height))

        # The anchor frame fixes the lens and the automatic pivot depth so they cannot
        # drift mid-clip. Every pivot on the path is placed in units of that depth.
        anchor_points, anchor_valid = geometry.frame(0)
        lens = geometry.lens(anchor_points, anchor_valid)
        unit = render.pivot_depth(anchor_points[..., 2], anchor_valid)
        del anchor_points, anchor_valid
        logger.info("%d frames at %dx%d, pivot depth %.3f, fx %.1f", count, width, height, unit, lens[0])

        # Output frame i uses source frame i, or the last one once the source runs out.
        sources = [min(index, frames - 1) for index in range(count)]
        poses = trajectory.poses(path, count)
        device = comfy.model_management.get_torch_device()
        # The lattice is fixed in the scene, so one copy is appended to every frame's cloud
        # and splats through the same z-buffer as the geometry.
        lattice = render.PointCloud.lattice(unit, device) if markers else None

        video = torch.empty((count, height, width, 3), dtype=torch.float32)
        holes = torch.empty((count, height, width), dtype=torch.float32)
        progress = comfy.utils.ProgressBar(count)
        cloud, cached = None, -1
        for index in range(count):
            comfy.model_management.throw_exception_if_processing_interrupted()
            if sources[index] != cached:
                cached, cloud = sources[index], None  # drop the old cloud before building the next
                points, valid = geometry.frame(cached)
                if prune_depth_edges:
                    valid = prune_edges(points[..., 2], valid)
                cloud = render.PointCloud.from_frame(points.to(device), valid.to(device),
                                                     source[cached].to(device))
                if lattice is not None:
                    cloud = cloud.joined(lattice)
            c2w = render.pose_matrix(poses[index], unit)
            rgb, hole = cloud.render(c2w, lens, (width, height), SPLAT, fill)
            video[index] = rgb.cpu()
            holes[index] = hole.float().cpu()
            progress.update_absolute(index + 1)
        del cloud

        editor = {
            "path": path,
            "frame_count": count,
            "markers": bool(markers),
            "input_path": cls._seed(camera_path),
            "preview": cls._preview(source, geometry, sources, lens, unit, prune_depth_edges, preview_quality),
        }
        return io.NodeOutput(video, trajectory.dumps(path), holes,
                             ui={"camera_path": [json.dumps(editor)]})

    @classmethod
    def _seed(cls, camera_path):
        """Normalise the connected camera_path so the editor can offer it.

        Returns the keyframe list, or None when nothing is connected or the upstream
        node sent something unusable. A bad seed must not fail the render, since it
        takes no part in it.
        """
        if not camera_path:
            return None
        try:
            return trajectory.parse_path(camera_path)
        except (ValueError, TypeError) as problem:
            logger.warning("ignoring the connected camera_path: %s", problem)
            return None

    @classmethod
    def _preview(cls, source, geometry, sources, lens, pivot, prune_depth_edges, preview_quality):
        """Cache the point cloud for the editor's 3D view.

        ``pivot`` is the automatic pivot depth; the editor scales pivot positions by it.
        Returns the preview metadata, or None. A failure here must not lose the render,
        so the editor simply goes back to saying "run the node once".
        """
        width, height = geometry.size
        fx, fy, cx, cy = lens
        try:
            samples = []
            for index in preview.sample_frames(sources):
                points, valid = geometry.frame(index)
                keep = prune_edges(points[..., 2], valid)
                samples.append((index, source[index], points[..., 2], valid, keep))
            return preview.write(samples, folder_paths.get_temp_directory(), {
                "source_width": width, "source_height": height,
                "fx": fx / width, "fy": fy / height, "cx": cx / width, "cy": cy / height,
                "pivot_z": pivot, "splat": SPLAT, "prune_depth_edges": bool(prune_depth_edges),
                "quality": preview_quality,
            })
        except Exception:
            logger.exception("could not write the editor preview")
            return None
