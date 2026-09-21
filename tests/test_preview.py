"""Preview quality and source-resolution pruning contracts."""
import tempfile
import unittest

import numpy as np
from PIL import Image
import torch

from .context import geometry, preview


class PreviewTests(unittest.TestCase):
    """Cache quality never changes the source or invents additional points."""

    def test_cache_keeps_unpruned_depth_and_separate_mask(self):
        depth = torch.ones(512, 800)
        depth[:, 400:] = 3
        valid = torch.ones_like(depth, dtype=torch.bool)
        valid[:, :20] = False
        keep = geometry.prune_edges(depth, valid)
        self.assertFalse(bool(keep[:, 399:401].any()))
        rgb = torch.zeros(512, 800, 3)
        with tempfile.TemporaryDirectory() as directory:
            meta = preview.write([(0, rgb, depth, valid, keep)], directory, {})
            self.assertEqual(meta["width"], 768)
            self.assertEqual(meta["levels"], preview.PREVIEW_LEVELS)
            _, expected_depth, expected_valid, expected_keep = preview._downscale(rgb, depth, valid, keep, 768)
            with Image.open(f"{directory}/{meta['samples'][0]['z']['filename']}") as image:
                packed = np.asarray(image).copy()
            np.testing.assert_array_equal(packed[..., 2] < 255, expected_valid.numpy())
            np.testing.assert_array_equal(packed[..., 2] == 0, (expected_valid & expected_keep).numpy())
            self.assertTrue(bool((packed[..., 2] == 127).any()))
            decoded = meta["z_low"] + (packed[..., 0].astype(np.float64) * 256 + packed[..., 1]) / 65535 * (
                meta["z_high"] - meta["z_low"])
            np.testing.assert_allclose(decoded[expected_valid], expected_depth[expected_valid], atol=1e-4)
        self.assertEqual(depth.shape, (512, 800))

    def test_all_pruned_still_caches_restorable_points(self):
        z = torch.ones(4, 6)
        with tempfile.TemporaryDirectory() as directory:
            meta = preview.write([(0, torch.zeros(4, 6, 3), z, z.bool(), ~z.bool())], directory, {})
            self.assertIsNotNone(meta)
            with Image.open(f"{directory}/{meta['samples'][0]['z']['filename']}") as image:
                self.assertTrue(bool((np.asarray(image)[..., 2] == 127).all()))

    def test_small_sources_are_not_upscaled(self):
        rgb = torch.zeros(2, 4, 3)
        z = torch.ones(2, 4)
        for side in preview.PREVIEW_LEVELS.values():
            self.assertEqual(preview._downscale(rgb, z, z.bool(), z.bool(), side)[1].shape, z.shape)

    def test_pruning_preserves_flat_depth_and_frame_borders(self):
        z = torch.ones(256, 512)
        self.assertTrue(bool(geometry.prune_edges(z, z.bool()).all()))

    def test_invalid_neighbours_are_discontinuities(self):
        z = torch.ones(512, 512)
        valid = z.bool()
        valid[200, 200] = False
        keep = geometry.prune_edges(z, valid)
        self.assertFalse(bool(keep[199:202, 199:202].any()))
        self.assertTrue(bool(keep[:199].all()))
        z[200, 200] = float("inf")
        self.assertTrue(torch.equal(keep, geometry.prune_edges(z, torch.ones_like(valid))))

    def test_all_invalid_is_empty(self):
        z = torch.full((16, 24), float("nan"))
        self.assertFalse(bool(geometry.prune_edges(z, torch.ones_like(z, dtype=torch.bool)).any()))
