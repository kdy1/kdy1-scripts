#!/usr/bin/env python3
"""Select the pull requests that Auto Review PR Query hands to Auto Review PR Strict,
and track the T3 Code thread that reviews each one.

`select` runs a GitHub search query for pull requests, newest update first
(`--oldest-first` reverses it), and runs the `auto-review-pr-strict` check on each result until it has
`--max` pull requests that need a review now. It skips the others with the
reason from the check: closed or merged, a draft, or a head that was already
reviewed. Before the check, it skips a pull request with an active dispatch: a
review thread that a run launched, that has not finished, and that is younger
than `--redispatch-after-hours` (default 24). It prints the selected pull
requests in order, the skipped ones, and whether the search had more results
than it scanned.

The search always adds `is:pr`. Put the repository, author, label, and other
qualifiers in the query, for example `repo:o/r is:open -author:app/dependabot`.

`dispatch` records a dispatch for one selected pull request in the dispatch
ledger and prints the title, the first message, and the client request ID of
the T3 Code thread to launch for it. Record it before the launch, so the
launched thread can verify it. `verify` runs in the launched thread: it
confirms that the dispatch is the latest one for the pull request and has not
finished. `finish` closes a dispatch: the launched thread runs it at the end of
its review, and the launching run runs it when the launch failed. A finished
dispatch no longer blocks `select`.

The dispatch ledger is `~/.local/state/auto-review-pr-query/dispatches.jsonl`
(`$XDG_STATE_HOME` is used when set; `AUTO_REVIEW_PR_QUERY_DISPATCHES`
overrides the path).
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
import uuid

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
sys.path.insert(0, str(SKILLS / "auto-review-pr-strict" / "scripts"))
import auto_review_pr_strict as strict  # noqa: E402
import post_text  # noqa: E402

PAGE = 100
SEARCH_LIMIT = 1000
REDISPATCH_AFTER_HOURS = 24
DISPATCH_ID = re.compile(r"[0-9a-f]{32}")
INVOKE = {"claude": "/auto-review-pr-strict", "codex": "$auto-review-pr-strict"}


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


def dispatch_path():
    """Return the dispatch ledger. AUTO_REVIEW_PR_QUERY_DISPATCHES overrides the default location."""
    override = os.environ.get("AUTO_REVIEW_PR_QUERY_DISPATCHES")
    if override:
        return Path(override)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / "auto-review-pr-query" / "dispatches.jsonl"


def append_dispatch_entry(entry):
    path = dispatch_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as ledger:
        ledger.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    return entry


def read_dispatches():
    """Return the dispatches by ID in ledger order, each with its finish entry when it has one."""
    dispatches = {}
    for entry in strict.read_ledger(dispatch_path()):
        dispatch_id = entry.get("dispatchId")
        if entry.get("event") == "dispatch" and dispatch_id not in dispatches:
            dispatches[dispatch_id] = dict(entry)
        elif entry.get("event") == "finish" and dispatch_id in dispatches:
            dispatches[dispatch_id].setdefault("finish", entry)
    return dispatches


def latest_dispatch(target_url):
    latest = None
    for entry in read_dispatches().values():
        if entry.get("target") == target_url:
            latest = entry
    return latest


def active_dispatch(target_url, now=None, after_hours=REDISPATCH_AFTER_HOURS):
    """Return the latest dispatch for the pull request when it did not finish and is younger than after_hours."""
    entry = latest_dispatch(target_url)
    if entry is None or "finish" in entry:
        return None
    try:
        dispatched = datetime.fromisoformat(entry["dispatchedAt"])
    except (KeyError, TypeError, ValueError):
        return None
    if (now or datetime.now(timezone.utc)) - dispatched >= timedelta(hours=after_hours):
        return None
    return entry


def pull_url(item):
    url = item["pull_request"].get("html_url") or item["html_url"]
    return post_text.canonical_pull_url(post_text.parse_pull_target(url))


def select(query, host="github.com", max_reviews=3, scan_limit=50, include_draft=False, oldest_first=False,
           redispatch_after_hours=REDISPATCH_AFTER_HOURS, now=None):
    if max_reviews < 1 or scan_limit < 1:
        raise ValueError("--max and --scan-limit must be positive.")
    if redispatch_after_hours <= 0:
        raise ValueError("--redispatch-after-hours must be positive.")
    query = full_query(query)
    items, more = search(host, query, scan_limit, oldest_first)
    selected, skipped, errors = [], [], []
    for item in items:
        if len(selected) >= max_reviews:
            break
        url = item["pull_request"].get("html_url") or item["html_url"]
        try:
            url = pull_url(item)
            active = active_dispatch(url, now, redispatch_after_hours)
            if active is not None:
                skipped.append({
                    "url": url, "title": item.get("title"), "head": active.get("head"),
                    "reason": f"a review thread for this pull request has not finished "
                              f"(dispatch {active['dispatchId']}, {active['dispatchedAt']})",
                })
                continue
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


def launch_prompt(entry, harness):
    lines = [
        f"{INVOKE[harness]} {entry['target']}",
        "",
        "This thread was launched by $auto-review-pr-query for one pull request that its helper selected.",
        "",
        f"- Dispatch ID: {entry['dispatchId']}",
        f"- Query: {entry['query']}",
        f"- Head at selection: {entry['head']}",
        f"- Include drafts: {'yes' if entry['includeDraft'] else 'no'}",
        f"- Review Once settings: {entry.get('settings') or 'defaults'}",
        "",
        "Apply $auto-review-pr-strict to this pull request only, as its start from a launched thread says: "
        "verify the dispatch, run its steps 1 to 7, finish the dispatch, report, and settle this thread.",
    ]
    return "\n".join(lines) + "\n"


def dispatch(url, head, query, harness, include_draft=False, settings=None, now=None,
             redispatch_after_hours=REDISPATCH_AFTER_HOURS):
    """Record a dispatch for one selected pull request and return what the launch needs."""
    target = post_text.parse_pull_target(url)
    canonical = post_text.canonical_pull_url(target)
    if not strict.FULL_SHA.fullmatch(head):
        raise ValueError("Provide the full SHA of the selected head.")
    if harness not in INVOKE:
        raise ValueError(f"harness must be one of: {', '.join(INVOKE)}.")
    active = active_dispatch(canonical, now, redispatch_after_hours)
    if active is not None:
        raise RuntimeError(
            f"Dispatch {active['dispatchId']} for {canonical} has not finished. Do not launch another thread."
        )
    entry = {
        "event": "dispatch",
        "dispatchId": uuid.uuid4().hex,
        "target": canonical,
        "head": head,
        "query": post_text.single_line("query", query),
        "includeDraft": bool(include_draft),
        "dispatchedAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
    }
    if settings is not None:
        entry["settings"] = post_text.single_line("settings", settings)
    append_dispatch_entry(entry)
    return {
        "dispatchId": entry["dispatchId"],
        "target": canonical,
        "head": head,
        "title": f"Auto review {target['owner']}/{target['repo']}#{target['number']}",
        "clientRequestId": f"auto-review-pr-query-{entry['dispatchId']}",
        "prompt": launch_prompt(entry, harness),
    }


def find_dispatch(dispatch_id):
    if not DISPATCH_ID.fullmatch(dispatch_id or ""):
        raise ValueError("Provide the 32-character dispatch ID from the launch prompt.")
    entry = read_dispatches().get(dispatch_id)
    if entry is None:
        raise RuntimeError(f"The dispatch ledger has no dispatch {dispatch_id}.")
    return entry


def verify(dispatch_id, url):
    """Return the dispatch when it is the latest unfinished dispatch for the pull request, or raise."""
    canonical = post_text.canonical_pull_url(post_text.parse_pull_target(url))
    entry = find_dispatch(dispatch_id)
    if entry.get("target") != canonical:
        raise RuntimeError(f"Dispatch {dispatch_id} is for {entry.get('target')}, not {canonical}.")
    if "finish" in entry:
        raise RuntimeError(f"Dispatch {dispatch_id} already finished ({entry['finish'].get('outcome')}).")
    if latest_dispatch(canonical)["dispatchId"] != dispatch_id:
        raise RuntimeError(f"A later dispatch replaced dispatch {dispatch_id} for {canonical}.")
    return {key: value for key, value in entry.items() if key != "event"}


def finish(dispatch_id, outcome, now=None):
    """Close a dispatch, so select no longer skips its pull request."""
    entry = find_dispatch(dispatch_id)
    if "finish" in entry:
        raise RuntimeError(f"Dispatch {dispatch_id} already finished ({entry['finish'].get('outcome')}).")
    return append_dispatch_entry({
        "event": "finish",
        "dispatchId": dispatch_id,
        "target": entry["target"],
        "outcome": post_text.single_line("outcome", outcome),
        "finishedAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
    })


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
    choose.add_argument(
        "--redispatch-after-hours", type=float, default=REDISPATCH_AFTER_HOURS,
        help=f"Hours after which an unfinished dispatch no longer blocks a pull request (default {REDISPATCH_AFTER_HOURS}).",
    )
    send = commands.add_parser("dispatch", help="Record a dispatch and print the thread to launch for it.")
    send.add_argument("--target", required=True, help="Selected pull request URL.")
    send.add_argument("--head", required=True, help="Full head SHA from `select`.")
    send.add_argument("--query", required=True, help="The query as `select` ran it.")
    send.add_argument("--harness", required=True, choices=sorted(INVOKE), help="Harness of the launched thread.")
    send.add_argument("--include-draft", action="store_true", help="The run reviews drafts.")
    send.add_argument("--settings", help="Review Once settings that the run passes on, in one line.")
    send.add_argument(
        "--redispatch-after-hours", type=float, default=REDISPATCH_AFTER_HOURS,
        help=f"Hours after which an unfinished dispatch no longer blocks a pull request (default {REDISPATCH_AFTER_HOURS}).",
    )
    check = commands.add_parser("verify", help="Verify the dispatch of a launched thread.")
    check.add_argument("--dispatch-id", required=True)
    check.add_argument("--target", required=True, help="Pull request URL from the launch prompt.")
    close = commands.add_parser("finish", help="Close a dispatch.")
    close.add_argument("--dispatch-id", required=True)
    close.add_argument("--outcome", required=True, help="One-line outcome, for example `posted`, `no-findings`, or `skip`.")
    args = parser.parse_args()
    try:
        if args.command == "select":
            output = select(
                args.query, args.host, args.max_reviews, args.scan_limit, args.include_draft, args.oldest_first,
                args.redispatch_after_hours,
            )
        elif args.command == "dispatch":
            output = dispatch(
                args.target, args.head, args.query, args.harness, args.include_draft, args.settings,
                redispatch_after_hours=args.redispatch_after_hours,
            )
        elif args.command == "verify":
            output = verify(args.dispatch_id, args.target)
        else:
            output = finish(args.dispatch_id, args.outcome)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
