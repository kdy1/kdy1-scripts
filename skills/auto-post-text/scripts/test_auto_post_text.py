import json
import unittest
from unittest import mock

import auto_post_text
from auto_post_text import AUTOMATED, prepare, prepare_review
import post_text

PULL = "https://github.com/o/r/pull/5"
FILES = [{"filename": "src/a.py", "patch": "@@ -1,2 +1,3 @@\n a\n+b\n c\n"}]


def pull(sha, author="author"):
    return {"head": {"sha": sha}, "user": {"login": author}}


class PrepareTests(unittest.TestCase):
    def test_panel_says_the_text_was_posted_without_human_review(self):
        body = prepare("Body.", ["T3 Code"], ["Claude Opus 5.5 (claude-opus-5-5)"], "Auto Review PR").decode()
        self.assertEqual(
            body,
            "> [!NOTE]\n"
            f"> {AUTOMATED}\n"
            ">\n"
            "> - Workflow: Auto Review PR\n"
            "> - Harness: T3 Code\n"
            "> - AI agent: Claude Opus 5.5 (claude-opus-5-5)\n"
            "\nBody.\n",
        )
        self.assertIn("fully automatically", AUTOMATED)
        self.assertIn("No human reviewed it", AUTOMATED)

    def test_workflow_line_is_optional(self):
        self.assertNotIn("Workflow", prepare("Body.", ["H"], ["A"]).decode())

    def test_rejects_missing_provenance(self):
        with self.assertRaises(ValueError):
            prepare("Body.", [], ["A"])


class ReviewTests(unittest.TestCase):
    def test_review_uses_the_automatic_panel_and_the_reviewed_head(self):
        comments = [{"path": "src/a.py", "line": 2, "body": "Problem."}]
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), FILES, pull("abc")]):
            data = prepare_review("Summary", comments, PULL, "abc", ["H"], ["A"], "COMMENT", "Auto Review PR")
        review = json.loads(data)
        self.assertTrue(review["body"].startswith(f"> [!NOTE]\n> {AUTOMATED}\n>\n> - Workflow: Auto Review PR\n"))
        self.assertEqual(review["commit_id"], "abc")
        self.assertEqual(len(review["comments"]), 1)

    def test_review_stops_when_the_head_moved(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("new")]):
            with self.assertRaisesRegex(RuntimeError, "reviewed commit abc"):
                prepare_review("Summary", [], PULL, "abc", ["H"], ["A"])

    def test_review_needs_a_head(self):
        with self.assertRaises(ValueError):
            prepare_review("Summary", [], PULL, " ", ["H"], ["A"])

    def test_module_reuses_post_text(self):
        self.assertIs(auto_post_text.post_text, post_text)


if __name__ == "__main__":
    unittest.main()
