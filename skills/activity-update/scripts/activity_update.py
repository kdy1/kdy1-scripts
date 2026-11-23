#!/usr/bin/env python3
"""Collect the authenticated user's PR, review, merge, and close activity in a date range through read-only gh queries."""

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
        lastClose: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes { ... on ClosedEvent { createdAt actor { login } } }
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


def period_bounds(since=None, until=None, zone_name=None):
    """Resolve an inclusive range of local dates to UTC bounds; end is exclusive.

    `until` defaults to today and `since` defaults to `until`, so no dates means today.
    """
    zone = ZoneInfo(zone_name) if zone_name else None
    today = datetime.now(zone).date()
    last = date.fromisoformat(until) if until else today
    first = date.fromisoformat(since) if since else last
    if first > last:
        raise ValueError(f"The period starts ({first}) after it ends ({last})")
    # Resolve both local midnights independently, including DST transitions.
    start = datetime.combine(first, time.min, tzinfo=zone).astimezone(timezone.utc)
    end = datetime.combine(
        last + timedelta(days=1), time.min, tzinfo=zone
    ).astimezone(timezone.utc)
    return first, last, start, end


def heading(first, last):
    period = str(first) if first == last else f"{first} to {last}"
    return f"Update for {period}:"


def stamp(value):
    return value.isoformat().replace("+00:00", "Z")


def within(timestamp, start, end):
    return bool(timestamp) and start <= datetime.fromisoformat(timestamp.replace("Z", "+00:00")) < end


def login_of(actor):
    return (actor or {}).get("login", "").casefold()


def search_prs(repo, author, start, end, qualifier, date_field):
    # Search bounds are inclusive and GitHub timestamps have second precision.
    if "is:closed" in qualifier.split():
        # The `closed:` filter can miss PRs that were just closed. A close updates the PR, so search
        # `updated:` with no upper bound; classify() checks `closedAt` itself.
        window = f"updated:>={stamp(start)}"
    else:
        window = f"{date_field}:{stamp(start)}..{stamp(end - timedelta(seconds=1))}"
    return run_search(repo, author, f"author:{author} {qualifier} {window}")


def search_others(repo, author, start, end):
    """Find other authors' PRs that the user reviewed, merged, or closed during the period."""
    records = {}
    period = f"{stamp(start)}..{stamp(end - timedelta(seconds=1))}"
    # A submitted review or a close updates the PR, so its updatedAt is at or after the event. The
    # `closed:` filter can miss PRs that were just closed, so closes use `updated:`; classify_others()
    # checks `closedAt` and the close actor itself.
    for terms in (
        f"reviewed-by:{author} -author:{author} updated:>={stamp(start)}",
        f"is:merged -author:{author} merged:{period}",
        f"is:closed is:unmerged -author:{author} updated:>={stamp(start)}",
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
    """Keep other authors' PRs with the user's latest review state, merge, and close in the period."""
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
        if closed_by(pr, author, start, end):
            notes.append("closed")
        if notes:
            activity.append({**pr, "myActivity": notes})
    activity.sort(key=lambda pr: (pr["repository"]["nameWithOwner"].casefold(), -pr["number"]))
    return activity


def closed_by(pr, author, start, end):
    """Whether the user's close event, during the period, left the PR closed without merging."""
    if pr["state"] != "CLOSED" or pr.get("mergedAt") or not within(pr.get("closedAt"), start, end):
        return False
    # A PR closed again after a reopen keeps one ClosedEvent per close; the query asks for the latest.
    events = pr["lastClose"]["nodes"]
    return bool(events) and login_of(events[-1].get("actor")) == author.casefold()


def render(sections, title, extra=None):
    lines = [title]
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
    parser.add_argument("--date", help="YYYY-MM-DD; one day, the same as equal --since and --until")
    parser.add_argument("--since", help="First local date YYYY-MM-DD, inclusive (default: the --until date)")
    parser.add_argument("--until", help="Last local date YYYY-MM-DD, inclusive (default: today)")
    parser.add_argument("--timezone", help="IANA timezone (default: system local timezone)")
    parser.add_argument("--extra-update-file", type=Path, help="Prepared English UTF-8 Markdown")
    parser.add_argument("--json", action="store_true", help="Include source records and Markdown")
    args = parser.parse_args()
    try:
        repos = list(dict.fromkeys(repo.lower() for repo in args.repo))
        if any(not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repo) for repo in repos):
            raise ValueError("Each --repo must be an OWNER/REPO name")
        if args.date and (args.since or args.until):
            raise ValueError("Use --date alone, or --since and --until")
        first, last, start, end = period_bounds(
            args.since or args.date, args.until or args.date, args.timezone
        )
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
        markdown = render(sections, heading(first, last), extra)
        if args.json:
            print(json.dumps({
                "author": author, "repositories": repos, "since": str(first), "until": str(last),
                "timezone": args.timezone or "system local",
                "start": stamp(start), "endExclusive": stamp(end),
                "sections": sections, "markdown": markdown,
            }, ensure_ascii=False, indent=2))
        else:
            print(markdown, end="")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(f"activity-update: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
