import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import auto_review_pr_strict as strict
import post_text

PULL = "https://github.com/o/r/pull/5"
HEAD = "abc1234def" + "0" * 30
OLD = "1" * 40
BASE = "bbb2222"
PATCH = "@@ -10,4 +10,5 @@ def f():\n ctx\n-old\n+new\n+added\n ctx2\n"
FILES = [{"filename": "src/a.py", "patch": PATCH}, {"filename": "img.png"}]
PANEL = (
    "> [!NOTE]\n> This text was written and posted fully automatically by AI.\n>\n"
    f"{strict.WORKFLOW_LINE}\n> - Harness: T3 Code\n\nBody\n"
)


def pull(sha=HEAD, author="author", state="open", draft=False, merged=False):
    return {
        "head": {"sha": sha}, "base": {"sha": BASE}, "user": {"login": author}, "title": "T",
        "state": state, "draft": draft, "merged": merged,
    }


def finding(priority="P1", title="Bug", kind="behavior", **location):
    return {
        "kind": kind, "priority": priority, "title": title, "problem": f"{title} breaks parsing.",
        "evidence": {"command": "python3 -c 'f()'", "base": "ok", "head": "Traceback: boom"}, **location,
    }


def review(review_id, commit, state="CHANGES_REQUESTED", login="me", body=PANEL):
    return {
        "id": review_id, "commit_id": commit, "state": state, "user": {"login": login},
        "body": body, "html_url": f"{PULL}#pullrequestreview-{review_id}",
    }


def run_render(findings, login="me", author="author", comment_only=None):
    responses = [pull(author=author), {"login": login}, FILES, pull()]
    data = {"summary": "Adds a parser.", "base": BASE, "findings": findings}
    with mock.patch.object(post_text, "gh_api", side_effect=responses):
        return strict.render(data, PULL, HEAD[:10], comment_only)


class LedgerCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.ledger = Path(self.directory.name) / "state" / "ledger.jsonl"
        patcher = mock.patch.dict(os.environ, {"AUTO_REVIEW_PR_STRICT_LEDGER": str(self.ledger)})
        patcher.start()
        self.addCleanup(patcher.stop)


