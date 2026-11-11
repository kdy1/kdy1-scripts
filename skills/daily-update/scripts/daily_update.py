#!/usr/bin/env python3
"""Collect the authenticated user's daily PR, review, and merge activity through read-only gh queries."""

import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from zoneinfo import ZoneInfo


QUERY = """
query($search: String!, $cursor: String, $login: String!) {
  search(query: $search, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url state isDraft body mergedAt closedAt updatedAt
        author { login }
        mergedBy { login }
        repository { nameWithOwner }
        reviews(author: $login, last: 100) {
          totalCount
          nodes { state submittedAt }
        }
      }
    }
  }
}
"""
REVIEW_LABELS = {
    "APPROVED": "approved", "CHANGES_REQUESTED": "changes requested",
    "COMMENTED": "commented", "DISMISSED": "review dismissed",
}


def gh_json(*args):
    result = subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "GitHub CLI request failed")
    payload = json.loads(result.stdout)
    if isinstance(payload, dict) and payload.get("errors"):
        raise RuntimeError(json.dumps(payload["errors"]))
    return payload


def day_bounds(day_text=None, zone_name=None):
    zone = ZoneInfo(zone_name) if zone_name else None
    day = date.fromisoformat(day_text) if day_text else datetime.now(zone).date()
    # Resolve both local midnights independently, including DST transitions.
    start = datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)
    end = datetime.combine(
        day + timedelta(days=1), time.min, tzinfo=zone
    ).astimezone(timezone.utc)
    return day, start, end


def stamp(value):
    return value.isoformat().replace("+00:00", "Z")


def within(timestamp, start, end):
    return bool(timestamp) and start <= datetime.fromisoformat(timestamp.replace("Z", "+00:00")) < end


def login_of(actor):
    return (actor or {}).get("login", "").casefold()


def search_prs(repo, author, start, end, qualifier, date_field):
    # Search bounds are inclusive and GitHub timestamps have second precision.
    return run_search(
        repo, author,
        f"author:{author} {qualifier} "
        f"{date_field}:{stamp(start)}..{stamp(end - timedelta(seconds=1))}",
    )


def search_others(repo, author, start, end):
    """Find other authors' PRs that the user reviewed or merged during the day."""
    records = {}
    # A submitted review updates the PR, so its updatedAt is at or after the review.
    for terms in (
        f"reviewed-by:{author} -author:{author} updated:>={stamp(start)}",
        f"is:merged -author:{author} "
        f"merged:{stamp(start)}..{stamp(end - timedelta(seconds=1))}",
    ):
        for pr in run_search(repo, author, terms):
            records[pr["url"]] = pr
    return list(records.values())


def run_search(repo, author, terms):
    search = f"repo:{repo} is:pr {terms}"
    cursor = None
    seen_cursors = set()
    records = {}
    expected = 0
    while True:
        args = [
            "api", "--hostname", "github.com", "graphql",
            "-f", f"query={QUERY}", "-f", f"search={search}", "-f", f"login={author}",
        ]
        if cursor:
            args.extend(["-f", f"cursor={cursor}"])
        page = gh_json(*args)["data"]["search"]
        expected = max(expected, page["issueCount"])
        if expected > 1000:
            raise RuntimeError(f"{repo}: GitHub search exceeds its 1,000-result limit")
        for pr in page["nodes"]:
            if not pr or "number" not in pr:
                raise RuntimeError(f"{repo}: GitHub returned an incomplete PR record")
            reviews = pr["reviews"]
            if reviews["totalCount"] > len(reviews["nodes"]):
                raise RuntimeError(f"{repo}#{pr['number']}: too many reviews to check completely")
            records[pr["url"]] = pr
        info = page["pageInfo"]
        if not info["hasNextPage"]:
            break
        cursor = info["endCursor"]
        if not cursor or cursor in seen_cursors:
            raise RuntimeError(f"{repo}: GitHub pagination did not advance")
        seen_cursors.add(cursor)
    if len(records) != expected:
        raise RuntimeError(f"{repo}: GitHub search changed or returned incomplete results; retry")
    return list(records.values())


