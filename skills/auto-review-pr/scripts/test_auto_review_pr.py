import json
import unittest
from unittest import mock

import auto_review_pr
from auto_review_pr import load_findings, render
import post_text

PULL = "https://github.com/o/r/pull/5"
HEAD = "abc1234def"
PATCH = "@@ -10,4 +10,5 @@ def f():\n ctx\n-old\n+new\n+added\n ctx2\n"
FILES = [{"filename": "src/a.py", "patch": PATCH}, {"filename": "img.png"}]


def pull(sha=HEAD, author="author"):
    return {"head": {"sha": sha}, "user": {"login": author}}


def finding(kind="request-changes", priority="P1", title="Bug", **location):
    return {"class": kind, "priority": priority, "title": title, "body": f"{title} details.", **location}


def run(findings, login="me", author="author", comment_only=None, summary="Adds a parser."):
    responses = [pull(author=author), {"login": login}, FILES, pull()]
    with mock.patch.object(post_text, "gh_api", side_effect=responses):
        return render({"summary": summary, "findings": findings}, PULL, HEAD, comment_only)


class LoadTests(unittest.TestCase):
    def test_sorts_request_changes_first_then_priority(self):
        _, findings = load_findings({"summary": "S", "findings": [
            finding("follow-up", "P0", "A"), finding("request-changes", "P3", "B"),
            finding("request-changes", "P1", "C"),
        ]})
        self.assertEqual([item["title"] for item in findings], ["C", "B", "A"])

    def test_rejects_bad_findings(self):
        for bad in (
            finding(kind="regression"), finding(priority="P5"), finding(title=""),
            {**finding(), "body": " "}, finding(path="src/a.py"), finding(line=3),
            {**finding(), "severity": "high"}, finding(path="/abs", line=1),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                load_findings({"summary": "S", "findings": [bad]})
        for data in ({"findings": []}, {"summary": "S"}, {"summary": "S", "findings": [], "x": 1}, []):
            with self.subTest(data=data), self.assertRaises(ValueError):
                load_findings(data)


class RenderTests(unittest.TestCase):
    def test_places_every_finding_on_the_diff_inline(self):
        outputs, plan = run([
            finding("request-changes", "P1", "Inline bug", path="src/a.py", line=11),
            finding("follow-up", "P3", "Context line", path="src/a.py", line=10),
            finding("request-changes", "P2", "Removed check", path="src/a.py", line=11, side="LEFT"),
            finding("follow-up", "P2", "Outside", path="src/a.py", line=40),
            finding("follow-up", "P3", "Binary", path="img.png", line=1),
            finding("request-changes", "P2", "Whole change"),
        ])
        comments = json.loads(outputs["comments.json"])
        self.assertEqual([c["line"] for c in comments], [11, 11, 10])
        self.assertEqual(comments[1]["side"], "LEFT")
        self.assertTrue(comments[0]["body"].startswith("**Request changes · P1 · Inline bug**\n\n_This pull request introduces"))
        self.assertTrue(comments[2]["body"].startswith("**Optional follow-up · P3 · Context line**\n\n_This pull request does not"))
        self.assertEqual([item["title"] for item in plan["body"]], ["Whole change", "Outside", "Binary"])
        self.assertIn("not in the pull request diff", plan["body"][1]["reason"])
        self.assertIn("no diff", plan["body"][2]["reason"])
        self.assertEqual(plan["event"], "REQUEST_CHANGES")
        self.assertEqual(plan["counts"], {"request-changes": 3, "follow-up": 3})

        body = outputs["review-body.md"]
        self.assertTrue(body.startswith("Adds a parser.\n\nReviewed commit: `abc1234def`\n"))
        self.assertIn("- Request changes: 3 (2 inline)\n- Optional follow-ups: 3 (1 inline)", body)
        self.assertIn("### Request changes\n\nThis pull request introduces these problems.", body)
        self.assertIn("- **P2 · Whole change** — the whole change\n\n  Whole change details.", body)
        self.assertIn("- **P2 · Outside** — `src/a.py:40`", body)
        self.assertNotIn("Inline bug details", body)
        self.assertFalse(body.startswith("> [!NOTE]"))

    def test_findings_inline_never_repeat_in_the_body(self):
        outputs, plan = run([finding(path="src/a.py", line=12)])
        self.assertIn("Inline comments on the diff: 1.", outputs["review-body.md"])
        self.assertNotIn("cannot be inline", outputs["review-body.md"])
        self.assertNotIn("Bug details", outputs["review-body.md"])
        self.assertEqual(plan["body"], [])

    def test_only_follow_ups_give_a_comment(self):
        _, plan = run([finding("follow-up", path="src/a.py", line=11)])
        self.assertEqual((plan["event"], plan["eventNote"]), ("COMMENT", None))

    def test_no_findings_still_gives_a_review(self):
        outputs, plan = run([])
        self.assertEqual(plan["event"], "COMMENT")
        self.assertIn("No reportable problems were found", outputs["review-body.md"])
        self.assertEqual(json.loads(outputs["comments.json"]), [])

    def test_own_pull_request_and_comment_only_downgrade_with_a_note(self):
        outputs, plan = run([finding(path="src/a.py", line=11)], login="me", author="me")
        self.assertEqual(plan["event"], "COMMENT")
        self.assertIn("posted as a comment because GitHub does not let the account me", outputs["review-body.md"])
        outputs, plan = run([finding(path="src/a.py", line=11)], comment_only="AGENTS.md forbids change requests.")
        self.assertEqual(plan["event"], "COMMENT")
        self.assertIn("because AGENTS.md forbids change requests.\n", outputs["review-body.md"])

    def test_stops_when_the_head_moved(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("fff0000")]):
            with self.assertRaisesRegex(RuntimeError, "Do not post"):
                render({"summary": "S", "findings": []}, PULL, HEAD)
        responses = [pull(), {"login": "me"}, FILES, pull("fff0000")]
        with mock.patch.object(post_text, "gh_api", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "changed while"):
                render({"summary": "S", "findings": []}, PULL, HEAD)

    def test_accepts_an_abbreviated_head_and_reports_the_full_one(self):
        responses = [pull(), {"login": "me"}, FILES, pull()]
        with mock.patch.object(post_text, "gh_api", side_effect=responses):
            _, plan = render({"summary": "S", "findings": []}, PULL, "abc1234")
        self.assertEqual(plan["head"], HEAD)

    def test_inline_comments_pass_the_post_text_checks(self):
        outputs, _ = run([finding(path="src/a.py", start_line=10, line=12)])
        comments = [post_text.normalize_comment(i, c) for i, c in enumerate(json.loads(outputs["comments.json"]))]
        self.assertEqual(post_text.diff_problems(comments, FILES), [])

    def test_module_reuses_post_text(self):
        self.assertIs(auto_review_pr.post_text, post_text)


if __name__ == "__main__":
    unittest.main()
