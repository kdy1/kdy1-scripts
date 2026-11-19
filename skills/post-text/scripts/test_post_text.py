import json
import unittest
from unittest import mock

import post_text
from post_text import check, digest, parse_target, prepare


class PrepareTests(unittest.TestCase):
    def test_info_panel_is_on_top_and_names_harness_and_agent(self):
        body = prepare("## Title\n\nBody text.\n", ["T3 Code"], ["Claude Opus 5.5 (claude-opus-5-5)"]).decode("utf-8")
        self.assertEqual(
            body,
            "> [!NOTE]\n"
            "> This text was drafted with AI and posted after human approval.\n"
            ">\n"
            "> - Harness: T3 Code\n"
            "> - AI agent: Claude Opus 5.5 (claude-opus-5-5)\n"
            "\n## Title\n\nBody text.\n",
        )

    def test_several_harnesses_and_agents_use_plural_labels(self):
        body = prepare("Text", ["T3 Code", "Claude Code"], ["Model A", "Model B"]).decode("utf-8")
        self.assertIn("> - Harnesses: T3 Code, Claude Code\n", body)
        self.assertIn("> - AI agents: Model A, Model B\n", body)

    def test_rejects_missing_or_multiline_provenance(self):
        for harnesses, agents in (([], ["A"]), (["H"], []), ([" "], ["A"]), (["H"], ["A\nB"])):
            with self.subTest(harnesses=harnesses, agents=agents), self.assertRaises(ValueError):
                prepare("Text", harnesses, agents)

    def test_rejects_empty_text_and_existing_panel(self):
        with self.assertRaises(ValueError):
            prepare(" \n", ["H"], ["A"])
        with self.assertRaises(ValueError):
            prepare("> [!NOTE]\n> Old panel\n\nText", ["H"], ["A"])

    def test_normalizes_crlf(self):
        self.assertNotIn(b"\r", prepare("a\r\nb", ["H"], ["A"]))

    def test_other_statements_and_workflow_line(self):
        panel = post_text.info_panel(["H"], ["A"], "Posted automatically.", "Auto Review PR")
        self.assertEqual(
            panel,
            "> [!NOTE]\n> Posted automatically.\n>\n> - Workflow: Auto Review PR\n> - Harness: H\n> - AI agent: A\n",
        )
        for statement, workflow in (("", None), ("Two\nlines", None), ("S", " ")):
            with self.subTest(statement=statement, workflow=workflow), self.assertRaises(ValueError):
                post_text.info_panel(["H"], ["A"], statement, workflow)


class CheckTests(unittest.TestCase):
    def test_changed_text_requires_new_approval(self):
        body = prepare("Text", ["H"], ["A"])
        check(body, digest(body))
        with self.assertRaises(ValueError):
            check(body.replace(b"Text", b"Other"), digest(body))
        with self.assertRaises(ValueError):
            check(body, "not-a-digest")