class GateTests(unittest.TestCase):
    def test_rejects_findings_that_do_not_pass_the_gate(self):
        no_evidence = finding()
        del no_evidence["evidence"]
        same = finding()
        same["evidence"] = {"command": "x", "base": "ok", "head": "ok"}
        partial = finding()
        partial["evidence"] = {"command": "x", "head": "bad"}
        for bad in (
            finding(priority="P2"), finding(priority="P3"), finding(kind="style"), no_evidence, same, partial,
            {**finding(), "class": "follow-up"}, {**finding(), "body": "free text"}, finding(path="src/a.py"),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                strict.load_findings({"summary": "S", "base": BASE, "findings": [bad]})

    def test_rejects_an_empty_list_and_a_missing_base(self):
        with self.assertRaisesRegex(ValueError, "post nothing"):
            strict.load_findings({"summary": "S", "base": BASE, "findings": []})
        with self.assertRaisesRegex(ValueError, "base"):
            strict.load_findings({"summary": "S", "findings": [finding()]})

    def test_sorts_by_priority(self):
        _, _, findings = strict.load_findings({"summary": "S", "base": BASE, "findings": [
            finding("P1", "B"), finding("P0", "A"),
        ]})
        self.assertEqual([item["title"] for item in findings], ["A", "B"])


class RenderTests(unittest.TestCase):
    def test_inline_comments_carry_the_evidence(self):
        outputs, plan = run_render([
            finding("P1", "Inline", path="src/a.py", line=11),
            finding("P0", "Outside", kind="check", path="src/a.py", line=40),
            finding("P1", "Whole"),
        ])
        comments = json.loads(outputs["comments.json"])
        self.assertEqual(len(comments), 1)
        body = comments[0]["body"]
        self.assertTrue(body.startswith("**Regression · P1 · Inline**\n\n_This pull request introduces"))
        self.assertIn("```sh\npython3 -c 'f()'\n```", body)
        self.assertIn(f"Base (`{BASE}`):\n\n```text\nok\n```", body)
        self.assertIn(f"Head (`{HEAD[:12]}`):\n\n```text\nTraceback: boom\n```", body)
        self.assertEqual(plan["event"], "REQUEST_CHANGES")
        self.assertEqual(plan["head"], HEAD)
        self.assertEqual([item["title"] for item in plan["body"]], ["Outside", "Whole"])

        text = outputs["review-body.md"]
        self.assertTrue(text.startswith(f"Adds a parser.\n\nReviewed commit: `{HEAD}`\n"))
        self.assertIn("Problems found: 3 (1 inline).", text)
        self.assertIn("- **Broken check · P0 · Outside** — `src/a.py:40`", text)
        self.assertIn("  Outside breaks parsing.", text)
        self.assertNotIn("Inline breaks parsing", text)
        self.assertNotIn("follow-up", text.lower())

        normalized = [post_text.normalize_comment(i, c) for i, c in enumerate(comments)]
        self.assertEqual(post_text.diff_problems(normalized, FILES), [])

    def test_own_pull_request_and_comment_only_give_a_comment_with_a_note(self):
        outputs, plan = run_render([finding(path="src/a.py", line=11)], login="me", author="me")
        self.assertEqual(plan["event"], "COMMENT")
        self.assertIn("posted as a comment because GitHub does not let the account me", outputs["review-body.md"])
        outputs, plan = run_render([finding(path="src/a.py", line=11)], comment_only="AGENTS.md forbids it.")
        self.assertEqual(plan["event"], "COMMENT")
        self.assertIn("because AGENTS.md forbids it.\n", outputs["review-body.md"])

    def test_stops_when_the_head_moved(self):
        data = {"summary": "S", "base": BASE, "findings": [finding()]}
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("f" * 40)]):
            with self.assertRaisesRegex(RuntimeError, "Do not post"):
                strict.render(data, PULL, HEAD)

    def test_fence_survives_backticks(self):
        self.assertEqual(strict.fence("a ``` b", "sh"), "````sh\na ``` b\n````")


class CheckTests(LedgerCase):
    def run_check(self, responses, include_draft=False):
        with mock.patch.object(post_text, "gh_api", side_effect=responses):
            return strict.check(PULL, include_draft)

    def test_skips_closed_merged_and_draft(self):
        self.assertIn("closed", self.run_check([pull(state="closed"), {"login": "me"}])["reason"])
        self.assertIn("merged", self.run_check([pull(state="closed", merged=True), {"login": "me"}])["reason"])
        self.assertIn("draft", self.run_check([pull(draft=True), {"login": "me"}])["reason"])

    def test_skips_a_head_in_the_ledger(self):
        strict.record(PULL, HEAD, "no-findings")
        result = self.run_check([pull(), {"login": "me"}])
        self.assertEqual(result["decision"], "skip")
        self.assertIn("ledger", result["reason"])

    def test_skips_a_head_this_workflow_reviewed_on_github(self):
        reviews = [review(7, HEAD, state="COMMENTED")]
        result = self.run_check([pull(), {"login": "me"}, reviews])
        self.assertEqual(result["decision"], "skip")
        self.assertIn("pullrequestreview-7", result["reason"])

    def test_ignores_other_accounts_and_other_workflows(self):
        reviews = [
            review(1, HEAD, login="someone"),
            review(2, HEAD, body=PANEL.replace(strict.WORKFLOW, "Auto Review PR")),
            review(3, HEAD, body="Mentions > - Workflow: Auto Review PR Strict inline"),
        ]
        result = self.run_check([pull(), {"login": "me"}, reviews, pull()])
        self.assertEqual((result["decision"], result["earlierChangeRequests"]), ("review", []))

    def test_lists_earlier_change_requests_with_their_comments(self):
        reviews = [review(4, OLD), review(5, OLD, state="DISMISSED")]
        comments = [{"path": "src/a.py", "original_line": 11, "body": "**Regression · P1 · Bug**"}]
        result = self.run_check([pull(), {"login": "me"}, reviews, comments, pull()])
        self.assertEqual(result["decision"], "review")
        self.assertEqual([item["id"] for item in result["earlierChangeRequests"]], [4])
        self.assertEqual(result["earlierChangeRequests"][0]["comments"][0]["line"], 11)

    def test_skips_when_the_head_moves_during_the_check(self):
        result = self.run_check([pull(), {"login": "me"}, [], pull("f" * 40)])
        self.assertIn("head changed", result["reason"])


