#!/usr/bin/env python3
"""Search GitHub issues for possible duplicates of a candidate with several queries.

Run it as soon as a candidate is identified. It searches open and closed issues,
merges the results, and ranks each issue by how many queries matched it. It only
reads GitHub. The final duplicate decision stays with $add-issue.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import PurePosixPath

MAX_QUERIES = 10


def queries_for(args):
    """Return the unique queries, including terms derived from --path values."""
    queries = list(args.query)
    for path in args.path:
        name = PurePosixPath(path.split(":", 1)[0]).name
        stem = name.rsplit(".", 1)[0]
        queries.append(f'"{name}"')
        if stem and stem != name and len(stem) >= 4:
            queries.append(stem)
    unique = []
    for query in (" ".join(query.split()) for query in queries):
        if query and query not in unique:
            unique.append(query)
    if not unique:
        raise ValueError("Pass at least one --query or --path")
    if len(unique) > MAX_QUERIES:
        raise ValueError(f"Use at most {MAX_QUERIES} queries; got {len(unique)}")
    return unique


def search(gh, repo, query, state, limit):
    """Run one bounded GitHub issue search and return its parsed response."""
    qualifiers = f"repo:{repo} is:issue"
    if state != "all":
        qualifiers += f" is:{state}"
    command = [gh, "api", "-X", "GET", "search/issues",
               "-f", f"q={qualifiers} {query}", "-F", f"per_page={limit}"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60,
                            check=False)
    if result.returncode != 0:
        return None, (result.stderr.strip().splitlines() or ["gh failed"])[-1]
    try:
        return json.loads(result.stdout), None
    except json.JSONDecodeError:
        return None, "gh returned invalid JSON"


def merge(repo, queries, responses, limit):
    """Merge per-query responses into a ranked, de-duplicated issue list."""
    issues, report = {}, []
    for query, (data, error) in zip(queries, responses):
        if error is not None:
            report.append({"query": query, "complete": False, "error": error})
            continue
        items = [item for item in data.get("items", []) if "pull_request" not in item]
        total = data.get("total_count", len(items))
        complete = not data.get("incomplete_results", False) and total <= limit
        report.append({"query": query, "complete": complete, "total": total,
                       "returned": len(items)})
        for item in items:
            entry = issues.setdefault(item["number"], {
                "number": item["number"], "url": item["html_url"],
                "title": item["title"], "state": item["state"],
                "updatedAt": item.get("updated_at"),
                "labels": sorted(label["name"] for label in item.get("labels", [])),
                "matchedQueries": []})
            entry["matchedQueries"].append(query)
    ranked = sorted(issues.values(),
                    key=lambda issue: (-len(issue["matchedQueries"]),
                                       issue["state"] != "open", -issue["number"]))
    return {"repo": repo, "complete": all(item["complete"] for item in report),
            "queries": report, "issues": ranked}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, help="Issue tracker repository, owner/name")
    parser.add_argument("--query", action="append", default=[],
                        help="Search terms: symbol, error text, or symptom (repeatable)")
    parser.add_argument("--path", action="append", default=[],
                        help="Affected path or path:line; adds file-name queries (repeatable)")
    parser.add_argument("--state", choices=("all", "open", "closed"), default="all")
    parser.add_argument("--limit", type=int, default=30, help="Results per query, 1-100")
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.exit(2, "--limit must be from 1 to 100\n")
    try:
        queries = queries_for(args)
    except ValueError as error:
        parser.exit(2, f"{error}\n")
    gh = os.environ.get("STATIC_ANALYSIS_GH", "gh")
    responses = [search(gh, args.repo, query, args.state, args.limit) for query in queries]
    result = merge(args.repo, queries, responses, args.limit)
    json.dump(result, sys.stdout, indent=2)
    print()
    if all("error" in item for item in result["queries"]):
        sys.exit(1)


if __name__ == "__main__":
    main()
