"""Import the package under test.

`camera_path/` is pure torch/numpy/PIL and loads standalone, so most tests need
nothing else. The node module uses the real V3 API (`comfy_api.latest`) and the
real `comfy.*` / `folder_paths` modules, so `load_nodes()` needs a ComfyUI
checkout on `sys.path`. It is found via:

1. the `COMFYUI_PATH` environment variable, or
2. `../..` from this repo, which is where it sits when installed in `custom_nodes/`.

`tests/test_node.py` skips itself when neither resolves.
"""
import importlib.util
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = "comfyui_camera_path"


def _import(name, path, search=None):
    """Import a module or package from an explicit path, under an explicit name."""
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_core():
    """Import `camera_path` standalone, binding submodules so relative imports resolve."""
    core = _import(f"{PACKAGE}_core", ROOT / "camera_path" / "__init__.py",
                   search=[str(ROOT / "camera_path")])
    for name in ("trajectory", "render", "preview", "geometry"):
        setattr(core, name, _import(f"{PACKAGE}_core.{name}", ROOT / "camera_path" / f"{name}.py"))
    return core


_core = _load_core()
trajectory = _core.trajectory
render = _core.render
preview = _core.preview
geometry = _core.geometry


def comfyui_root():
    """Locate a ComfyUI checkout, or return None."""
    candidates = []
    if os.environ.get("COMFYUI_PATH"):
        candidates.append(pathlib.Path(os.environ["COMFYUI_PATH"]))
    candidates.append(ROOT.parent.parent)
    for candidate in candidates:
        if (candidate / "comfy_api" / "latest").is_dir() and (candidate / "folder_paths.py").is_file():
            return candidate
    return None


def load_nodes(temp_dir):
    """Import the custom node package against a real ComfyUI.

    Args:
        temp_dir: redirects `folder_paths.get_temp_directory()`, where previews are written.

    Returns:
        The imported package module, exposing `comfy_entrypoint` and `WEB_DIRECTORY`.

    Raises:
        RuntimeError: if no ComfyUI checkout could be found.
    """
    root = comfyui_root()
    if root is None:
        raise RuntimeError("no ComfyUI checkout found; set COMFYUI_PATH")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    import folder_paths

    folder_paths.get_temp_directory = lambda: str(temp_dir)
    return _import(PACKAGE, ROOT / "__init__.py", search=[str(ROOT)])
