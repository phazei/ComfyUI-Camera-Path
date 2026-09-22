"""Cached geometry for the editor's 3D preview.

After a run the node drops a handful of small RGB + depth PNGs in the ComfyUI
temp folder and hands the frontend their filenames. The editor rebuilds the
point cloud from them, so dragging the camera path reprojects the real scene
without re-running MoGe. js/preview.js reads the format written here:
depth is packed 16 bit big-endian into R and G; B = 255 marks invalid,
B = 127 marks a valid point rejected by pruning, and B = 0 marks a kept point.
"""
import os
import time

import numpy as np
import torch

PREVIEW_LEVELS = {"Low (384)": 384, "Medium (512)": 512, "High (768)": 768}
# The cache is a working file, not an output. It goes in its own folder so it cannot be
# mistaken for one in a temp directory people actually read.
SUBFOLDER = "camera_path"
# Every fifth source frame: near enough 5 a second at 24 or 30 fps without the node having
# to know the rate, and the preview then jitters the way the video does instead of holding
# one reconstruction for a second at a time. The floor keeps a short clip worth scrubbing
# and the ceiling is a memory budget - each sample costs a PNG pair on disk, a decode on
# load, and roughly 8 MB in the browser once its cloud is built.
PREVIEW_STRIDE = 5
PREVIEW_FLOOR = 10
PREVIEW_SAMPLES = 120


def _spread(distinct: list[int], count: int) -> list[int]:
    """`count` frames evenly spread across `distinct`, both ends included."""
    step = (len(distinct) - 1) / (count - 1)
    return sorted({distinct[int(round(k * step))] for k in range(count)})


def sample_frames(source_indices) -> list[int]:
    """Every PREVIEW_STRIDE-th distinct source frame, within the floor and the ceiling.

    The last frame always joins the set, whatever the stride lands on, so the end of
    the timeline previews the geometry it will actually be rendered from.
    """
    distinct = sorted(set(int(i) for i in source_indices))
    if len(distinct) <= max(PREVIEW_FLOOR, PREVIEW_STRIDE):
        return distinct
    picked = distinct[::PREVIEW_STRIDE]
    if len(picked) < PREVIEW_FLOOR:
        picked = _spread(distinct, PREVIEW_FLOOR)
    elif len(picked) > PREVIEW_SAMPLES:
        picked = _spread(distinct, PREVIEW_SAMPLES)
    return sorted(set(picked) | {distinct[-1]})


def _downscale(rgb: torch.Tensor, depth: torch.Tensor, valid: torch.Tensor,
               keep: torch.Tensor, long_side: int):
    """Resize cache samples without increasing the source dimensions."""
    height, width = depth.shape
    scale = min(long_side / max(height, width), 1.0)
    size = (max(1, int(round(height * scale))), max(1, int(round(width * scale))))
    if size == (height, width):
        return rgb, depth, valid, keep
    resize = torch.nn.functional.interpolate
    rgb = resize(rgb.permute(2, 0, 1)[None], size=size, mode="area")[0].permute(1, 2, 0)
    depth = resize(depth[None, None], size=size, mode="nearest")[0, 0]
    valid = resize(valid[None, None].float(), size=size, mode="nearest")[0, 0] > 0.5
    keep = resize(keep[None, None].float(), size=size, mode="nearest")[0, 0] > 0.5
    return rgb, depth, valid, keep


def write(samples, temp_dir: str, meta: dict) -> dict | None:
    """Cache (frame, rgb, depth, valid, keep) samples at maximum preview quality."""
    from PIL import Image

    scaled = [(frame,) + _downscale(rgb, depth, valid, keep, max(PREVIEW_LEVELS.values()))
              for frame, rgb, depth, valid, keep in samples]
    finite = [depth[valid] for _, _, depth, valid, _ in scaled if bool(valid.any())]
    if not finite:
        return None
    all_depth = torch.cat(finite)
    low, high = float(all_depth.min()), float(all_depth.max())
    span = max(high - low, 1e-9)

    stamp = f"camera_path_{int(time.time() * 1000):x}_{os.getpid() & 0xffff:04x}"
    directory = os.path.join(temp_dir, SUBFOLDER)
    os.makedirs(directory, exist_ok=True)
    entries = []
    for order, (frame, rgb, depth, valid, keep) in enumerate(scaled):
        quantized = ((depth - low) / span * 65535.0).clamp(0, 65535).to(torch.int32)
        quantized = torch.where(valid, quantized, torch.zeros_like(quantized)).numpy()
        packed = np.stack([(quantized >> 8).astype(np.uint8), (quantized & 255).astype(np.uint8),
                           np.where(valid.numpy(), np.where(keep.numpy(), 0, 127), 255).astype(np.uint8)], axis=-1)
        pixels = (rgb.clamp(0, 1) * 255.0).round().to(torch.uint8).numpy()
        names = (f"{stamp}_{order}_rgb.png", f"{stamp}_{order}_z.png")
        Image.fromarray(pixels).save(os.path.join(directory, names[0]), compress_level=3)
        Image.fromarray(packed).save(os.path.join(directory, names[1]), compress_level=3)
        entries.append({"frame": int(frame),
                        "rgb": {"filename": names[0], "subfolder": SUBFOLDER, "type": "temp"},
                        "z": {"filename": names[1], "subfolder": SUBFOLDER, "type": "temp"}})
    height, width = scaled[0][2].shape
    return dict(meta, levels=PREVIEW_LEVELS, width=int(width), height=int(height),
                z_low=low, z_high=high, samples=entries)
