import json
import unittest
from unittest import mock

from post_review import author_role, choose_verdict, leaning, load_findings, render
import post_text

PULL = "https://github.com/o/r/pull/5"
HEAD = "abc1234def"
PATCH = "@@ -10,4 +10,5 @@ def f():\n ctx\n-old\n+new\n+added\n ctx2\n"
FILES = [{"filename": "src/a.py", "patch": PATCH}, {"filename": "img.png"}]


def pull(sha=HEAD, author="author", association="MEMBER", state="open"):
    return {
        "head": {"sha": sha}, "user": {"login": author}, "author_association": association,
        "state": state, "merged_at": None,
    }


def finding(priority="P1", title="Bug", **location):
    return {"priority": priority, "title": title, "body": f"{title} details.", **location}


def run(findings, association="MEMBER", login="me", author="author", role=None, comment_only=None):
    responses = [pull(author=author, association=association), {"login": login}, FILES, pull()]
    with mock.patch.object(post_text, "gh_api", side_effect=responses):
        return render({"summary": "Adds a parser.", "findings": findings}, PULL, HEAD, role, comment_only)


class PolicyTests(unittest.TestCase):
    def test_team_roles_come_from_the_author_association(self):
        for association in ("OWNER", "MEMBER", "COLLABORATOR"):
            self.assertEqual(author_role({"author_association": association})[0], "team")
        for association in ("CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", None):
            self.assertEqual(author_role({"author_association": association})[0], "external")
        self.assertEqual(author_role({"author_association": "NONE"}, "team")[0], "team")
        with self.assertRaises(ValueError):
            author_role({}, "staff")

    def test_verdict_policy(self):
        cases = [
            (["P0"], "team", "request-changes"),
            (["P1", "P3"], "team", "request-changes"),
            (["P1"], "external", "request-changes"),
            (["P2", "P3"], "team", "approve-with-changes"),
            (["P2"], "external", "request-changes"),
            (["P3"], "external", "approve"),
            (["P3"], "team", "approve"),
            ([], "external", "approve"),
        ]
        for priorities, role, expected in cases:
            with self.subTest(priorities=priorities, role=role):
                found = [{"priority": priority} for priority in priorities]
                self.assertEqual(choose_verdict(found, role), expected)


class LeaningTests(unittest.TestCase):
    def lean(self, priorities, association="MEMBER", role=None):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull(association=association)]):
            return leaning(PULL, priorities, role)

    def test_gives_the_approval_verdicts(self):
        cases = [
            (["P1", "P3"], "MEMBER", "Request changes"),
            (["P2"], "CONTRIBUTOR", "Request changes"),
            (["P2", "P3"], "MEMBER", "Approve with changes"),
            (["P3"], "NONE", "Approve"),
            ([], "NONE", "Approve"),
        ]
        for priorities, association, verdict in cases:
            with self.subTest(priorities=priorities, association=association):
                self.assertEqual(self.lean(priorities, association)["verdict"], verdict)
        result = self.lean(["P2", "P3", "P3"], "CONTRIBUTOR", "team")
        self.assertEqual(result["verdict"], "Approve with changes")
        self.assertEqual(result["author"]["role"], "team")
        self.assertEqual(result["counts"], {"P0": 0, "P1": 0, "P2": 1, "P3": 2})

    def test_rejects_unknown_priorities(self):
        with self.assertRaises(ValueError):
            leaning(PULL, ["P4"])


