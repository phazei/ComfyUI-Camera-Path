"""Unpacks a MOGE_GEOMETRY packet into what the renderer needs.

MOGE_GEOMETRY is the dict produced by ComfyUI's native `Run MoGe Inference`
(`comfy_extras/nodes_moge.py`). Keys, all optional except `image`:

    points      torch.Tensor (B, H, W, 3)  camera-space XYZ, OpenCV axes
    depth       torch.Tensor (B, H, W)
    intrinsics  torch.Tensor (B, 3, 3)     normalised (fx by width, fy by height), perspective only
    mask        torch.Tensor (B, H, W)     bool
    normal      torch.Tensor (B, H, W, 3)  v2 and later only
    image       torch.Tensor (B, H, W, 3)  the input image, on CPU

`points` is what this module uses: MoGe already unprojects depth through its own
intrinsics, so there is nothing to reconstruct. Masked-out pixels (sky, invalid)
come back as `inf` when the MoGe node ran with `apply_mask` on, and are dropped.
"""
import logging

import torch

from . import render

logger = logging.getLogger("camerapath.geometry")


def prune_edges(depth: torch.Tensor, valid: torch.Tensor) -> torch.Tensor:
    """Keep depth-continuous points at a fixed 512-long-side inspection scale."""
    height, width = depth.shape
    size = tuple(max(3, round(n * 512 / max(height, width))) for n in (height, width))
    resize = torch.nn.functional.interpolate
    pool = torch.nn.functional.max_pool2d
    z = resize(depth[None, None], size=size, mode="nearest")
    mask = resize(valid[None, None].float(), size=size, mode="nearest") > 0.5
    mask = mask & torch.isfinite(z) & (z > 0)
    maximum = pool(torch.where(mask, z, torch.inf), 3, stride=1, padding=1)
    minimum = -pool(torch.where(mask, -z, torch.inf), 3, stride=1, padding=1)
    relative = (maximum - minimum) / z.abs().clamp_min(1e-6)
    keep = mask & torch.isfinite(relative) & (relative <= 0.30)
    # All contributing neighbours must survive; do not interpolate edges back in.
    keep = resize(keep.float(), size=(height, width), mode="bilinear", align_corners=False)[0, 0] > 0.999
    return keep & valid & torch.isfinite(depth) & (depth > 0)


class Geometry:
    """MoGe point maps resampled to the source resolution, one frame at a time."""

    def __init__(self, moge_geometry: dict, size: tuple[int, int]):
        """
        Args:
            moge_geometry: a MOGE_GEOMETRY packet.
            size: (width, height) of the source image, which the geometry is resampled to.
        """
        if not isinstance(moge_geometry, dict) or "points" not in moge_geometry:
            raise ValueError("moge_geometry has no point map. Connect Run MoGe Inference.")
        self.points = moge_geometry["points"]
        self.mask = moge_geometry.get("mask")
        self.intrinsics = moge_geometry.get("intrinsics")
        self.count = int(self.points.shape[0])
        self.size = size
        self.resample = (int(self.points.shape[2]), int(self.points.shape[1])) != size
        if self.resample:
            logger.info("MoGe geometry is %dx%d, resampling to the source %dx%d",
                        self.points.shape[2], self.points.shape[1], size[0], size[1])

    def frame(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        """Geometry for one source frame, clamped to the last available one.

        Returns:
            (points [H, W, 3] float32, valid [H, W] bool) at the source resolution.
        """
        index = min(int(index), self.count - 1)
        points = self.points[index].float().cpu()
        valid = torch.isfinite(points).all(dim=-1) & (points[..., 2] > render.EPS)
        if self.mask is not None:
            valid = valid & self.mask[min(index, int(self.mask.shape[0]) - 1)].bool().cpu()
        if self.resample:
            width, height = self.size
            resize = torch.nn.functional.interpolate
            points = resize(points.permute(2, 0, 1)[None], size=(height, width), mode="nearest")[0].permute(1, 2, 0)
            valid = resize(valid[None, None].float(), size=(height, width), mode="nearest")[0, 0] > 0.5
        return points.contiguous(), valid

    def lens(self, points: torch.Tensor, valid: torch.Tensor) -> tuple[float, float, float, float]:
        """The virtual camera's lens, taken from the anchor frame so it never drifts.

        Returns:
            (fx, fy, cx, cy) in pixels of the source resolution.
        """
        width, height = self.size
        if self.intrinsics is not None:
            matrix = self.intrinsics[0].float().cpu()
            return (float(matrix[0, 0]) * width, float(matrix[1, 1]) * height,
                    float(matrix[0, 2]) * width, float(matrix[1, 2]) * height)
        # Panorama geometry carries no intrinsics; read the lens off the point map.
        fx, fy = render.estimate_focal(points, valid, width, height)
        logger.info("moge_geometry has no intrinsics; fitted fx=%.1f fy=%.1f from the point map", fx, fy)
        return fx, fy, width / 2.0, height / 2.0
