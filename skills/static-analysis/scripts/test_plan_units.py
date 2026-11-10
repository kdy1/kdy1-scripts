"""Offline checks for the deterministic unit planner."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("plan-units.py")
SPEC = importlib.util.spec_from_file_location("plan_units", SCRIPT)
planner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(planner)


def write(root, relative, lines=1, data=None):
    path = Path(root) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if data is not None:
        path.write_bytes(data)
    else:
        path.write_text("x\n" * lines)
    return path


class PlanUnitsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_groups_by_top_level_directory(self):
        write(self.root, "a/one.py", 3)
        write(self.root, "a/two.py", 2)
        write(self.root, "b/three.py", 1)
        write(self.root, "root.py", 1)
        result = planner.plan(self.root, 6, 40, 4000)
        self.assertEqual([unit["label"] for unit in result["units"]], [".", "a", "b"])
        self.assertEqual([unit["id"] for unit in result["units"]],
                         ["unit-01", "unit-02", "unit-03"])
        self.assertEqual(result["units"][1]["paths"], ["a/one.py", "a/two.py"])
        self.assertEqual(result["fileCount"], 4)
        self.assertEqual(result["lineCount"], 7)

    def test_skips_vendored_and_lock_files(self):
        write(self.root, "src/app.py", 2)
        write(self.root, "node_modules/pkg/index.js", 5)
        write(self.root, "package-lock.json", 5)
        write(self.root, "assets/logo.png", data=b"\x89PNG\r\n")
        result = planner.plan(self.root, 6, 40, 4000)
        self.assertEqual(result["fileCount"], 1)
        self.assertEqual(result["units"][0]["paths"], ["src/app.py"])

    def test_splits_large_flat_directory(self):
        for index in range(5):
            write(self.root, f"flat/file{index}.py", 1)
        result = planner.plan(self.root, 10, 2, 4000)
        self.assertEqual(len(result["units"]), 3)
        self.assertEqual([unit["files"] for unit in result["units"]], [2, 2, 1])

    def test_merges_to_unit_budget(self):
        for name in ("a", "b", "c", "d"):
            write(self.root, f"{name}/file.py", 1)
        result = planner.plan(self.root, 2, 40, 4000)
        self.assertEqual(len(result["units"]), 2)
        self.assertEqual(sum(unit["files"] for unit in result["units"]), 4)

    def test_file_scope(self):
        path = write(self.root, "src/app.py", 4)
        result = planner.plan(path, 6, 40, 4000)
        self.assertEqual(result["root"], str(path.parent.resolve()))
        self.assertEqual(len(result["units"]), 1)
        self.assertEqual(result["units"][0]["paths"], ["app.py"])
        self.assertEqual(result["units"][0]["lines"], 4)

    def test_deterministic_output(self):
        write(self.root, "b/one.py", 2)
        write(self.root, "a/two.py", 3)
        first = json.dumps(planner.plan(self.root, 6, 40, 4000), sort_keys=True)
        second = json.dumps(planner.plan(self.root, 6, 40, 4000), sort_keys=True)
        self.assertEqual(first, second)

    def test_skips_binary_files(self):
        write(self.root, "src/app.py", 2)
        write(self.root, "src/blob.bin", data=b"\0\0\0")
        result = planner.plan(self.root, 6, 40, 4000)
        self.assertEqual(result["units"][0]["paths"], ["src/app.py"])

    def test_label_uses_common_directory(self):
        write(self.root, "src/core/a.py", 1)
        write(self.root, "src/core/b.py", 1)
        result = planner.plan(self.root, 6, 40, 4000)
        self.assertEqual(result["units"][0]["label"], "src/core")

    def test_rejects_scope_without_analyzable_files(self):
        (self.root / "empty").mkdir()
        with self.assertRaises(ValueError):
            planner.plan(self.root / "empty", 6, 40, 4000)


if __name__ == "__main__":
    unittest.main()
