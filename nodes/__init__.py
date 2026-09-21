"""Node registry. Add new nodes here and to ALL_NODES."""
from .camera_path_video import CameraPathVideo

#: Every node the extension exposes, in menu order.
ALL_NODES = [
    CameraPathVideo,
]

__all__ = ["ALL_NODES", "CameraPathVideo"]
