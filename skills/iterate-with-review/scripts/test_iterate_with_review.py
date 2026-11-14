import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from iterate_with_review import init, load, repo_slug, round_record, round_start, summary, worktrees


def git(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", "-C", str(repo), *args], check=True, env=env,
                          capture_output=True, text=True).stdout.strip()


def reviewers(complete=True):
    return [{"slug": slug, "complete": complete, "verdict": "right-direction"}
            for slug in ("astra", "sol", "opus", "sonnet")]


class SlugTests(unittest.TestCase):
    def test_normalizes_remote_urls(self):
        for url in ("https://github.com/Kdy1/Repo.git", "git@github.com:kdy1/repo.git",
                    "ssh://git@github.com:22/kdy1/repo", "https://u:tok@github.com/kdy1/repo/"):
            with self.subTest(url=url):
                self.assertEqual(repo_slug(url), "github.com/kdy1/repo")
        self.assertIsNone(repo_slug("/local/path"))


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "src"
        git(root, "init", "--quiet", "-b", "main", str(self.repo))
        (self.repo / "a.txt").write_text("one\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "--quiet", "-m", "base")
        git(self.repo, "switch", "--quiet", "-c", "feature")
        (self.repo / "a.txt").write_text("two\n")
        git(self.repo, "commit", "--quiet", "-am", "change")
        self.ledger = root / "ledger.json"
        self.info = init(str(self.repo), base="main", intent="Make it two.", ledger_path=self.ledger)

    def tearDown(self):
        self.tmp.cleanup()

    def commit_fix(self, text):
        (self.repo / "a.txt").write_text(text)
        git(self.repo, "commit", "--quiet", "-am", "fix")
        return git(self.repo, "rev-parse", "HEAD")

    def test_init_records_branch_base_and_intent(self):
        self.assertEqual((self.info["branch"], self.info["base"]), ("feature", "main"))
        self.assertEqual(Path(self.info["intentFile"]).read_text(), "Make it two.\n")
        with self.assertRaisesRegex(ValueError, "already exists"):
            init(str(self.repo), base="main", ledger_path=self.ledger)

    def test_fix_round_then_clean_round_finishes(self):
        round_start(self.ledger)
        fix = self.commit_fix("three\n")
        result = round_record(self.ledger, {"reviewers": reviewers(), "findings": [
            {"id": "F1", "priority": "P1", "title": "Bug", "reporters": ["opus", "sol"],
             "disposition": "applied", "commits": [fix]},
            {"id": "F2", "priority": "P3", "title": "False alarm", "reporters": ["astra"],
             "disposition": "rejected", "evidence": "a.txt:1 already handles it"},
        ]})
        self.assertEqual((result["status"], result["finished"]), ("fixed", False))
        round_start(self.ledger)
        result = round_record(self.ledger, {"reviewers": reviewers(), "findings": [
            {"id": "F3", "priority": "P2", "title": "Repeat", "reporters": ["astra"],
             "disposition": "rejected", "evidence": "Same as F2"}]})
        self.assertEqual((result["status"], result["finished"]), ("clean", True))
        self.assertIn("| 2 | clean |", summary(load(self.ledger)))
        with self.assertRaisesRegex(ValueError, "already finished"):
            round_start(self.ledger)

    def test_incomplete_reviewers_never_finish(self):
        round_start(self.ledger)
        result = round_record(self.ledger, {"reviewers": reviewers(complete=False), "findings": []})
        self.assertEqual((result["status"], result["finished"]), ("incomplete", False))

    def test_rejects_invalid_results(self):
        round_start(self.ledger)
        bad = [
            {"reviewers": reviewers()[:3], "findings": []},
            {"reviewers": reviewers(), "findings": [
                {"id": "F1", "priority": "P1", "title": "x", "reporters": ["opus"],
                 "disposition": "rejected", "evidence": " "}]},
            {"reviewers": reviewers(), "findings": [
                {"id": "F1", "priority": "P1", "title": "x", "reporters": ["opus"],
                 "disposition": "deferred"}]},
            {"reviewers": reviewers(), "findings": [
                {"id": "F1", "priority": "P1", "title": "x", "reporters": ["opus"],
                 "disposition": "applied", "commits": [git(self.repo, "rev-parse", "HEAD")]}]},
        ]
        for result in bad:
            with self.subTest(result=result), self.assertRaisesRegex(ValueError, "Invalid"):
                round_record(self.ledger, result)

    def test_requires_committed_workspace(self):
        (self.repo / "a.txt").write_text("dirty\n")
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            round_start(self.ledger)
        git(self.repo, "checkout", "--", "a.txt")
        round_start(self.ledger)
        with self.assertRaisesRegex(ValueError, "still open"):
            round_start(self.ledger)

    def test_lists_worktrees(self):
        paths = [Path(entry["path"]).resolve() for entry in worktrees(self.repo)]
        self.assertEqual(paths, [self.repo.resolve()])


if __name__ == "__main__":
    unittest.main()