class TargetTests(unittest.TestCase):
    def test_parses_issue_and_pull_urls(self):
        self.assertEqual(
            parse_target("https://github.com/o/r/pull/12#issuecomment-1"),
            {"host": "github.com", "owner": "o", "repo": "r", "number": "12"},
        )
        self.assertEqual(parse_target("https://ghe.example.com/o/r/issues/3")["host"], "ghe.example.com")

    def test_rejects_other_urls(self):
        for url in ("https://github.com/o/r", "https://github.com/o/r/discussions/1", "o/r#1"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_target(url)

    def test_post_reads_back_and_detects_mismatch(self):
        body = prepare("Text", ["H"], ["A"])
        created = {"id": 7, "html_url": "https://github.com/o/r/issues/1#issuecomment-7"}
        with mock.patch.object(post_text, "gh_api", side_effect=[created, {"body": body.decode()}]) as api:
            self.assertEqual(post_text.post(body, "https://github.com/o/r/issues/1"), created["html_url"])
        self.assertEqual(api.call_args_list[1].args, ("github.com", "repos/o/r/issues/comments/7"))
        with mock.patch.object(post_text, "gh_api", side_effect=[created, {"body": "changed"}]):
            with self.assertRaises(RuntimeError):
                post_text.post(body, "https://github.com/o/r/issues/1")


PATCH = "@@ -10,4 +10,5 @@ def f():\n ctx\n-old\n+new\n+added\n ctx2\n@@ -40,2 +41,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n"
FILES = [{"filename": "src/a.py", "patch": PATCH}, {"filename": "img.png"}]
PULL = "https://github.com/o/r/pull/5"


def pull(sha, author="author"):
    return {"head": {"sha": sha}, "user": {"login": author}}


class ReviewTests(unittest.TestCase):
    def test_commentable_lines_follow_both_sides_and_hunks(self):
        lines = post_text.commentable_lines(PATCH)
        self.assertEqual(lines[("RIGHT", 10)], 0)
        self.assertEqual(lines[("LEFT", 11)], 0)
        self.assertEqual(lines[("RIGHT", 12)], 0)
        self.assertEqual(lines[("RIGHT", 13)], 0)
        self.assertEqual(lines[("LEFT", 12)], 0)
        self.assertEqual(lines[("RIGHT", 42)], 1)
        self.assertNotIn(("RIGHT", 20), lines)
        self.assertNotIn(("RIGHT", 43), lines)

    def test_diff_problems_reports_lines_outside_the_diff(self):
        comments = [
            post_text.normalize_comment(0, {"path": "src/a.py", "line": 11, "body": "ok"}),
            post_text.normalize_comment(1, {"path": "src/a.py", "line": 20, "body": "x"}),
            post_text.normalize_comment(2, {"path": "other.py", "line": 1, "body": "x"}),
            post_text.normalize_comment(3, {"path": "img.png", "line": 1, "body": "x"}),
            post_text.normalize_comment(4, {"path": "src/a.py", "start_line": 12, "line": 42, "body": "x"}),
            post_text.normalize_comment(5, {"path": "src/a.py", "start_line": 10, "line": 13, "body": "ok"}),
        ]
        problems = post_text.diff_problems(comments, FILES)
        self.assertEqual(len(problems), 4)
        self.assertTrue(problems[0].startswith("comments[1] src/a.py:20 (RIGHT)"))
        self.assertIn("not changed", problems[1])
        self.assertIn("no diff", problems[2])
        self.assertIn("same diff hunk", problems[3])

    def test_normalize_comment_rejects_bad_input(self):
        for comment in (
            {"path": "a", "line": 0, "body": "x"},
            {"path": "/a", "line": 1, "body": "x"},
            {"path": "a", "line": 1, "body": " "},
            {"path": "a", "line": 1, "body": "x", "side": "UP"},
            {"path": "a", "line": 3, "start_line": 3, "body": "x"},
            {"path": "a", "line": 1, "body": "x", "start_side": "LEFT"},
            {"path": "a", "line": 1, "body": "x", "position": 2},
            {"path": "a", "line": True, "body": "x"},
        ):
            with self.subTest(comment=comment), self.assertRaises(ValueError):
                post_text.normalize_comment(0, comment)

    def test_prepare_review_writes_panel_head_and_comments(self):
        comments = [{"path": "src/a.py", "line": 12, "body": "Rename this.\r\n"}]
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), FILES, pull("abc")]):
            data = post_text.prepare_review("Summary", comments, PULL + "#x", ["H"], ["A"])
        review = json.loads(data)
        self.assertEqual(review["target"], PULL)
        self.assertEqual(review["commit_id"], "abc")
        self.assertEqual(review["event"], "COMMENT")
        self.assertTrue(review["body"].startswith("> [!NOTE]\n"))
        self.assertTrue(review["body"].endswith("\nSummary\n"))
        self.assertEqual(review["comments"], [{"path": "src/a.py", "line": 12, "side": "RIGHT", "body": "Rename this.\n"}])

    def test_prepare_review_rejects_issue_urls_moved_heads_and_bad_lines(self):
        with self.assertRaises(ValueError):
            post_text.prepare_review("S", [], "https://github.com/o/r/issues/5", ["H"], ["A"])
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), FILES, pull("def")]):
            with self.assertRaises(RuntimeError):
                post_text.prepare_review("S", [], PULL, ["H"], ["A"])
        bad = [{"path": "src/a.py", "line": 30, "body": "x"}]
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), FILES, pull("abc")]):
            with self.assertRaisesRegex(ValueError, "review body"):
                post_text.prepare_review("S", bad, PULL, ["H"], ["A"])

    def test_prepare_review_checks_the_expected_head(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("new")]) as api:
            with self.assertRaisesRegex(RuntimeError, "reviewed commit abc"):
                post_text.prepare_review("S", [], PULL, ["H"], ["A"], expected_head="abc")
        self.assertEqual(api.call_count, 1)
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), FILES, pull("abc")]):
            data = post_text.prepare_review(
                "S", [], PULL, ["H"], ["A"], statement="Automatic.", workflow="W", expected_head="abc",
            )
        self.assertTrue(json.loads(data)["body"].startswith("> [!NOTE]\n> Automatic.\n>\n> - Workflow: W\n"))

    def test_prepare_review_records_the_requested_event(self):
        for event in ("REQUEST_CHANGES", "APPROVE"):
            with self.subTest(event=event):
                responses = [pull("abc"), {"login": "me"}, FILES, pull("abc")]
                with mock.patch.object(post_text, "gh_api", side_effect=responses):
                    data = post_text.prepare_review("Summary", [], PULL, ["H"], ["A"], event)
                self.assertEqual(json.loads(data)["event"], event)

    def test_prepare_review_rejects_unknown_events_and_own_pull_requests(self):
        with self.assertRaisesRegex(ValueError, "review event"):
            post_text.prepare_review("S", [], PULL, ["H"], ["A"], "DISMISS")
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc", "me"), {"login": "me"}]) as api:
            with self.assertRaisesRegex(ValueError, "own pull request"):
                post_text.prepare_review("S", [], PULL, ["H"], ["A"], "REQUEST_CHANGES")
        self.assertEqual(api.call_count, 2)

    def review(self, event="COMMENT"):
        comments = [{"path": "src/a.py", "line": 12, "body": "Note ```code```"}]
        responses = [pull("abc"), FILES, pull("abc")]
        if event != "COMMENT":
            responses.insert(1, {"login": "me"})
        with mock.patch.object(post_text, "gh_api", side_effect=responses):
            return post_text.prepare_review("Summary", comments, PULL, ["H"], ["A"], event)

    def test_show_review_prints_destination_and_every_text(self):
        shown = post_text.show_review(self.review())
        self.assertIn(f"Destination: {PULL}", shown)
        self.assertIn("Review event: COMMENT (comment only: no approval and no change request)", shown)
        self.assertIn(
            "Review event: REQUEST_CHANGES (requests changes on the pull request)",
            post_text.show_review(self.review("REQUEST_CHANGES")),
        )
        self.assertIn("Inline comment 1: `src/a.py` line 12 (RIGHT)", shown)
        self.assertIn("````markdown\nNote ```code```\n````", shown)

    def test_post_review_submits_and_reads_back(self):
        data = self.review()
        review = json.loads(data)
        created = {"id": 9, "html_url": PULL + "#pullrequestreview-9"}
        posted_comments = [{"path": "src/a.py", "body": "Note ```code```\n"}]
        posted = {"body": review["body"], "state": "COMMENTED"}
        with mock.patch.object(
            post_text, "gh_api", side_effect=[pull("abc"), created, posted, posted_comments],
        ) as api:
            self.assertEqual(post_text.post_review(data), created["html_url"])
        submit = api.call_args_list[1]
        self.assertEqual(submit.args[3], "repos/o/r/pulls/5/reviews")
        self.assertEqual(submit.kwargs["payload"]["event"], "COMMENT")
        self.assertEqual(submit.kwargs["payload"]["commit_id"], "abc")
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), created, posted, []]):
            with self.assertRaises(RuntimeError):
                post_text.post_review(data)

    def test_post_review_submits_the_event_and_checks_the_state(self):
        data = self.review("REQUEST_CHANGES")
        review = json.loads(data)
        created = {"id": 9, "html_url": PULL + "#pullrequestreview-9"}
        posted_comments = [{"path": "src/a.py", "body": "Note ```code```\n"}]
        posted = {"body": review["body"], "state": "CHANGES_REQUESTED"}
        with mock.patch.object(
            post_text, "gh_api", side_effect=[pull("abc"), created, posted, posted_comments],
        ) as api:
            self.assertEqual(post_text.post_review(data), created["html_url"])
        self.assertEqual(api.call_args_list[1].kwargs["payload"]["event"], "REQUEST_CHANGES")
        commented = {"body": review["body"], "state": "COMMENTED"}
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("abc"), created, commented]):
            with self.assertRaisesRegex(RuntimeError, "state"):
                post_text.post_review(data)

    def test_post_review_refuses_a_moved_head_before_posting(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("new")]) as api:
            with self.assertRaisesRegex(RuntimeError, "approval again"):
                post_text.post_review(self.review())
        self.assertEqual(api.call_count, 1)

    def test_load_review_rejects_other_files(self):
        for data in (b"{}", b'{"kind": "github-pull-request-review", "event": "DISMISS"}'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                post_text.load_review(data)


if __name__ == "__main__":
    unittest.main()
