"""Offline checks on temporary directories only; no real caches or checkouts are touched."""

import json
import os
from pathlib import Path
import shutil
import subprocess
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


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args],
        cwd=cwd, check=True, capture_output=True,
    )


class WorktreeFixture(Fixture):
    """A main repository at <root>/main and linked worktrees at <root>/worktrees/repo/<name>."""

    def setUp(self):
        super().setUp()
        self.main = self.root / "main"
        self.main.mkdir()
        git(self.main, "init", "-q", "-b", "main")
        (self.main / "a.txt").write_text("a")
        git(self.main, "add", ".")
        git(self.main, "commit", "-q", "-m", "init")
        self.base = self.root / "worktrees"
        (self.base / "repo").mkdir(parents=True)

    def worktree(self, name, age=10 * DAY, detach=False):
        path = self.base / "repo" / name
        git(self.main, "worktree", "add", "-q", *(["--detach"] if detach else ["-b", name]), str(path))
        self.age(path, age)
        return path

    def age(self, path, age):
        touch_tree(path, age)
        gitdir = self.main / ".git" / "worktrees" / path.name
        stamp = time.time() - age
        for marker in ("HEAD", "index"):
            if (gitdir / marker).exists():
                os.utime(gitdir / marker, (stamp, stamp))

    def collect(self, idle=168, cwds=(), excludes=()):
        return cleanup.collect_worktrees(
            [str(self.base)], idle, list(cwds), list(excludes), time.time()
        )


class WorktreeTest(WorktreeFixture):
    def test_old_clean_worktree_is_a_candidate_and_recent_one_is_not(self):
        old = self.worktree("old", age=10 * DAY)
        self.worktree("recent", age=2 * DAY)
        candidates, skipped = self.collect()
        self.assertEqual([c["path"] for c in candidates], [str(old)])
        self.assertTrue(skipped[0]["reason"].startswith("active"))

    def test_unsafe_worktrees_are_skipped(self):
        lost = self.worktree("lost", detach=True)
        (lost / "b.txt").write_text("b")
        git(lost, "add", ".")
        git(lost, "commit", "-q", "-m", "only here")
        self.age(lost, 10 * DAY)
        busy = self.worktree("busy")
        candidates, skipped = self.collect(cwds=[busy / "src"])
        self.assertEqual(candidates, [])
        reasons = {Path(s["path"]).name: s["reason"] for s in skipped}
        self.assertIn("on no branch", reasons["lost"])
        self.assertTrue(reasons["busy"].startswith("process cwd"))

    def test_detached_worktree_on_a_branch_commit_is_a_candidate(self):
        path = self.worktree("pinned", detach=True)
        candidates, _ = self.collect()
        self.assertEqual([c["path"] for c in candidates], [str(path)])

    def test_old_dirty_worktree_preserves_index_and_untracked_files(self):
        path = self.worktree("dirty")
        (path / "a.txt").write_text("staged")
        git(path, "add", "a.txt")
        (path / "a.txt").write_text("unstaged")
        (path / "new.txt").write_text("untracked")
        self.age(path, 10 * DAY)
        candidates, _ = self.collect()
        self.assertEqual([c["path"] for c in candidates], [str(path)])

        with patch.object(cleanup, "free_bytes", return_value=100), \
                patch.object(cleanup, "process_cwds", return_value=[]):
            cleaner = cleanup.Cleaner(10 ** 9, str(self.root), False, [])
            cleaner.worktrees("old-worktrees", [str(self.base)], 168, cleanup.FreshCwds(), time.time())
        self.assertEqual(cleaner.actions[0]["status"], "removed")
        self.assertEqual(cleaner.actions[0]["stashes"], [f"maintain-device: {path}"])
        self.assertFalse(path.exists())

        git(self.main, "stash", "apply", "--index")
        staged = subprocess.check_output(["git", "show", ":a.txt"], cwd=self.main, text=True)
        self.assertEqual(staged, "staged")
        self.assertEqual((self.main / "a.txt").read_text(), "unstaged")
        self.assertEqual((self.main / "new.txt").read_text(), "untracked")

    def test_cleaner_removes_worktree_keeps_branch_and_prunes_nested(self):
        path = self.worktree("old")
        nested = path / ".t3-tmp" / "scratch"
        git(self.main, "worktree", "add", "-q", "--detach", str(nested))
        (nested / "wip.txt").write_text("nested change")
        self.age(path, 10 * DAY)
        self.age(nested, 10 * DAY)
        keep = self.worktree("recent", age=DAY)
        removed = []
        real_remove = cleanup.remove_worktree

        def remove(target, repo):
            result = real_remove(target, repo)
            removed.append(target)
            return result

        with patch.object(cleanup, "free_bytes", side_effect=lambda _: 100 + 10 * len(removed)), \
                patch.object(cleanup, "process_cwds", return_value=[]), \
                patch.object(cleanup, "remove_worktree", side_effect=remove):
            cleaner = cleanup.Cleaner(10 ** 9, str(self.root), False, [])
            cleaner.worktrees("old-worktrees", [str(self.base)], 168, cleanup.FreshCwds(), time.time())
            report = cleaner.report(10)
        self.assertEqual(report["actions"][0]["status"], "removed")
        self.assertFalse(path.exists())
        self.assertTrue(keep.exists())
        branches = subprocess.run(["git", "branch"], cwd=self.main, capture_output=True, text=True).stdout
        self.assertIn("old", branches)
        listed = subprocess.run(
            ["git", "worktree", "list"], cwd=self.main, capture_output=True, text=True
        ).stdout
        self.assertNotIn("scratch", listed)
        self.assertEqual(report["actions"][0]["stashes"], [f"maintain-device: {nested}"])
        git(self.main, "stash", "apply", "--index")
        self.assertEqual((self.main / "wip.txt").read_text(), "nested change")

    def test_dry_run_keeps_worktree(self):
        path = self.worktree("old")
        with patch.object(cleanup, "free_bytes", return_value=100), \
                patch.object(cleanup, "process_cwds", return_value=[]):
            cleaner = cleanup.Cleaner(10 ** 12, str(self.root), True, [])
            cleaner.worktrees("old-worktrees", [str(self.base)], 168, cleanup.FreshCwds(), time.time())
        self.assertTrue(path.exists())
        self.assertEqual(cleaner.actions[0]["status"], "would-remove")

    def test_emptying_artifacts_first_does_not_make_worktree_look_active(self):
        path = self.worktree("old")
        (path / "node_modules").mkdir()
        self.age(path, 10 * DAY)
        shutil.rmtree(path / "node_modules")
        candidates, _ = self.collect()
        self.assertEqual([c["path"] for c in candidates], [str(path)])


