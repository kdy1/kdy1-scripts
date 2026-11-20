from datetime import datetime, timedelta, timezone
import os
import tempfile
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


class LedgerCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = mock.patch.dict(
            os.environ, {"AUTO_REVIEW_PR_QUERY_DISPATCHES": os.path.join(directory.name, "d.jsonl")},
        )
        patcher.start()
        self.addCleanup(patcher.stop)


NOW = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
HEAD = "a" * 40


class SelectTests(LedgerCase):
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

    def test_skips_a_pull_request_with_an_active_dispatch(self):
        query.dispatch("https://github.com/o/r/pull/1", HEAD, "repo:o/r", "codex", now=NOW - timedelta(hours=1))
        with mock.patch.object(query, "search", return_value=([item(1), item(2)], False)), \
                mock.patch.object(strict, "check", side_effect=lambda url, d: check_result(url)) as check:
            output = query.select("repo:o/r", now=NOW)
        self.assertEqual([entry["url"][-1] for entry in output["selected"]], ["2"])
        self.assertIn("has not finished", output["skipped"][0]["reason"])
        self.assertEqual(check.call_count, 1)

    def test_selects_again_after_finish_or_expiry(self):
        old = query.dispatch("https://github.com/o/r/pull/1", HEAD, "q", "codex", now=NOW - timedelta(hours=25))
        query.dispatch("https://github.com/o/r/pull/2", HEAD, "q", "codex", now=NOW - timedelta(hours=1))
        done = query.dispatch("https://github.com/o/r/pull/3", HEAD, "q", "codex", now=NOW - timedelta(hours=1))
        query.finish(done["dispatchId"], "posted")
        with mock.patch.object(query, "search", return_value=([item(n) for n in (1, 2, 3)], False)), \
                mock.patch.object(strict, "check", side_effect=lambda url, d: check_result(url)):
            output = query.select("repo:o/r", max_reviews=5, now=NOW)
        self.assertEqual([entry["url"][-1] for entry in output["selected"]], ["1", "3"])
        self.assertTrue(old["dispatchId"])

    def test_rejects_bad_limits(self):
        for kwargs in ({"max_reviews": 0}, {"scan_limit": 0}, {"redispatch_after_hours": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                query.select("repo:o/r", **kwargs)


class DispatchTests(LedgerCase):
    def test_dispatch_writes_the_launch_prompt(self):
        output = query.dispatch(
            "https://github.com/o/r/pull/7", HEAD, "repo:o/r is:pr", "claude", settings="effort=high", now=NOW,
        )
        self.assertEqual(output["title"], "Auto review o/r#7")
        self.assertEqual(output["clientRequestId"], f"auto-review-pr-query-{output['dispatchId']}")
        prompt = output["prompt"]
        self.assertTrue(prompt.startswith("/auto-review-pr-strict https://github.com/o/r/pull/7\n"))
        self.assertIn(f"- Dispatch ID: {output['dispatchId']}", prompt)
        self.assertIn("- Query: repo:o/r is:pr", prompt)
        self.assertIn(f"- Head at selection: {HEAD}", prompt)
        self.assertIn("- Include drafts: no", prompt)
        self.assertIn("- Review Once settings: effort=high", prompt)
        codex = query.dispatch("https://github.com/o/r/pull/8", HEAD, "q", "codex", include_draft=True)
        self.assertTrue(codex["prompt"].startswith("$auto-review-pr-strict https://github.com/o/r/pull/8\n"))
        self.assertIn("- Include drafts: yes", codex["prompt"])
        self.assertIn("- Review Once settings: defaults", codex["prompt"])

    def test_dispatch_refuses_a_second_active_dispatch_and_bad_input(self):
        query.dispatch("https://github.com/o/r/pull/7", HEAD, "q", "codex", now=NOW)
        with self.assertRaises(RuntimeError):
            query.dispatch("https://github.com/o/r/pull/7", HEAD, "q", "codex", now=NOW + timedelta(hours=1))
        for kwargs in ({"head": "abc"}, {"harness": "other"}, {"query": "a\nb"}, {"settings": "a\nb"}):
            args = {"url": "https://github.com/o/r/pull/9", "head": HEAD, "query": "q", "harness": "codex", **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                query.dispatch(**args)

    def test_verify_accepts_only_the_latest_unfinished_dispatch(self):
        url = "https://github.com/o/r/pull/7"
        first = query.dispatch(url, HEAD, "q", "codex", now=NOW - timedelta(hours=30))
        second = query.dispatch(url, HEAD, "q", "codex", now=NOW)
        self.assertEqual(query.verify(second["dispatchId"], url)["head"], HEAD)
        with self.assertRaisesRegex(RuntimeError, "later dispatch"):
            query.verify(first["dispatchId"], url)
        with self.assertRaisesRegex(RuntimeError, "not https://github.com/o/r/pull/8"):
            query.verify(second["dispatchId"], "https://github.com/o/r/pull/8")
        with self.assertRaisesRegex(RuntimeError, "no dispatch"):
            query.verify("0" * 32, url)
        with self.assertRaises(ValueError):
            query.verify("nope", url)
        query.finish(second["dispatchId"], "no-findings")
        with self.assertRaisesRegex(RuntimeError, "already finished"):
            query.verify(second["dispatchId"], url)

    def test_finish_once(self):
        output = query.dispatch("https://github.com/o/r/pull/7", HEAD, "q", "codex")
        entry = query.finish(output["dispatchId"], "launch-failed", now=NOW)
        self.assertEqual((entry["outcome"], entry["finishedAt"]), ("launch-failed", NOW.isoformat()))
        with self.assertRaises(RuntimeError):
            query.finish(output["dispatchId"], "posted")
        self.assertIsNone(query.active_dispatch("https://github.com/o/r/pull/7"))


if __name__ == "__main__":
    unittest.main()