def classify(records, author, start, end):
    sections = {"Merged": [], "WIP": [], "Closed": []}
    for pr in records:
        if login_of(pr.get("author")) != author.casefold():
            continue
        if pr.get("mergedAt"):
            section, timestamp = "Merged", pr["mergedAt"]
        elif pr["state"] == "OPEN":
            section, timestamp = "WIP", pr["updatedAt"]
        elif pr["state"] == "CLOSED":
            section, timestamp = "Closed", pr["closedAt"]
        else:
            raise RuntimeError(f"Unexpected PR state: {pr['state']}")
        if within(timestamp, start, end):
            sections[section].append(pr)
    for prs in sections.values():
        prs.sort(key=lambda pr: (pr["repository"]["nameWithOwner"].casefold(), -pr["number"]))
    return sections


def classify_others(records, author, start, end):
    """Keep other authors' PRs with the user's latest review state and own merge that day."""
    activity = []
    for pr in records:
        if login_of(pr.get("author")) == author.casefold():
            continue
        reviews = sorted(
            (review for review in pr["reviews"]["nodes"]
             if review["state"] in REVIEW_LABELS and within(review["submittedAt"], start, end)),
            key=lambda review: review["submittedAt"],
        )
        merged = login_of(pr.get("mergedBy")) == author.casefold() and within(pr.get("mergedAt"), start, end)
        notes = [REVIEW_LABELS[reviews[-1]["state"]]] if reviews else []
        if merged:
            notes.append("merged")
        if notes:
            activity.append({**pr, "myActivity": notes})
    activity.sort(key=lambda pr: (pr["repository"]["nameWithOwner"].casefold(), -pr["number"]))
    return activity


def render(sections, extra=None):
    lines = ["Todays update:"]
    for section, prs in sections.items():
        lines.extend(["", f"{section}:"])
        for pr in prs:
            label = f"{pr['repository']['nameWithOwner']}#{pr['number']}"
            notes = pr.get("myActivity") or (["draft"] if pr["isDraft"] else [])
            note = f" ({', '.join(notes)})" if notes else ""
            lines.append(f" - [{label}]({pr['url']}){note}")
        if not prs:
            lines.append(" - None.")
    report = "\n".join(lines) + "\n"
    if extra and extra.strip():
        report += "\n---\n\n" + extra
        if not report.endswith("\n"):
            report += "\n"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", action="append", required=True, help="OWNER/REPO; repeat as needed")
    parser.add_argument("--date", help="YYYY-MM-DD (default: today)")
    parser.add_argument("--timezone", help="IANA timezone (default: system local timezone)")
    parser.add_argument("--extra-update-file", type=Path, help="Prepared English UTF-8 Markdown")
    parser.add_argument("--json", action="store_true", help="Include source records and Markdown")
    args = parser.parse_args()
    try:
        repos = list(dict.fromkeys(repo.lower() for repo in args.repo))
        if any(not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repo) for repo in repos):
            raise ValueError("Each --repo must be an OWNER/REPO name")
        day, start, end = day_bounds(args.date, args.timezone)
        extra = args.extra_update_file.read_text(encoding="utf-8") if args.extra_update_file else None
        author = gh_json("api", "--hostname", "github.com", "user")["login"]
        records, others = {}, {}
        for repo in repos:
            # An inaccessible repository must not look like an empty search.
            gh_json("api", "--hostname", "github.com", f"repos/{repo}")
            for qualifier, date_field in (
                ("is:merged", "merged"),
                ("is:open", "updated"),
                ("is:closed is:unmerged", "closed"),
            ):
                for pr in search_prs(repo, author, start, end, qualifier, date_field):
                    records[pr["url"]] = pr
            for pr in search_others(repo, author, start, end):
                others[pr["url"]] = pr
        sections = classify(records.values(), author, start, end)
        sections["Reviews and merges"] = classify_others(others.values(), author, start, end)
        markdown = render(sections, extra)
        if args.json:
            print(json.dumps({
                "author": author, "repositories": repos, "date": str(day),
                "timezone": args.timezone or "system local",
                "start": stamp(start), "endExclusive": stamp(end),
                "sections": sections, "markdown": markdown,
            }, ensure_ascii=False, indent=2))
        else:
            print(markdown, end="")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(f"daily-update: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
