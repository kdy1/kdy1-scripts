"""Offline checks using synthetic PRs only; no GitHub requests."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import unittest
from unittest.mock import patch

import daily_update as daily


def pr(number, **changes):
    record = {
        "number": number, "title": "fix: retain `value`", "state": "OPEN",
        "url": f"https://github.com/example/demo/pull/{number}",
        "repository": {"nameWithOwner": "example/demo"},
        "author": {"login": "sample-user"}, "isDraft": False, "body": "",
        "mergedAt": None, "closedAt": None, "updatedAt": "2026-11-04T16:00:00Z",
    }
    record.update(changes)
    return record


def page(records, count=None, cursor=None):
    return {"data": {"search": {
        "issueCount": len(records) if count is None else count,
        "nodes": records,
        "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor},
    }}}


class DailyUpdateTests(unittest.TestCase):
    def setUp(self):
        self.day, self.start, self.end = daily.day_bounds("2026-11-05", "Asia/Seoul")

    def test_timezone_boundaries_and_daylight_saving(self):
        self.assertEqual(daily.stamp(self.start), "2026-11-04T15:00:00Z")
        self.assertEqual(daily.stamp(self.end), "2026-11-05T15:00:00Z")
        _, start, end = daily.day_bounds("2026-03-08", "America/New_York")
        self.assertEqual((end - start).total_seconds(), 23 * 3600)
        _, start, end = daily.day_bounds("2026-11-01", "America/New_York")
        self.assertEqual((end - start).total_seconds(), 25 * 3600)

    def test_classifies_by_event_and_excludes_other_authors_and_old_activity(self):
        records = [
            pr(1, state="MERGED", mergedAt="2026-11-04T15:00:00Z",
               closedAt="2026-11-04T15:00:00Z", updatedAt="2026-11-10T00:00:00Z"),
            pr(2, isDraft=True),
            pr(3, state="CLOSED", closedAt="2026-11-05T14:59:59Z"),
            pr(4, updatedAt="2026-11-04T14:59:59Z"),
            pr(5, updatedAt="2026-11-05T15:00:00Z"),
            pr(6, author={"login": "someone-else"}),
            pr(7, state="MERGED", mergedAt="2026-11-03T00:00:00Z"),
            pr(8, state="CLOSED", closedAt="2026-11-03T00:00:00Z"),
            pr(9, author=None),
        ]
        sections = daily.classify(records, "SAMPLE-USER", self.start, self.end)
        self.assertEqual({key: [p["number"] for p in value] for key, value in sections.items()},
                         {"Merged": [1], "WIP": [2], "Closed": [3]})

    def test_pagination_and_event_search(self):
        with patch.object(daily, "gh_json", side_effect=[
            page([pr(1)], count=2, cursor="next"), page([pr(2)], count=2)
        ]) as request:
            records = daily.search_prs("example/demo", "sample-user", self.start,
                                      self.end, "is:merged", "merged")
        self.assertEqual(len(records), 2)
        self.assertIn("cursor=next", request.call_args.args)
        search = next(arg for arg in request.call_args.args if arg.startswith("search="))
        self.assertIn("author:sample-user is:merged", search)
        self.assertIn("merged:2026-11-04T15:00:00Z..2026-11-05T14:59:59Z", search)

    def test_incomplete_search_and_limit_fail(self):
        for result in [page([], count=1), page([], count=1001), page([None])]:
            with self.subTest(result=result), patch.object(daily, "gh_json", return_value=result):
                with self.assertRaises(RuntimeError):
                    daily.search_prs("example/demo", "sample-user", self.start,
                                     self.end, "is:open", "updated")

    def test_repeated_cursor_fails(self):
        with patch.object(daily, "gh_json", return_value=page([pr(1)], cursor="same")):
            with self.assertRaisesRegex(RuntimeError, "pagination"):
                daily.search_prs("example/demo", "sample-user", self.start,
                                 self.end, "is:open", "updated")

    def test_extra_update_and_inline_code_are_preserved(self):
        sections = daily.classify([pr(2, isDraft=True)], "sample-user", self.start, self.end)
        extra = "Team notes:\n\n - Keep `alpha` and **beta**.\n"
        output = daily.render(sections, extra)
        self.assertTrue(output.endswith("\n---\n\n" + extra))
        self.assertIn(" - [example/demo#2](https://github.com/example/demo/pull/2) (draft)\n", output)
        self.assertNotIn("fix: retain", output)
        self.assertIn("Merged:\n - None.", output)
        self.assertNotIn("\n---\n", daily.render(sections))

    def test_cli_collects_all_categories_and_deduplicates_repositories(self):
        args = ["daily_update.py", "--repo", "example/demo", "--repo", "EXAMPLE/demo",
                "--date", "2026-11-05", "--timezone", "Asia/Seoul", "--json"]
        responses = [{"login": "sample-user"}, {"full_name": "example/demo"},
                     page([]), page([pr(2)]), page([])]
        stdout = io.StringIO()
        with patch("sys.argv", args), patch.object(daily, "gh_json", side_effect=responses) as request:
            with redirect_stdout(stdout):
                self.assertEqual(daily.main(), 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["repositories"], ["example/demo"])
        self.assertEqual(len(result["sections"]["WIP"]), 1)
        queries = [arg for call in request.call_args_list for arg in call.args if arg.startswith("search=")]
        self.assertEqual(len(queries), 3)
        self.assertIn("is:closed is:unmerged closed:", queries[2])

    def test_cli_failure_does_not_emit_partial_update(self):
        args = ["daily_update.py", "--repo", "example/demo", "--repo", "example/private"]
        responses = [{"login": "sample-user"}, {}, page([]), page([]), page([]),
                     RuntimeError("repository unavailable")]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("sys.argv", args), patch.object(daily, "gh_json", side_effect=responses):
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(daily.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("repository unavailable", stderr.getvalue())

    def test_graphql_errors_fail_even_when_process_exits_successfully(self):
        response = type("Response", (), {"returncode": 0, "stderr": "", "stdout":
                                        '{"errors": [{"message": "rate limited"}]}'} )()
        with patch.object(daily.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "rate limited"):
                daily.gh_json("api", "graphql")


if __name__ == "__main__":
    unittest.main()
