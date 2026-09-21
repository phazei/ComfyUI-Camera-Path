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
PREVIEW_SAMPLES = 8


def sample_frames(source_indices) -> list[int]:
    """Up to PREVIEW_SAMPLES distinct source frames, evenly spread over the output."""
    distinct = sorted(set(int(i) for i in source_indices))
    if len(distinct) <= PREVIEW_SAMPLES:
        return distinct
    step = (len(distinct) - 1) / (PREVIEW_SAMPLES - 1)
    return sorted({distinct[int(round(k * step))] for k in range(PREVIEW_SAMPLES)})


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
    os.makedirs(temp_dir, exist_ok=True)
    entries = []
    for order, (frame, rgb, depth, valid, keep) in enumerate(scaled):
        quantized = ((depth - low) / span * 65535.0).clamp(0, 65535).to(torch.int32)
        quantized = torch.where(valid, quantized, torch.zeros_like(quantized)).numpy()
        packed = np.stack([(quantized >> 8).astype(np.uint8), (quantized & 255).astype(np.uint8),
                           np.where(valid.numpy(), np.where(keep.numpy(), 0, 127), 255).astype(np.uint8)], axis=-1)
        pixels = (rgb.clamp(0, 1) * 255.0).round().to(torch.uint8).numpy()
        names = (f"{stamp}_{order}_rgb.png", f"{stamp}_{order}_z.png")
        Image.fromarray(pixels).save(os.path.join(temp_dir, names[0]), compress_level=3)
        Image.fromarray(packed).save(os.path.join(temp_dir, names[1]), compress_level=3)
        entries.append({"frame": int(frame),
                        "rgb": {"filename": names[0], "subfolder": "", "type": "temp"},
                        "z": {"filename": names[1], "subfolder": "", "type": "temp"}})
    height, width = scaled[0][2].shape
    return dict(meta, levels=PREVIEW_LEVELS, width=int(width), height=int(height),
                z_low=low, z_high=high, samples=entries)
