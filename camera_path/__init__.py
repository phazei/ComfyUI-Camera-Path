"""Core library for the camera path nodes.

Pure geometry and I/O helpers with no ComfyUI imports, so they can be tested
standalone (see `tests/context.py`):

- `trajectory` -- keyframe JSON parsing and interpolation
- `render`     -- virtual camera math and the point-cloud reprojection renderer
- `geometry`   -- MoGe geometry packet unpacking
- `preview`    -- the cached point cloud the frontend editor reads
"""
