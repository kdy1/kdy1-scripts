import subprocess
import tempfile
import unittest
from pathlib import Path

from co_review import (changed_files, classify, cleanup, parse_pr, risk_signals,
                       summarize_checks, temp_parent, unresolved_threads)


class ParseTests(unittest.TestCase):
    def test_url_and_number(self):
        self.assertEqual(parse_pr("https://github.com/o/r/pull/12/files"), ("github.com", "o", "r", 12))
        self.assertEqual(parse_pr("7", "o/r"), ("github.com", "o", "r", 7))
        self.assertEqual(parse_pr("7", "ghe.example.com/o/r"), ("ghe.example.com", "o", "r", 7))
        with self.assertRaises(ValueError):
            parse_pr("7")


class ClassifyTests(unittest.TestCase):
    def test_categories(self):
        cases = {
            ".github/workflows/ci.yml": "ci",
            "packages/core/package.json": "dependencies",
            "Cargo.lock": "dependencies",
            "db/migrations/001_init.sql": "migrations",
            "src/__snapshots__/a.snap": "generated",
            "scripts/cargo/fix.test.mjs": "tests",
            "tests/test_api.py": "tests",
            "pkg/foo_test.go": "tests",
            "README.md": "docs",
            "tsconfig.json": "config",
            "src/main.rs": "source",
        }
        for path, category in cases.items():
            self.assertEqual(classify(path)[0], category, path)

    def test_sensitive(self):
        self.assertTrue(classify("src/auth/session.ts")[1])
        self.assertFalse(classify("src/render.ts")[1])


class CheckTests(unittest.TestCase):
    def test_groups_check_runs_and_status_contexts(self):
        groups = summarize_checks([
            {"__typename": "CheckRun", "name": "test", "workflowName": "CI",
             "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "u1"},
            {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": ""},
            {"__typename": "CheckRun", "name": "skip", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS"},
            {"__typename": "StatusContext", "context": "cov", "state": "ERROR"},
        ])
        self.assertEqual([c["name"] for c in groups["failing"]], ["CI / test", "cov"])
        self.assertEqual([c["name"] for c in groups["pending"]], ["lint"])
        self.assertEqual([c["name"] for c in groups["passing"]], ["skip", "deploy"])


class ThreadTests(unittest.TestCase):
    def test_keeps_unresolved_and_strips_badges(self):
        page = {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": [
            {"isResolved": True, "path": "a", "line": 1, "comments": {"totalCount": 1, "nodes": []}},
            {"isResolved": False, "isOutdated": True, "path": "b", "line": None, "originalLine": 9,
             "comments": {"totalCount": 2, "nodes": [{
                 "author": {"login": "bot"}, "url": "u",
                 "body": "**<sub>![P1 Badge](https://x/y.svg)</sub> Title**\n\n" + "x" * 400}]}},
        ]}}}}}
        threads = unresolved_threads([page])
        self.assertEqual(len(threads), 1)
        thread = threads[0]
        self.assertEqual((thread["path"], thread["line"], thread["outdated"]), ("b", 9, True))
        self.assertTrue(thread["body"].startswith("** Title** xxx"))
        self.assertEqual(len(thread["body"]), 300)


class SignalTests(unittest.TestCase):
    def test_source_without_tests_and_missing_intent(self):
        files = [{"path": "src/auth.py", "status": "M", "binary": False, "additions": 3,
                  "deletions": 1, "category": "source", "sensitive": True}]
        checks = {"failing": [], "pending": [], "passing": []}
        signals = risk_signals({"state": "OPEN", "body": ""}, files, checks, [])
        self.assertIn("Source files changed without test changes", signals)
        self.assertIn("Security-sensitive paths changed: src/auth.py", signals)
        self.assertTrue(any(s.startswith("No PR description") for s in signals))


class GitTests(unittest.TestCase):
    def test_changed_files_status_and_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            def git(*args):
                return subprocess.run(["git", "-C", tmp, "-c", "user.name=t", "-c",
                                       "user.email=t@t", *args], check=True,
                                      capture_output=True, text=True).stdout.strip()

            git("init", "-q")
            (repo / "old.txt").write_text("a\n")
            (repo / "keep.py").write_text("a\n")
            git("add", "-A")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (repo / "old.txt").unlink()
            (repo / "keep.py").write_text("a\nb\n")
            (repo / "img.bin").write_bytes(b"\0\1\2")
            (repo / "with space.md").write_text("x\n")
            git("add", "-A")
            git("commit", "-qm", "head")
            files = {f["path"]: f for f in changed_files(repo, base, "HEAD")}
            self.assertEqual(files["old.txt"]["status"], "D")
            self.assertEqual((files["keep.py"]["status"], files["keep.py"]["additions"]), ("M", 1))
            self.assertTrue(files["img.bin"]["binary"])
            self.assertEqual(files["with space.md"]["category"], "docs")


class TempParentTests(unittest.TestCase):
    def test_t3_worktree_uses_t3_tmp(self):
        with tempfile.TemporaryDirectory() as tmp:
            worktrees = Path(tmp) / "worktrees"
            root = worktrees / "proj" / "wt"
            sub = root / "src"
            sub.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            expected = str(root.resolve() / ".t3-tmp")
            self.assertEqual(temp_parent(sub, worktrees), expected)
            self.assertTrue(Path(expected).is_dir())
            # A checkout inside .t3-tmp/ maps to the worktree that holds it.
            nested = root / ".t3-tmp" / "co-review-x" / "head"
            nested.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(nested)], check=True)
            self.assertEqual(temp_parent(nested, worktrees), expected)

    def test_other_checkout_uses_system_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            self.assertIsNone(temp_parent(repo, Path(tmp) / "worktrees"))
            self.assertIsNone(temp_parent(Path(tmp), Path(tmp) / "worktrees"))
            self.assertFalse((repo / ".t3-tmp").exists())


class CleanupTests(unittest.TestCase):
    def test_refuses_foreign_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "manifest.json").write_text("{}")
            with self.assertRaises(ValueError):
                cleanup({"runDir": tmp})


if __name__ == "__main__":
    unittest.main()