class LoadTests(unittest.TestCase):
    def test_allows_problem_statements_that_mention_fixes(self):
        load_findings({"summary": "S", "findings": [
            {**finding(), "body": "The change fixed the parser but the suggested fix in #3 is missing."},
        ]})

    def test_sorts_by_priority(self):
        _, findings = load_findings({"summary": "S", "findings": [finding("P3", "A"), finding("P0", "B")]})
        self.assertEqual([item["title"] for item in findings], ["B", "A"])

    def test_rejects_bad_findings(self):
        for bad in (
            finding(priority="P5"), finding(title=""), {**finding(), "body": " "},
            finding(path="src/a.py"), finding(line=3), {**finding(), "class": "follow-up"},
            finding(path="/abs", line=1),
            {**finding(), "body": "Crash.\n\nSuggested fix: check for None."},
            {**finding(), "body": "Crash.\n\n**Suggested fix:** check for None."},
            {**finding(), "body": "Crash.\n\n```suggestion\nif x is None:\n```"},
            {**finding(), "body": "Crash.\n\n~~~ Suggestion\nx\n~~~"},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                load_findings({"summary": "S", "findings": [bad]})
        for data in ({"findings": []}, {"summary": "S"}, {"summary": "S", "findings": [], "x": 1}, []):
            with self.subTest(data=data), self.assertRaises(ValueError):
                load_findings(data)


class RenderTests(unittest.TestCase):
    def test_team_p2_approves_with_changes_and_p3_does_not_block(self):
        outputs, plan = run([
            finding("P2", "Edge case", path="src/a.py", line=11),
            finding("P3", "Stale comment", path="src/a.py", line=10),
            finding("P3", "Outside", path="src/a.py", line=40),
        ])
        self.assertEqual((plan["verdict"], plan["event"], plan["eventNote"]), ("Approve with changes", "APPROVE", None))
        self.assertEqual(plan["author"], {
            "login": "author", "role": "team", "source": "GitHub author association: MEMBER",
        })
        comments = json.loads(outputs["comments.json"])
        self.assertEqual([c["line"] for c in comments], [11, 10])
        self.assertTrue(comments[0]["body"].startswith("**P2 · Fix before merge · Edge case**\n\nEdge case details."))
        self.assertIn("_Optional. This does not block the merge._", comments[1]["body"])
        body = outputs["review-body.md"]
        self.assertTrue(body.startswith("**Verdict: Approve with changes**\n\n"))
        self.assertIn("Fix the P2 items before merge. The P3 items are optional", body)
        self.assertIn("- P2 (fix before merge): 1 (1 inline)\n- P3 (non-blocking): 2 (1 inline)", body)
        self.assertIn("- **P3 · Non-blocking · Outside** — `src/a.py:40`\n\n  Outside details.", body)
        self.assertEqual(plan["body"][0]["reason"], "the line is not in the pull request diff.")
        self.assertNotIn("MEMBER", body)

    def test_unblocked_reviews_approve_without_a_flag(self):
        outputs, plan = run([finding("P2", "Edge case"), finding("P3", "Nit")])
        self.assertEqual((plan["verdict"], plan["event"], plan["eventNote"]), ("Approve with changes", "APPROVE", None))
        self.assertTrue(outputs["review-body.md"].startswith(
            "**Verdict: Approve with changes**\n\nThis review approves the pull request with changes. "
            "Fix the P2 items before merge. The P3 items are optional and do not block the merge.\n"
        ))
        self.assertNotIn("approve", plan)
        _, plan = run([finding("P3", "Nit")], association="NONE")
        self.assertEqual((plan["verdict"], plan["event"]), ("Approve", "APPROVE"))

    def test_external_p2_requests_changes(self):
        outputs, plan = run([finding("P2", "Edge case", path="src/a.py", line=11)], association="CONTRIBUTOR")
        self.assertEqual((plan["verdict"], plan["event"]), ("Request changes", "REQUEST_CHANGES"))
        self.assertIn("Fix the P2 items before merge.", outputs["review-body.md"])

    def test_role_override_changes_the_verdict(self):
        _, plan = run([finding("P2", "Edge case")], association="CONTRIBUTOR", role="team")
        self.assertEqual((plan["verdict"], plan["event"]), ("Approve with changes", "APPROVE"))
        self.assertIn("set by the human", plan["author"]["source"])

    def test_p1_requests_changes_for_team(self):
        outputs, plan = run([finding("P1", "Crash"), finding("P2", "Edge")])
        self.assertEqual(plan["event"], "REQUEST_CHANGES")
        body = outputs["review-body.md"]
        self.assertIn("Fix the blocking P0–P1 items and the P2 items before merge.", body)
        self.assertIn("- **P1 · Blocking · Crash** — the whole change", body)

    def test_p3_only_and_empty_reviews_approve(self):
        outputs, plan = run([finding("P3", "Nit")], association="NONE")
        self.assertEqual((plan["verdict"], plan["event"]), ("Approve", "APPROVE"))
        self.assertIn("The P3 items are optional and do not block the merge.", outputs["review-body.md"])
        outputs, plan = run([], association="NONE")
        self.assertEqual(plan["event"], "APPROVE")
        self.assertIn("It found no problems", outputs["review-body.md"])
        self.assertEqual(json.loads(outputs["comments.json"]), [])

    def test_own_pull_request_and_comment_only_post_as_comment(self):
        outputs, plan = run([finding("P1", "Crash")], login="author")
        self.assertEqual((plan["verdict"], plan["event"]), ("Request changes", "COMMENT"))
        self.assertIn("own pull request. The verdict above still applies.", outputs["review-body.md"])
        outputs, plan = run([], login="author")
        self.assertEqual((plan["verdict"], plan["event"]), ("Approve", "COMMENT"))
        self.assertIn("own pull request. The verdict above still applies.", outputs["review-body.md"])
        outputs, plan = run([], comment_only="AGENTS.md says never approve.")
        self.assertEqual((plan["verdict"], plan["event"]), ("Approve", "COMMENT"))
        self.assertIn(
            "posted as a comment because AGENTS.md says never approve. The verdict", outputs["review-body.md"],
        )

    def test_stops_when_the_head_moved_or_the_pull_request_is_closed(self):
        with mock.patch.object(post_text, "gh_api", side_effect=[pull(sha="fff9999")]):
            with self.assertRaisesRegex(RuntimeError, "not the reviewed commit"):
                render({"summary": "S", "findings": []}, PULL, HEAD)
        with mock.patch.object(post_text, "gh_api", side_effect=[pull(state="closed")]):
            with self.assertRaisesRegex(RuntimeError, "closed"):
                render({"summary": "S", "findings": []}, PULL, HEAD)


if __name__ == "__main__":
    unittest.main()
