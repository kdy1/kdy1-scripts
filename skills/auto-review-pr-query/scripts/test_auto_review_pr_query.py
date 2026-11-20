import unittest
from unittest import mock

import auto_review_pr_query as query
import auto_review_pr_strict as strict
import post_text


def item(number):
    url = f"https://github.com/o/r/pull/{number}"
    return {"html_url": url, "pull_request": {"html_url": url}}


def page(numbers, total):
    return {"total_count": total, "items": [item(n) for n in numbers]}


def check_result(url, decision="review", reason=None):
    return {
        "target": url, "title": f"T{url[-1]}", "head": "a" * 40, "decision": decision,
        "reason": reason, "earlierChangeRequests": [],
    }


class QueryTests(unittest.TestCase):
    def test_adds_is_pr_once(self):
        self.assertEqual(query.full_query("repo:o/r is:open"), "repo:o/r is:open is:pr")
        self.assertEqual(query.full_query("repo:o/r is:pr"), "repo:o/r is:pr")
        self.assertEqual(query.full_query("type:pr repo:o/r"), "type:pr repo:o/r")
        for bad in ("", "a\nb"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                query.full_query(bad)

    def test_searches_oldest_update_first_and_pages(self):
        calls = []

        def fake(host, *args, **kwargs):
            calls.append(args)
            number = int(args[-1].split("=")[1])
            return page(range((number - 1) * 100, number * 100), 250)

        with mock.patch.object(post_text, "gh_api", side_effect=fake):
            items, more = query.search("github.com", "repo:o/r is:pr", 150)
        self.assertEqual(len(items), 150)
        self.assertTrue(more)
        self.assertEqual(len(calls), 2)
        self.assertIn("sort=updated", calls[0])
        self.assertIn("order=desc", calls[0])
        self.assertIn("q=repo:o/r is:pr", calls[0])

    def test_oldest_first_sorts_ascending(self):
        with mock.patch.object(post_text, "gh_api", return_value=page([1], 1)) as api:
            query.search("github.com", "q", 50, oldest_first=True)
        self.assertIn("order=asc", api.call_args.args)

    def test_stops_on_a_short_page(self):
        with mock.patch.object(post_text, "gh_api", return_value=page([1, 2], 2)) as api:
            items, more = query.search("github.com", "q", 50)
        self.assertEqual((len(items), more, api.call_count), (2, False, 1))


class SelectTests(unittest.TestCase):
    def run_select(self, results, max_reviews=2):
        decisions = iter(results)

        def fake_check(url, include_draft):
            outcome = next(decisions)
            if isinstance(outcome, Exception):
                raise outcome
            return check_result(url, *outcome)

        with mock.patch.object(query, "search", return_value=([item(n) for n in range(1, 6)], False)), \
                mock.patch.object(strict, "check", side_effect=fake_check) as check:
            return query.select("repo:o/r", max_reviews=max_reviews), check

    def test_selects_up_to_max_and_reports_skips_and_errors(self):
        output, check = self.run_select([
            ("skip", "the pull request is a draft"), RuntimeError("boom"), ("review",), ("review",),
        ])
        self.assertEqual([entry["url"][-1] for entry in output["selected"]], ["3", "4"])
        self.assertEqual(output["skipped"][0]["reason"], "the pull request is a draft")
        self.assertEqual(output["errors"], [{"url": "https://github.com/o/r/pull/2", "error": "boom"}])
        self.assertEqual(output["uncheckedResults"], 1)
        self.assertEqual(check.call_count, 4)
        self.assertEqual(output["query"], "repo:o/r is:pr")

    def test_rejects_bad_limits(self):
        for kwargs in ({"max_reviews": 0}, {"scan_limit": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                query.select("repo:o/r", **kwargs)


if __name__ == "__main__":
    unittest.main()
