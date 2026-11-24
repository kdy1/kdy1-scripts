"""Offline checks using synthetic PRs only; no GitHub requests."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import unittest
from unittest.mock import patch

import activity_update as helper


def pr(number, **changes):
    record = {
        "number": number, "title": "fix: retain `value`", "state": "OPEN",
        "url": f"https://github.com/example/demo/pull/{number}",
        "repository": {"nameWithOwner": "example/demo"},
        "author": {"login": "sample-user"}, "isDraft": False, "body": "",
        "mergedAt": None, "closedAt": None, "updatedAt": "2026-11-04T16:00:00Z",
        "mergedBy": None, "reviews": {"totalCount": 0, "nodes": []},
        "lastClose": {"nodes": []},
    }
    record.update(changes)
    return record


def reviews(*items):
    nodes = [{"state": state, "submittedAt": at} for state, at in items]
    return {"totalCount": len(nodes), "nodes": nodes}


def last_close(login, at):
    return {"nodes": [{"createdAt": at, "actor": {"login": login} if login else None}]}


def page(records, count=None, cursor=None):
    return {"data": {"search": {
        "issueCount": len(records) if count is None else count,
        "nodes": records,
        "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor},
    }}}


class ActivityUpdateTests(unittest.TestCase):
    def setUp(self):
        _, _, self.start, self.end = helper.period_bounds("2026-11-05", "2026-11-05", "Asia/Seoul")

    def test_timezone_boundaries_and_daylight_saving(self):
        self.assertEqual(helper.stamp(self.start), "2026-11-04T15:00:00Z")
        self.assertEqual(helper.stamp(self.end), "2026-11-05T15:00:00Z")
        _, _, start, end = helper.period_bounds("2026-03-08", "2026-03-08", "America/New_York")
        self.assertEqual((end - start).total_seconds(), 23 * 3600)
        _, _, start, end = helper.period_bounds("2026-11-01", "2026-11-01", "America/New_York")
        self.assertEqual((end - start).total_seconds(), 25 * 3600)

    def test_period_spans_inclusive_local_dates(self):
        first, last, start, end = helper.period_bounds("2026-11-01", "2026-11-07", "Asia/Seoul")
        self.assertEqual((str(first), str(last)), ("2026-11-01", "2026-11-07"))
        self.assertEqual(helper.stamp(start), "2026-10-31T15:00:00Z")
        self.assertEqual(helper.stamp(end), "2026-11-07T15:00:00Z")
        # Only an end date means that one day.
        first, last, _, _ = helper.period_bounds(None, "2026-11-07", "Asia/Seoul")
        self.assertEqual(first, last)
        with self.assertRaisesRegex(ValueError, "starts"):
            helper.period_bounds("2026-11-08", "2026-11-07", "Asia/Seoul")

    def test_period_defaults_to_today(self):
        today = helper.datetime.now(helper.ZoneInfo("Asia/Seoul")).date()
        first, last, _, _ = helper.period_bounds(None, None, "Asia/Seoul")
        self.assertEqual((first, last), (today, today))
        first, last, _, _ = helper.period_bounds(str(today - helper.timedelta(days=6)), None, "Asia/Seoul")
        self.assertEqual(((last - first).days, last), (6, today))

    def test_heading_names_the_period(self):
        one, seven = helper.date(2026, 11, 1), helper.date(2026, 11, 7)
        self.assertEqual(helper.heading(one, one), "Update for 2026-11-01:")
        self.assertEqual(helper.heading(one, seven), "Update for 2026-11-01 to 2026-11-07:")

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
        sections = helper.classify(records, "SAMPLE-USER", self.start, self.end)
        self.assertEqual({key: [p["number"] for p in value] for key, value in sections.items()},
                         {"Merged": [1], "WIP": [2], "Closed": [3]})

    def test_pagination_and_event_search(self):
        with patch.object(helper, "gh_json", side_effect=[
            page([pr(1)], count=2, cursor="next"), page([pr(2)], count=2)
        ]) as request:
            records = helper.search_prs("example/demo", "sample-user", self.start,
                                      self.end, "is:merged", "merged")
        self.assertEqual(len(records), 2)
        self.assertIn("cursor=next", request.call_args.args)
        self.assertIn("login=sample-user", request.call_args.args)
        search = next(arg for arg in request.call_args.args if arg.startswith("search="))
        self.assertIn("author:sample-user is:merged", search)
        self.assertIn("merged:2026-11-04T15:00:00Z..2026-11-05T14:59:59Z", search)

    def test_own_closed_search_uses_updated_without_upper_bound(self):
        with patch.object(helper, "gh_json", return_value=page([pr(1)])) as request:
            helper.search_prs("example/demo", "sample-user", self.start, self.end,
                             "is:closed is:unmerged", "closed")
        search = next(arg for arg in request.call_args.args if arg.startswith("search="))
        self.assertIn("author:sample-user is:closed is:unmerged updated:>=2026-11-04T15:00:00Z", search)
        self.assertNotIn("closed:2", search)

    def test_incomplete_search_and_limit_fail(self):
        truncated = pr(1, reviews={"totalCount": 101, "nodes": []})
        for result in [page([], count=1), page([], count=1001), page([None]), page([truncated])]:
            with self.subTest(result=result), patch.object(helper, "gh_json", return_value=result):
                with self.assertRaises(RuntimeError):
                    helper.search_prs("example/demo", "sample-user", self.start,
                                     self.end, "is:open", "updated")

    def test_repeated_cursor_fails(self):
        with patch.object(helper, "gh_json", return_value=page([pr(1)], cursor="same")):
            with self.assertRaisesRegex(RuntimeError, "pagination"):
                helper.search_prs("example/demo", "sample-user", self.start,
                                 self.end, "is:open", "updated")

    def test_others_searches_cover_reviews_merges_and_closes(self):
        with patch.object(helper, "gh_json", side_effect=[
            page([pr(1)]), page([pr(1), pr(2)]), page([pr(3)])
        ]) as request:
            records = helper.search_others("example/demo", "sample-user", self.start, self.end)
        self.assertEqual(sorted(p["number"] for p in records), [1, 2, 3])
        searches = [arg for call in request.call_args_list for arg in call.args if arg.startswith("search=")]
        self.assertIn("reviewed-by:sample-user -author:sample-user updated:>=2026-11-04T15:00:00Z", searches[0])
        self.assertIn("is:merged -author:sample-user merged:2026-11-04T15:00:00Z..2026-11-05T14:59:59Z",
                      searches[1])
        self.assertIn("is:closed is:unmerged -author:sample-user updated:>=2026-11-04T15:00:00Z",
                      searches[2])
        self.assertNotIn("closed:2", searches[2])

    def test_classifies_reviews_and_merges_on_others_prs(self):
        other = {"login": "someone-else"}
        records = [
            pr(1, author=other, reviews=reviews(("CHANGES_REQUESTED", "2026-11-04T16:00:00Z"),
                                                ("APPROVED", "2026-11-05T01:00:00Z"))),
            pr(2, author=other, state="MERGED", mergedAt="2026-11-05T02:00:00Z",
               mergedBy={"login": "SAMPLE-USER"},
               reviews=reviews(("COMMENTED", "2026-11-05T01:00:00Z"))),
            pr(3, author=other, state="MERGED", mergedAt="2026-11-05T02:00:00Z",
               mergedBy={"login": "sample-user"}),
            pr(4, author=other, state="MERGED", mergedAt="2026-11-05T02:00:00Z",
               mergedBy={"login": "someone-else"}),
            pr(5, author=other, reviews=reviews(("APPROVED", "2026-11-04T14:59:59Z"),
                                                ("PENDING", None))),
            pr(6, author=other, state="MERGED", mergedAt="2026-11-05T15:00:00Z",
               mergedBy={"login": "sample-user"}),
            pr(7, reviews=reviews(("COMMENTED", "2026-11-05T01:00:00Z"))),
            pr(8, author=None, reviews=reviews(("DISMISSED", "2026-11-05T01:00:00Z"))),
        ]
        activity = helper.classify_others(records, "sample-user", self.start, self.end)
        self.assertEqual([(p["number"], p["myActivity"]) for p in activity], [
            (8, ["review dismissed"]), (3, ["merged"]), (2, ["commented", "merged"]),
            (1, ["approved"]),
        ])
        output = helper.render({"Reviews and merges": activity}, "Update:")
        self.assertIn("Reviews and merges:\n - 4 PRs in total: 1 approved, 1 commented and merged, "
                      "1 review dismissed, 1 merged.\n", output)
        self.assertNotIn("example/demo#2", output)

    def test_classifies_closes_on_others_prs(self):
        other = {"login": "someone-else"}
        closed = dict(author=other, state="CLOSED", closedAt="2026-11-05T03:00:00Z")
        records = [
            # Closed by the user during the day, after a review.
            pr(1, **closed, lastClose=last_close("SAMPLE-USER", "2026-11-05T03:00:00Z"),
               reviews=reviews(("CHANGES_REQUESTED", "2026-11-05T01:00:00Z"))),
            # Closed by someone else.
            pr(2, **closed, lastClose=last_close("someone-else", "2026-11-05T03:00:00Z")),
            # Closed with no close event in the record.
            pr(3, **closed),
            # Closed by the user on a different day.
            pr(4, author=other, state="CLOSED", closedAt="2026-11-05T15:00:00Z",
               lastClose=last_close("sample-user", "2026-11-05T15:00:00Z")),
            # The user closed it, but it was reopened and is open now.
            pr(5, author=other, lastClose=last_close("sample-user", "2026-11-05T03:00:00Z")),
            # Closed by a deleted account.
            pr(6, **closed, lastClose=last_close(None, "2026-11-05T03:00:00Z")),
            # The user's own PR belongs to the Closed section instead.
            pr(7, state="CLOSED", closedAt="2026-11-05T03:00:00Z",
               lastClose=last_close("sample-user", "2026-11-05T03:00:00Z")),
        ]
        activity = helper.classify_others(records, "sample-user", self.start, self.end)
        self.assertEqual([(p["number"], p["myActivity"]) for p in activity],
                         [(1, ["changes requested", "closed"])])
        self.assertIn(" - 1 PR in total: 1 changes requested and closed.\n",
                      helper.render({"Reviews and merges": activity}, "Update:"))

    def test_extra_update_and_inline_code_are_preserved(self):
        sections = helper.classify([pr(2, isDraft=True)], "sample-user", self.start, self.end)
        extra = "Team notes:\n\n - Keep `alpha` and **beta**.\n"
        output = helper.render(sections, "Update for 2026-11-05:", extra)
        self.assertTrue(output.startswith("Update for 2026-11-05:\n\nMerged:\n"))
        self.assertTrue(output.endswith("\n---\n\n" + extra))
        self.assertIn(" - [example/demo#2](https://github.com/example/demo/pull/2) (draft)\n", output)
        self.assertNotIn("fix: retain", output)
        self.assertIn("Merged:\n - None.", output)
        self.assertNotIn("\n---\n", helper.render(sections, "Update:"))

    def test_cli_collects_all_categories_and_deduplicates_repositories(self):
        args = ["activity_update.py", "--repo", "example/demo", "--repo", "EXAMPLE/demo",
                "--date", "2026-11-05", "--timezone", "Asia/Seoul", "--json"]
        responses = [{"login": "sample-user"}, {"full_name": "example/demo"},
                     page([]), page([pr(2)]), page([]),
                     page([pr(3, author={"login": "someone-else"},
                              reviews=reviews(("APPROVED", "2026-11-05T01:00:00Z")))]),
                     page([]), page([])]
        stdout = io.StringIO()
        with patch("sys.argv", args), patch.object(helper, "gh_json", side_effect=responses) as request:
            with redirect_stdout(stdout):
                self.assertEqual(helper.main(), 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["repositories"], ["example/demo"])
        self.assertEqual(len(result["sections"]["WIP"]), 1)
        queries = [arg for call in request.call_args_list for arg in call.args if arg.startswith("search=")]
        self.assertEqual(len(queries), 6)
        self.assertIn("is:closed is:unmerged updated:>=2026-11-04T15:00:00Z", queries[2])
        self.assertEqual([p["number"] for p in result["sections"]["Reviews and merges"]], [3])
        self.assertIn("Reviews and merges:\n - 1 PR in total: 1 approved.", result["markdown"])

    def test_cli_searches_the_whole_period(self):
        args = ["activity_update.py", "--repo", "example/demo", "--since", "2026-11-01",
                "--until", "2026-11-07", "--timezone", "Asia/Seoul", "--json"]
        responses = [{"login": "sample-user"}, {"full_name": "example/demo"},
                     page([pr(1, state="MERGED", mergedAt="2026-11-01T00:00:00Z")]),
                     page([pr(2, updatedAt="2026-11-07T14:00:00Z")]), *[page([])] * 4]
        stdout = io.StringIO()
        with patch("sys.argv", args), patch.object(helper, "gh_json", side_effect=responses) as request:
            with redirect_stdout(stdout):
                self.assertEqual(helper.main(), 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual((result["since"], result["until"]), ("2026-11-01", "2026-11-07"))
        self.assertEqual((result["start"], result["endExclusive"]),
                         ("2026-10-31T15:00:00Z", "2026-11-07T15:00:00Z"))
        self.assertTrue(result["markdown"].startswith("Update for 2026-11-01 to 2026-11-07:\n"))
        self.assertEqual([p["number"] for p in result["sections"]["Merged"]], [1])
        self.assertEqual([p["number"] for p in result["sections"]["WIP"]], [2])
        queries = [arg for call in request.call_args_list for arg in call.args if arg.startswith("search=")]
        self.assertIn("merged:2026-10-31T15:00:00Z..2026-11-07T14:59:59Z", queries[0])
        self.assertIn("updated:2026-10-31T15:00:00Z..2026-11-07T14:59:59Z", queries[1])

    def test_cli_rejects_invalid_periods_before_querying(self):
        for extra in (["--date", "2026-11-05", "--since", "2026-11-01"],
                      ["--since", "2026-11-08", "--until", "2026-11-07"],
                      ["--since", "2026-13-01"]):
            args = ["activity_update.py", "--repo", "example/demo", *extra]
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(extra=extra), patch("sys.argv", args), \
                    patch.object(helper, "gh_json") as request:
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    self.assertEqual(helper.main(), 1)
                request.assert_not_called()
            self.assertEqual(stdout.getvalue(), "")

    def test_cli_failure_does_not_emit_partial_update(self):
        args = ["activity_update.py", "--repo", "example/demo", "--repo", "example/private"]
        responses = [{"login": "sample-user"}, {}, *[page([])] * 6,
                     RuntimeError("repository unavailable")]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("sys.argv", args), patch.object(helper, "gh_json", side_effect=responses):
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(helper.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("repository unavailable", stderr.getvalue())

    def test_graphql_errors_fail_even_when_process_exits_successfully(self):
        response = type("Response", (), {"returncode": 0, "stderr": "", "stdout":
                                        '{"errors": [{"message": "rate limited"}]}'} )()
        with patch.object(helper.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "rate limited"):
                helper.gh_json("api", "graphql")


if __name__ == "__main__":
    unittest.main()
