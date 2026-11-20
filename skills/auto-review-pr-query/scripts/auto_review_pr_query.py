#!/usr/bin/env python3
"""Select the pull requests that Auto Review PR Query hands to Auto Review PR Strict.

`select` runs a GitHub search query for pull requests, newest update first
(`--oldest-first` reverses it), and runs the `auto-review-pr-strict` check on each result until it has
`--max` pull requests that need a review now. It skips the others with the
reason from the check: closed or merged, a draft, or a head that was already
reviewed. It prints the selected pull requests in order, the skipped ones, and
whether the search had more results than it scanned.

The search always adds `is:pr`. Put the repository, author, label, and other
qualifiers in the query, for example `repo:o/r is:open -author:app/dependabot`.
"""

import argparse
import json
from pathlib import Path
import sys

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
sys.path.insert(0, str(SKILLS / "auto-review-pr-strict" / "scripts"))
import auto_review_pr_strict as strict  # noqa: E402
import post_text  # noqa: E402

PAGE = 100
SEARCH_LIMIT = 1000


def full_query(query):
    query = post_text.single_line("query", query)
    terms = query.split()
    if "is:pr" not in terms and "type:pr" not in terms:
        query += " is:pr"
    return query


def search(host, query, scan_limit, oldest_first=False):
    """Return up to scan_limit pull request results, sorted by update time, and whether more exist."""
    items, page, total = [], 1, 0
    while len(items) < scan_limit:
        result = post_text.gh_api(
            host, "-X", "GET", "search/issues", "-f", f"q={query}", "-f", "sort=updated",
            "-f", f"order={'asc' if oldest_first else 'desc'}", "-f", f"per_page={PAGE}", "-f", f"page={page}",
        )
        total = result.get("total_count", 0)
        batch = [item for item in result.get("items", []) if item.get("pull_request")]
        items += batch
        if len(result.get("items", [])) < PAGE or page * PAGE >= min(total, SEARCH_LIMIT):
            break
        page += 1
    return items[:scan_limit], total > len(items[:scan_limit])


def select(query, host="github.com", max_reviews=3, scan_limit=50, include_draft=False, oldest_first=False):
    if max_reviews < 1 or scan_limit < 1:
        raise ValueError("--max and --scan-limit must be positive.")
    query = full_query(query)
    items, more = search(host, query, scan_limit, oldest_first)
    selected, skipped, errors = [], [], []
    for item in items:
        if len(selected) >= max_reviews:
            break
        url = item["pull_request"].get("html_url") or item["html_url"]
        try:
            result = strict.check(url, include_draft)
        except (RuntimeError, ValueError, KeyError) as error:
            errors.append({"url": url, "error": str(error)})
            continue
        entry = {"url": result["target"], "title": result["title"], "head": result["head"]}
        if result["decision"] == "review":
            entry["earlierChangeRequests"] = len(result["earlierChangeRequests"])
            selected.append(entry)
        else:
            skipped.append({**entry, "reason": result["reason"]})
    unchecked = len(items) - len(selected) - len(skipped) - len(errors)
    return {
        "query": query,
        "host": host,
        "scanned": len(items),
        "moreResults": more,
        "uncheckedResults": unchecked,
        "selected": selected,
        "skipped": skipped,
        "errors": errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    choose = commands.add_parser("select", help="Select the pull requests that need a strict review now.")
    choose.add_argument("--query", required=True, help="GitHub search query; `is:pr` is added when missing.")
    choose.add_argument("--host", default="github.com", help="GitHub host (default github.com).")
    choose.add_argument("--max", type=int, default=3, dest="max_reviews", help="Most pull requests to select (default 3).")
    choose.add_argument("--scan-limit", type=int, default=50, help="Most search results to check (default 50).")
    choose.add_argument("--include-draft", action="store_true", help="Select draft pull requests too.")
    choose.add_argument("--oldest-first", action="store_true", help="Check the least recently updated results first.")
    args = parser.parse_args()
    try:
        output = select(
            args.query, args.host, args.max_reviews, args.scan_limit, args.include_draft, args.oldest_first,
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
