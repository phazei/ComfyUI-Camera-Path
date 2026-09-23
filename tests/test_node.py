import asyncio
import json
import os
import tempfile
import unittest

from PIL import Image
import torch

from . import context

WIDTH, HEIGHT = 40, 32
FX = FY = 50.0


def geometry(depth, size=(WIDTH, HEIGHT)):
    """A MOGE_GEOMETRY packet for a flat wall at the given depths, one entry per frame."""
    width, height = size
    rows = torch.arange(height, dtype=torch.float32)[None, :, None] + 0.5
    columns = torch.arange(width, dtype=torch.float32)[None, None, :] + 0.5
    depth = depth.reshape(-1, 1, 1).expand(-1, height, width)
    points = torch.stack([(columns - width / 2) / FX * depth, (rows - height / 2) / FY * depth, depth], dim=-1)
    intrinsics = torch.tensor([[FX / width, 0.0, 0.5], [0.0, FY / height, 0.5], [0.0, 0.0, 1.0]])
    return {"points": points, "depth": depth, "mask": torch.ones_like(depth, dtype=torch.bool),
            "intrinsics": intrinsics[None].expand(depth.shape[0], -1, -1)}


@unittest.skipIf(context.comfyui_root() is None, "no ComfyUI checkout found; set COMFYUI_PATH")
class NodeRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.package = context.load_nodes(cls.temp.name)
        cls.nodes = asyncio.run(cls.package.comfy_entrypoint()).get_node_list()
        cls.nodes = asyncio.run(cls.nodes) if asyncio.iscoroutine(cls.nodes) else cls.nodes
        cls.node = cls.nodes[0]
        # The same call ComfyUI's loader makes: validates the class, finalizes and
        # validates the schema.
        cls.schema = cls.node.GET_SCHEMA()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_node(self, source, moge, frames, path, camera_path=None, markers=False, fps=24.0,
                 prune=True, quality="Medium (512)", background="#000000"):
        """Calls the node the way ComfyUI would, and returns {"result", "ui"}."""
        output = self.node.execute(source, moge, frames, fps, markers, background, prune, quality, path,
                                   camera_path)
        return {"result": output.result, "ui": output.ui}

    def test_v3_entry_point_exposes_the_node(self):
        # NODE_CLASS_MAPPINGS in __init__ would silently disable comfy_entrypoint.
        self.assertFalse(hasattr(self.package, "NODE_CLASS_MAPPINGS"))
        self.assertEqual(self.package.WEB_DIRECTORY, "./js")
        self.assertEqual(len(self.nodes), 1)

    def test_schema_is_valid(self):
        self.assertEqual(self.schema.node_id, "CameraPath_Video")
        self.assertEqual([i.id for i in self.schema.inputs],
                         ["source", "moge_geometry", "frame_count", "fps", "markers", "background",
                          "prune_depth_edges", "preview_quality", "keyframes",
                          "camera_path"])
        # Black by default, so adding the colour changed no existing render.
        self.assertEqual(next(i for i in self.schema.inputs if i.id == "background").default, "#000000")
        count, rate = (next(i for i in self.schema.inputs if i.id == name) for name in ("frame_count", "fps"))
        self.assertEqual((count.default, rate.default), (120, 24.0))
        self.assertTrue(next(i for i in self.schema.inputs if i.id == "prune_depth_edges").default)
        self.assertEqual(next(i for i in self.schema.inputs if i.id == "preview_quality").default, "Medium (512)")
        seed = next(i for i in self.schema.inputs if i.id == "camera_path")
        # Socket only, so it gets a connection dot rather than a box in the node.
        self.assertTrue(seed.force_input)
        self.assertTrue(seed.optional)
        self.assertEqual([o.display_name for o in self.schema.outputs],
                         ["camera_video", "camera_path", "video_mask"])
        # The editor region needs its UI output replayed after a page refresh.
        self.assertTrue(self.schema.has_intermediate_output)

    def test_still_image_becomes_a_camera_move(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        output = self.run_node(source, geometry(torch.tensor([2.0])), 6, "[{\"frame\": 0}]")
        video, path, mask = output["result"]
        self.assertEqual(tuple(video.shape), (6, HEIGHT, WIDTH, 3))
        self.assertEqual(tuple(mask.shape), (6, HEIGHT, WIDTH))
        # A default pose is the source camera, so every frame is the source image.
        for index in range(6):
            self.assertTrue(torch.equal(video[index], source[0]))
        self.assertFalse(bool(mask.any()))
        self.assertEqual(json.loads(path)["camera"], [{"frame": 0, "pivot": "p1", "pivot_target": "p1",
                                                     "pivot_blend": 0, **context.trajectory.DEFAULTS}])

    def test_fps_is_a_timeline_rate_and_never_reaches_the_render(self):
        # The rendered frames are compared loosely on purpose: the splat's tie-break is
        # order-dependent, so two identical runs need not be bit-identical either.
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        path = json.dumps([{"frame": 0}, {"frame": 5, "azimuth": 30}])
        slow = self.run_node(source, geometry(torch.tensor([2.0])), 6, path, fps=8.0)
        fast = self.run_node(source, geometry(torch.tensor([2.0])), 6, path, fps=60.0)
        self.assertEqual(slow["result"][1], fast["result"][1])
        self.assertEqual(json.loads(slow["ui"]["camera_path"][0])["frame_count"],
                         json.loads(fast["ui"]["camera_path"][0])["frame_count"])
        for index in range(6):
            self.assertLess(float((slow["result"][0][index] - fast["result"][0][index]).abs().mean()), 0.02)
            self.assertTrue(torch.equal(slow["result"][2][index], fast["result"][2][index]))

    def test_moving_the_camera_opens_holes(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        path = json.dumps([{"frame": 0}, {"frame": 5, "azimuth": 30}])
        video, _, mask = self.run_node(source, geometry(torch.tensor([2.0])), 6, path)["result"]
        self.assertFalse(bool(mask[0].any()))
        self.assertGreater(float(mask[5].mean()), 0.05)
        self.assertFalse(torch.equal(video[5], source[0]))

    def test_holes_take_the_background_colour(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        path = json.dumps([{"frame": 0}, {"frame": 5, "azimuth": 30}])
        video, _, mask = self.run_node(source, geometry(torch.tensor([2.0])), 6, path,
                                       background="#ff00ff")["result"]
        holes = mask[5].bool()
        self.assertTrue(bool(holes.any()))
        self.assertTrue(torch.equal(video[5][holes], torch.tensor([1.0, 0.0, 1.0]).expand(int(holes.sum()), 3)))
        # The mask still reports the holes whatever colour they are painted.
        plain = self.run_node(source, geometry(torch.tensor([2.0])), 6, path)["result"][2]
        self.assertTrue(torch.equal(mask, plain))

    def test_the_source_holds_once_the_clip_runs_out(self):
        source = torch.zeros(2, HEIGHT, WIDTH, 3)
        source[1] = 1.0
        video, _, _ = self.run_node(source, geometry(torch.tensor([2.0, 2.0])), 4, "[{\"frame\": 0}]")["result"]
        self.assertAlmostEqual(float(video[0].mean()), 0.0)
        for index in (1, 2, 3):
            self.assertAlmostEqual(float(video[index].mean()), 1.0)

    def test_geometry_is_resampled_to_the_source_resolution(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        moge = geometry(torch.tensor([2.0]), size=(WIDTH // 2, HEIGHT // 2))
        video, _, _ = self.run_node(source, moge, 2, "[{\"frame\": 0}]")["result"]
        self.assertEqual(tuple(video.shape), (2, HEIGHT, WIDTH, 3))

    def test_geometry_without_points_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_node(torch.rand(1, HEIGHT, WIDTH, 3), {"depth": torch.ones(1, HEIGHT, WIDTH)}, 1, "[]")

    def test_the_editor_payload_carries_the_cached_cloud(self):
        source = torch.rand(3, HEIGHT, WIDTH, 3)
        output = self.run_node(source, geometry(torch.tensor([2.0, 2.5, 3.0])), 5, "[{\"frame\": 0}]")
        data = json.loads(output["ui"]["camera_path"][0])
        self.assertEqual(data["frame_count"], 5)
        self.assertEqual(data["path"]["camera"][0]["frame"], 0)
        cache = data["preview"]
        self.assertTrue(cache["prune_depth_edges"])
        self.assertEqual(cache["quality"], "Medium (512)")
        self.assertEqual(cache["levels"], context.preview.PREVIEW_LEVELS)
        self.assertEqual([sample["frame"] for sample in cache["samples"]], [0, 1, 2])
        self.assertAlmostEqual(cache["fx"], FX / WIDTH, places=6)
        self.assertAlmostEqual(cache["pivot_z"], 2.0, places=5)
        for sample in cache["samples"]:
            for reference in (sample["rgb"], sample["z"]):
                self.assertEqual(reference["subfolder"], context.preview.SUBFOLDER)
                self.assertTrue(os.path.exists(
                    os.path.join(self.temp.name, reference["subfolder"], reference["filename"])))
        # The cache is a working file. A temp directory people read must stay readable.
        self.assertEqual([], [name for name in os.listdir(self.temp.name) if name.endswith(".png")])

    def test_pruning_opens_mask_holes_at_depth_edges(self):
        source = torch.ones(1, 16, 1024, 3)
        moge = geometry(torch.tensor([2.0]), size=(1024, 16))
        moge["points"][:, :, 512:] *= 3
        plain = self.run_node(source, moge, 1, '[{"frame": 0}]', prune=False, quality="Low (384)")
        pruned = self.run_node(source, moge, 1, '[{"frame": 0}]', prune=True)
        self.assertFalse(bool(plain["result"][2].any()))
        self.assertTrue(bool(pruned["result"][2].any()))
        self.assertEqual(plain["result"][0].shape, pruned["result"][0].shape)
        cached = []
        for output in (plain, pruned):
            meta = json.loads(output["ui"]["camera_path"][0])["preview"]
            self.assertEqual(meta["width"], 768)
            reference = meta["samples"][0]["z"]
            with Image.open(os.path.join(self.temp.name, reference["subfolder"], reference["filename"])) as image:
                cached.append(image.tobytes())
        self.assertEqual(cached[0], cached[1])

    def test_quality_does_not_change_output_resolution_or_pixels(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        for quality in context.preview.PREVIEW_LEVELS:
            output = self.run_node(source, geometry(torch.tensor([2.0])), 1, '[{"frame": 0}]',
                                   prune=False, quality=quality)
            self.assertTrue(torch.equal(output["result"][0], source))
            meta = json.loads(output["ui"]["camera_path"][0])["preview"]
            self.assertFalse(meta["prune_depth_edges"])
            self.assertEqual(meta["quality"], quality)

    def test_markers_burn_the_lattice_into_the_video(self):
        source = torch.zeros(1, HEIGHT, WIDTH, 3)
        # A wall at 2.0 with the lattice reaching from 1.0 to 7.0: the spheres in front
        # of it land in the video, the ones behind it are occluded.
        output = self.run_node(source, geometry(torch.tensor([2.0])), 2, "[{\"frame\": 0}]", markers=True)
        video, _, mask = output["result"]
        self.assertGreater(float((video[0] > 0).any(dim=-1).float().mean()), 0.02)
        self.assertLess(float((video[0] > 0).any(dim=-1).float().mean()), 0.5)
        self.assertFalse(bool(mask.any()))
        self.assertTrue(json.loads(output["ui"]["camera_path"][0])["markers"])
        # Off by default, and then nothing but the source is in the frame.
        plain = self.run_node(source, geometry(torch.tensor([2.0])), 2, "[{\"frame\": 0}]")
        self.assertTrue(torch.equal(plain["result"][0][0], source[0]))
        self.assertFalse(json.loads(plain["ui"]["camera_path"][0])["markers"])

    def test_the_connected_path_seeds_the_editor_but_never_renders(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        seed = json.dumps([{"frame": 0, "azimuth": 45}])
        output = self.run_node(source, geometry(torch.tensor([2.0])), 3, "[{\"frame\": 0}]", seed)
        video, rendered, _ = output["result"]
        # The authored keyframes rendered, so the frames are still the source image.
        self.assertEqual(json.loads(rendered)["camera"][0]["azimuth"], 0.0)
        self.assertTrue(torch.equal(video[0], source[0]))
        # ...but the seed is handed to the editor so Reset path can offer it.
        data = json.loads(output["ui"]["camera_path"][0])
        self.assertEqual(data["input_path"]["camera"], [{"frame": 0, "pivot": "p1", "pivot_target": "p1",
                                                       "pivot_blend": 0, **context.trajectory.DEFAULTS,
                                                         "azimuth": 45.0}])

    def test_an_off_axis_pivot_moves_a_reset_camera(self):
        source = torch.rand(1, HEIGHT, WIDTH, 3)
        path = json.dumps({"pivots": [{"id": "s", "keys": [{"frame": 0, "x": 0.3, "y": -0.1, "z": 0.8}]}],
                           "camera": [{"frame": 0, "pivot": "s"}, {"frame": 3, "pivot": "s", "azimuth": 25}]})
        video, rendered, mask = self.run_node(source, geometry(torch.tensor([2.0])), 4, path)["result"]
        self.assertFalse(torch.equal(video[0], source[0]))
        self.assertTrue(bool(mask[0].any()))
        self.assertFalse(torch.equal(video[3], video[0]))
        self.assertEqual(json.loads(rendered)["pivots"][0]["keys"][0]["x"], 0.3)

    def test_an_unusable_connected_path_is_ignored(self):
        output = self.run_node(torch.rand(1, HEIGHT, WIDTH, 3), geometry(torch.tensor([2.0])),
                               1, "[{\"frame\": 0}]", "not json")
        self.assertIsNone(json.loads(output["ui"]["camera_path"][0])["input_path"])

    def test_an_alpha_channel_is_ignored(self):
        source = torch.rand(1, HEIGHT, WIDTH, 4)
        video, _, _ = self.run_node(source, geometry(torch.tensor([2.0])), 1, "[{\"frame\": 0}]")["result"]
        self.assertTrue(torch.equal(video[0], source[0, ..., :3]))


if __name__ == "__main__":
    unittest.main()