class RecordTests(LedgerCase):
    def test_appends_entries(self):
        strict.record(PULL, HEAD, "posted", f"{PULL}#pullrequestreview-9", ["Bug"])
        strict.record(PULL, OLD, "no-findings")
        entries = strict.read_ledger(self.ledger)
        self.assertEqual([entry["outcome"] for entry in entries], ["posted", "no-findings"])
        self.assertEqual(entries[0]["key"], f"github.com/o/r#5@{HEAD}")
        self.assertEqual(entries[0]["findings"], ["Bug"])

    def test_rejects_bad_input(self):
        for args in (
            (PULL, HEAD[:10], "no-findings"), (PULL, HEAD, "skipped"), (PULL, HEAD, "posted"),
            (PULL, HEAD, "no-findings", "https://x"),
        ):
            with self.subTest(args=args), self.assertRaises(ValueError):
                strict.record(*args)
        self.assertFalse(self.ledger.exists())

    def test_ignores_broken_lines(self):
        self.ledger.parent.mkdir(parents=True)
        self.ledger.write_text('not json\n{"key": "k"}\n[1]\n', encoding="utf-8")
        self.assertEqual(strict.read_ledger(self.ledger), [{"key": "k"}])


class PanelTests(unittest.TestCase):
    def test_the_auto_post_text_panel_names_this_workflow_on_its_own_line(self):
        import sys
        sys.path.insert(0, str(strict.SKILLS / "auto-post-text" / "scripts"))
        import auto_post_text
        body = auto_post_text.prepare("Body", ["T3 Code"], ["coordinator: x"], strict.WORKFLOW).decode("utf-8")
        self.assertIn(strict.WORKFLOW_LINE, body.split("\n"))


class DismissTests(unittest.TestCase):
    def test_dismisses_only_older_change_requests_of_this_workflow(self):
        reviews = [
            review(1, OLD), review(2, HEAD), review(3, OLD, state="COMMENTED"),
            review(4, OLD, login="someone"), review(5, OLD), review(6, OLD),
        ]
        calls = []

        def fake(host, *args, payload=None, paginate=False):
            calls.append((args, payload))
            if args and args[0] == f"repos/o/r/pulls/5":
                return pull()
            if args == ("user",):
                return {"login": "me"}
            if args and args[0].endswith("/reviews?per_page=100"):
                return reviews
            if args and args[0] == "--method":
                return {}
            return {"state": "DISMISSED"}

        with mock.patch.object(post_text, "gh_api", side_effect=fake):
            results = strict.dismiss_stale(PULL, HEAD, keep=["6"])
        self.assertEqual(
            [(item["id"], item["result"]) for item in results], [(1, "dismissed"), (5, "dismissed"), (6, "kept")],
        )
        puts = [(args, payload) for args, payload in calls if args and args[0] == "--method"]
        self.assertEqual([args[2] for args, _ in puts], [
            "repos/o/r/pulls/5/reviews/1/dismissals", "repos/o/r/pulls/5/reviews/5/dismissals",
        ])
        self.assertIn(HEAD, puts[0][1]["message"])

    def test_refuses_when_the_head_moved_or_the_dismissal_did_not_hold(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull("f" * 40)]):
            with self.assertRaisesRegex(RuntimeError, "Dismiss nothing"):
                strict.dismiss_stale(PULL, HEAD)
        responses = [pull(), {"login": "me"}, [review(1, OLD)], {}, {"state": "CHANGES_REQUESTED"}]
        with mock.patch.object(post_text, "gh_api", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "not DISMISSED"):
                strict.dismiss_stale(PULL, HEAD)


if __name__ == "__main__":
    unittest.main()
