import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from autofix import attribution, gate, intake, parse_issue, reference
from iterate_with_review import init, load, round_record, round_start


def git(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", "-C", str(repo), *args], check=True, env=env,
                          capture_output=True, text=True).stdout.strip()


def reviewers(complete=True):
    return [{"slug": slug, "complete": complete, "verdict": "right-direction"}
            for slug in ("astra", "sol", "opus", "sonnet")]


class IssueTests(unittest.TestCase):
    def test_parses_github_and_linear_urls(self):
        github = parse_issue("https://github.com/kdy1/repo/issues/12#issuecomment-1")
        self.assertEqual((github["repository"], github["number"]), ("kdy1/repo", 12))
        self.assertEqual(reference(github), "Closes https://github.com/kdy1/repo/issues/12")
        linear = parse_issue("https://linear.app/acme/issue/eng-42/fix-the-thing")
        self.assertEqual((linear["workspace"], linear["team"], linear["identifier"]),
                         ("acme", "ENG", "ENG-42"))
        self.assertEqual(reference(linear), "Closes ENG-42")
        for bad in ("https://github.com/kdy1/repo/pull/12", "kdy1/repo#12"):
            with self.subTest(url=bad), self.assertRaises(ValueError):
                parse_issue(bad)

    def test_intake_writes_intent_with_comments(self):
        details = {"title": "Crash", "body": "It crashes.", "state": "OPEN", "linkedPullRequests": [],
                   "comments": [{"author": "kdy1", "body": "Only on empty input.", "url": None}]}
        with tempfile.TemporaryDirectory() as tmp:
            info = intake("https://github.com/kdy1/repo/issues/3", tmp, fetch=lambda issue: details)
            text = Path(info["intentFile"]).read_text()
        self.assertFalse(info["closed"])
        self.assertIn("Issue: https://github.com/kdy1/repo/issues/3", text)
        self.assertIn("Comment by kdy1:\nOnly on empty input.", text)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "src"
        git(root, "init", "--quiet", "-b", "main", str(self.repo))
        (self.repo / "a.txt").write_text("one\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "--quiet", "-m", "base")
        git(self.repo, "switch", "--quiet", "-c", "fix")
        self.commit("two\n")
        self.ledger = root / "ledger.json"
        init(str(self.repo), base="main", ledger_path=self.ledger)

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, text):
        (self.repo / "a.txt").write_text(text)
        git(self.repo, "commit", "--quiet", "-am", "change")
        return git(self.repo, "rev-parse", "HEAD")

    def clean_round(self):
        round_start(self.ledger)
        round_record(self.ledger, {"reviewers": reviewers(), "findings": []})

    def test_gate_blocks_until_a_clean_round(self):
        with self.assertRaisesRegex(ValueError, "clean round"):
            gate(self.ledger)
        round_start(self.ledger)
        fix = self.commit("three\n")
        round_record(self.ledger, {"reviewers": reviewers(), "findings": [
            {"id": "R1-F1", "priority": "P2", "title": "t", "reporters": ["opus"],
             "disposition": "applied", "commits": [fix]}]})
        with self.assertRaisesRegex(ValueError, "clean round"):
            gate(self.ledger)
        self.clean_round()
        result = gate(self.ledger)
        self.assertEqual((result["head"], result["rounds"], result["base"]), (fix, 2, "main"))

    def test_gate_blocks_commits_and_edits_after_the_clean_round(self):
        self.clean_round()
        (self.repo / "a.txt").write_text("dirty\n")
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            gate(self.ledger)
        git(self.repo, "commit", "--quiet", "-am", "late")
        with self.assertRaisesRegex(ValueError, "not the clean round's commit"):
            gate(self.ledger)

    def test_attribution_lists_fixer_and_reviewers(self):
        self.clean_round()
        footer = attribution("Claude Code", "claude-opus-5-5", "high", load(self.ledger))
        self.assertEqual(footer, "<sub>Autofix — Harness: Claude Code; Model: claude-opus-5-5; "
                                 "Reasoning effort: high; Review: Iterate with Review, 1 round; "
                                 "Reviewers: codex/gpt-6-astra, codex/gpt-6.1-sol, "
                                 "claudeAgent/claude-opus-5-5, claudeAgent/claude-sonnet-5-5</sub>")
        self.assertEqual(attribution("", "<x>"), "<sub>Autofix — Harness: unknown; Model: &lt;x&gt;</sub>")


if __name__ == "__main__":
    unittest.main()
