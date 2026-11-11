"""Offline checks on temporary directories only; no real caches or checkouts are touched."""

import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import disk_cleanup as cleanup


DAY = 24 * cleanup.HOUR


def touch_tree(path, age):
    """Set the mtime of path and everything under it to `age` seconds ago."""
    stamp = time.time() - age
    for directory, dirs, files in os.walk(path):
        for name in dirs + files:
            os.utime(os.path.join(directory, name), (stamp, stamp), follow_symlinks=False)
    os.utime(path, (stamp, stamp))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def project(self, relative, manifest="Cargo.toml", artifact="target", age=3 * DAY):
        project = self.root / relative
        (project / artifact / "debug" / "deps").mkdir(parents=True)
        (project / artifact / "debug" / "deps" / "lib.rlib").write_bytes(b"x" * 4096)
        (project / manifest).write_text("{}")
        (project / ".git").write_text("gitdir: .gitdir\n")
        (project / ".gitdir").mkdir()
        (project / ".gitdir" / "index").write_text("")
        touch_tree(project, age)
        return project


class DetectionTest(Fixture):
    def test_kinds_require_matching_manifest(self):
        cargo = self.project("a")
        node = self.project("b", "package.json", "node_modules")
        stray = self.root / "c" / "target"
        stray.mkdir(parents=True)
        self.assertEqual(cleanup.artifact_kind(cargo / "target"), "cargo-target")
        self.assertEqual(cleanup.artifact_kind(node / "node_modules"), "node_modules")
        self.assertIsNone(cleanup.artifact_kind(stray))
        (stray / "CACHEDIR.TAG").write_text("# This file is a cache directory tag created by cargo.\n")
        self.assertEqual(cleanup.artifact_kind(stray), "cargo-target")

    def test_walk_stops_at_artifacts_and_ignores_symlinks(self):
        project = self.project("a", "package.json", "node_modules")
        nested = project / "node_modules" / "dep"
        (nested / "node_modules").mkdir(parents=True)
        (nested / "package.json").write_text("{}")
        (self.root / "link").symlink_to(project)
        found = cleanup.find_artifacts(self.root)
        self.assertEqual(found, [(project / "node_modules", "node_modules")])


class CollectTest(Fixture):
    def test_recent_activity_and_process_cwd_are_skipped(self):
        old = self.project("old", age=5 * DAY)
        recent = self.project("recent", age=3 * DAY)
        os.utime(recent / ".gitdir" / "index")
        busy = self.project("busy", age=4 * DAY)
        candidates, skipped = cleanup.collect(
            [str(self.root)], 24, [busy / "src"], [], time.time()
        )
        self.assertEqual([c["path"] for c in candidates], [str(old / "target")])
        reasons = {Path(s["path"]).parent.name: s["reason"] for s in skipped}
        self.assertTrue(reasons["recent"].startswith("active"))
        self.assertTrue(reasons["busy"].startswith("process cwd"))

    def test_workspace_member_is_busy_when_checkout_root_is_in_use(self):
        project = self.project("ws", "package.json", "node_modules")
        member = project / "packages" / "lib"
        (member / "node_modules").mkdir(parents=True)
        (member / "package.json").write_text("{}")
        touch_tree(project, 3 * DAY)
        candidates, _ = cleanup.collect([str(self.root)], 24, [project], [], time.time())
        self.assertEqual(candidates, [])

    def test_oldest_first_and_excludes(self):
        self.project("newer", age=2 * DAY)
        oldest = self.project("oldest", age=9 * DAY)
        excluded = self.project("excluded", age=20 * DAY)
        candidates, skipped = cleanup.collect([str(self.root)], 24, [], [excluded], time.time())
        self.assertEqual(Path(candidates[0]["path"]).parent, oldest)
        self.assertEqual(len(candidates), 2)
        self.assertTrue(skipped[0]["reason"].startswith("excluded"))


class SafetyTest(Fixture):
    def test_rejects_symlinks_and_paths_outside_roots(self):
        project = self.project("a")
        target = project / "target"
        self.assertTrue(cleanup.safe_to_delete(target, "cargo-target", [str(self.root)]))
        self.assertFalse(cleanup.safe_to_delete(target, "cargo-target", [str(self.root / "other")]))
        self.assertFalse(cleanup.safe_to_delete(target, "node_modules", [str(self.root)]))
        link_parent = self.root / "b"
        link_parent.mkdir()
        (link_parent / "Cargo.toml").write_text("")
        (link_parent / "target").symlink_to(target)
        self.assertFalse(cleanup.safe_to_delete(link_parent / "target", "cargo-target", [str(self.root)]))


class FreshCwdsTest(unittest.TestCase):
    def test_first_read_fetches_even_when_clock_is_near_zero(self):
        with patch.object(cleanup, "process_cwds", return_value=[Path("/work")]), \
                patch.object(cleanup.time, "monotonic", return_value=0.01):
            self.assertEqual(cleanup.FreshCwds().get(), [Path("/work")])


class CleanerTest(Fixture):
    def run_cleaner(self, free, target, dry_run=False):
        with patch.object(cleanup, "free_bytes", side_effect=free), \
                patch.object(cleanup, "process_cwds", return_value=[]), \
                patch.object(cleanup, "TOOL_CACHES", []), \
                patch.object(cleanup, "DERIVED_DATA", str(self.root / "none")):
            cleaner = cleanup.Cleaner(target, str(self.root), dry_run, [])
            cleaner.artifacts("agent-artifacts", [str(self.root)], 24, cleanup.FreshCwds(), time.time())
            return cleaner.report(10)

    def test_stops_once_target_is_met(self):
        first = self.project("first", age=9 * DAY)
        second = self.project("second", age=5 * DAY)
        removed = []
        real_remove = cleanup.remove_tree

        def remove(path):
            removed.append(path)
            return real_remove(path)

        # Free space rises by 10 after each removal.
        with patch.object(cleanup, "remove_tree", side_effect=remove):
            report = self.run_cleaner(lambda _: 100 + 10 * len(removed), 105)
        self.assertTrue(report["met"])
        self.assertEqual(removed, [first / "target"])
        self.assertEqual(report["actions"][0]["freedBytes"], 10)
        self.assertFalse((first / "target").exists())
        self.assertTrue((second / "target").exists())

    def test_dry_run_keeps_files(self):
        project = self.project("a", age=9 * DAY)
        report = self.run_cleaner(lambda _: 100, 10 ** 12, dry_run=True)
        self.assertTrue((project / "target").exists())
        self.assertEqual(report["actions"][0]["status"], "would-remove")
        self.assertGreater(report["actions"][0]["bytes"], 0)
        self.assertFalse(report["met"])

    def test_target_already_met_does_nothing(self):
        project = self.project("a", age=9 * DAY)
        report = self.run_cleaner(lambda _: 500, 400)
        self.assertEqual(report["actions"], [])
        self.assertTrue((project / "target").exists())


if __name__ == "__main__":
    unittest.main()
