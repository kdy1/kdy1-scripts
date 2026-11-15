"""Offline checks for the eager duplicate search."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("find-duplicates.py")

# A fake gh that answers by query text and logs each received query.
FAKE_GH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    q = next(a[2:] for a in sys.argv if a.startswith("q="))
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(q + "\\n")
    def issue(n, state="open"):
        return {"number": n, "html_url": f"https://github.com/o/r/issues/{n}",
                "title": f"issue {n}", "state": state, "labels": [{"name": "bug"}]}
    if "boom" in q:
        sys.stderr.write("HTTP 502\\n"); sys.exit(1)
    if "lexer" in q:
        items = [issue(1), issue(2, "closed")]
    elif "parse_number" in q:
        items = [issue(2, "closed"), {"number": 3, "pull_request": {}, "html_url": "x",
                                      "title": "pr", "state": "open"}]
    else:
        items = []
    total = 500 if "wide" in q else len(items)
    print(json.dumps({"total_count": total, "incomplete_results": False, "items": items}))
""")


class FindDuplicatesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.gh = Path(self.temp.name) / "gh"
        self.gh.write_text(FAKE_GH)
        self.gh.chmod(self.gh.stat().st_mode | stat.S_IEXEC)
        self.log = Path(self.temp.name) / "log"

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args):
        env = {**os.environ, "STATIC_ANALYSIS_GH": str(self.gh), "FAKE_LOG": str(self.log)}
        result = subprocess.run([sys.executable, str(SCRIPT), "--repo", "o/r", *args],
                                capture_output=True, text=True, env=env, check=False)
        return result

    def test_merges_and_ranks_by_matching_queries(self):
        result = self.run_script("--query", "parse_number", "--path", "src/lexer.rs:10")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data["complete"])
        self.assertEqual([issue["number"] for issue in data["issues"]], [2, 1])
        self.assertEqual(len(data["issues"][0]["matchedQueries"]), 3)
        self.assertEqual(data["issues"][0]["state"], "closed")
        queries = self.log.read_text().splitlines()
        self.assertEqual(queries[0], "repo:o/r is:issue parse_number")
        self.assertIn('repo:o/r is:issue "lexer.rs"', queries)
        self.assertIn("repo:o/r is:issue lexer", queries)

    def test_state_filter_and_overflow_mark_incomplete(self):
        data = json.loads(self.run_script("--query", "wide", "--state", "open").stdout)
        self.assertFalse(data["complete"])
        self.assertEqual(self.log.read_text().strip(), "repo:o/r is:issue is:open wide")

    def test_failed_query_is_reported_not_empty(self):
        result = self.run_script("--query", "boom", "--query", "lexer")
        data = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(data["complete"])
        self.assertEqual(data["queries"][0]["error"], "HTTP 502")
        self.assertEqual(self.run_script("--query", "boom").returncode, 1)

    def test_requires_a_query(self):
        self.assertEqual(self.run_script().returncode, 2)


if __name__ == "__main__":
    unittest.main()