class DockerImageTest(unittest.TestCase):
    def test_image_age_filter_is_filled_in_from_idle_hours(self):
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        entry = [c for c in cleanup.TOOL_CACHES if c[0] == "docker unused images"]
        self.assertEqual(len(entry), 1)
        with patch.object(cleanup, "TOOL_CACHES", entry), \
                patch.object(cleanup, "free_bytes", return_value=0), \
                patch.object(cleanup, "process_running", return_value=None), \
                patch.object(cleanup.shutil, "which", return_value="/usr/bin/docker"), \
                patch.object(cleanup.subprocess, "run", side_effect=run), \
                patch.object(cleanup, "DERIVED_DATA", "/nonexistent"):
            cleanup.Cleaner(1, "/", False, [], docker_image_hours=168).tool_caches()
        self.assertIn(["docker", "image", "prune", "-af", "--filter", "until=168h"], commands)


class TargetTest(unittest.TestCase):
    def status(self, *args):
        output = []
        with patch.object(cleanup, "total_bytes", return_value=2000 * cleanup.GB), \
                patch.object(cleanup, "free_bytes", return_value=900 * cleanup.GB), \
                patch("builtins.print", side_effect=output.append):
            code = cleanup.main(["status", "--json", *args])
        return code, json.loads(output[0])

    def test_default_target_is_half_of_capacity(self):
        code, status = self.status()
        self.assertEqual(code, 0)
        self.assertEqual(status["totalBytes"], 2000 * cleanup.GB)
        self.assertEqual(status["targetBytes"], 1000 * cleanup.GB)
        self.assertFalse(status["met"])

    def test_percent_and_gb_overrides(self):
        self.assertEqual(self.status("--target-percent", "40")[1]["targetBytes"], 800 * cleanup.GB)
        self.assertTrue(self.status("--target-percent", "40")[1]["met"])
        self.assertEqual(self.status("--target-gb", "400")[1]["targetBytes"], 400 * cleanup.GB)

    def test_invalid_targets_are_rejected(self):
        for args in (["--target-percent", "0"], ["--target-percent", "101"], ["--target-gb", "0"],
                     ["--target-percent", "50", "--target-gb", "400"]):
            with self.assertRaises(SystemExit), patch("sys.stderr"):
                cleanup.main(["status", *args])


if __name__ == "__main__":
    unittest.main()
