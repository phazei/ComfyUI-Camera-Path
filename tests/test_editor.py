"""Runs the editor inside jsdom. Skipped unless node and jsdom are both available."""
import pathlib
import shutil
import subprocess
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "editor_smoke.mjs"


def has_jsdom():
    probe = subprocess.run(["node", "--input-type=module", "-e", "await import('jsdom')"],
                           capture_output=True, cwd=SCRIPT.parent)
    return probe.returncode == 0


@unittest.skipIf(shutil.which("node") is None, "node is not installed")
class EditorSmoke(unittest.TestCase):
    def test_editor_drives_a_full_session(self):
        if not has_jsdom():
            self.skipTest("jsdom is not installed (npm install jsdom)")
        result = subprocess.run(["node", str(SCRIPT)], capture_output=True, text=True, cwd=SCRIPT.parent)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
