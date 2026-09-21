"""ComfyUI-Camera-Path -- camera trajectory video from MoGe geometry.

V3 entry point. NODE_CLASS_MAPPINGS must never appear in this module: ComfyUI's
loader forks on it (`nodes.py`, `if NODE_CLASS_MAPPINGS ... elif comfy_entrypoint`)
and its presence would silently skip `comfy_entrypoint()`.
"""
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .nodes import ALL_NODES

#: Where ComfyUI serves this pack's frontend extensions from.
WEB_DIRECTORY = "./js"


class CameraPathExtension(ComfyExtension):
    """Exposes the camera path nodes to ComfyUI."""

    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return ALL_NODES


async def comfy_entrypoint() -> ComfyExtension:
    return CameraPathExtension()


__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
