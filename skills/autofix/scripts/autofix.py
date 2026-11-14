#!/usr/bin/env python3
"""Deterministic helpers for Autofix: issue intake, the PR gate, and the AI footer.

The PR gate passes only when an Iterate with Review ledger finished with a clean round
at the exact commit that is about to be published.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from html import escape
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "iterate-with-review" / "scripts"))
sys.path.insert(0, str(SKILLS / "review-once" / "scripts"))
from iterate_with_review import load  # noqa: E402
from review_once import REVIEWERS, git, run  # noqa: E402

LINEAR_HELPER = SKILLS / "add-issue" / "scripts" / "linear-issue.mjs"
GITHUB_ISSUE = re.compile(r"^https://([^/]+)/([\w.-]+)/([\w.-]+)/issues/([1-9]\d*)/?(?:[?#].*)?$")
LINEAR_ISSUE = re.compile(r"^https://linear\.app/([\w-]+)/issue/(([A-Za-z0-9]+)-[1-9]\d*)(?:/[^?#]*)?(?:[?#].*)?$")
ISSUE_FIELDS = "number,url,title,body,state,stateReason,comments,closedByPullRequestsReferences"


def parse_issue(url):
    """Return a dict that identifies a GitHub or Linear issue URL."""
    url = url.strip()
    match = GITHUB_ISSUE.match(url)
    if match:
        host, owner, name, number = match.groups()
        return {"tracker": "github", "host": host, "repository": f"{owner}/{name}",
                "number": int(number), "url": f"https://{host}/{owner}/{name}/issues/{number}"}
    match = LINEAR_ISSUE.match(url)
    if match:
        workspace, identifier, team = match.groups()
        identifier = identifier.upper()
        return {"tracker": "linear", "workspace": workspace, "team": team.upper(),
                "identifier": identifier, "url": f"https://linear.app/{workspace}/issue/{identifier}"}
    raise ValueError(f"Expected a GitHub or Linear issue URL: {url!r}")


def reference(issue):
    """Return the standalone PR body line that closes the issue when the PR merges."""
    if issue["tracker"] == "github":
        return f"Closes {issue['url']}"
    # Linear's GitHub integration closes the issue on merge for this magic word.
    return f"Closes {issue['identifier']}"


def fetch_github(issue):
    data = json.loads(run(["gh", "issue", "view", issue["url"], "--json", ISSUE_FIELDS]))
    if "/pull/" in (data.get("url") or ""):
        raise ValueError(f"{issue['url']} is a pull request, not an issue")
    return {
        "title": data["title"], "body": data.get("body") or "", "state": data["state"],
        "stateReason": data.get("stateReason") or None,
        "comments": [{"author": (c.get("author") or {}).get("login"), "body": c.get("body") or "",
                      "url": c.get("url")} for c in data.get("comments") or []],
        "linkedPullRequests": [pr.get("url") for pr in data.get("closedByPullRequestsReferences") or []],
    }


def fetch_linear(issue):
    """Read the issue and comments through the add-issue Linear helper."""
    if not LINEAR_HELPER.is_file():
        raise ValueError(f"Linear issues need the add-issue skill: {LINEAR_HELPER} is missing")
    with tempfile.TemporaryDirectory(prefix="autofix-") as tmp:
        request, output = Path(tmp, "collect.json"), Path(tmp, "observations.json")
        request.write_text(json.dumps({
            "version": 1, "target": {"workspace": issue["workspace"], "team": issue["team"]},
            "issueUrl": issue["url"], "includeComments": True,
        }), encoding="utf-8")
        result = subprocess.run(["node", str(LINEAR_HELPER), "collect", str(request), str(output)],
                                capture_output=True, text=True)
        observed = json.loads(output.read_text(encoding="utf-8")) if output.is_file() else {}
    if observed.get("authRequired"):
        raise RuntimeError("Linear authentication is required; follow add-issue's Linear auth steps")
    observations = observed.get("observations") or {}
    found = observations.get("issue") or {}
    if not found.get("available"):
        detail = found.get("reason") or "; ".join(observed.get("errors") or []) \
            or result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"Linear collect failed: {detail}")
    data = found["value"]
    comments = (observations.get("comments") or {}).get("value") or []
    return {
        "title": data.get("title") or "", "body": data.get("body") or "",
        "state": data.get("state"), "closed": data.get("open") is False,
        "comments": [{"author": c.get("author"), "body": c.get("body") or "", "url": c.get("url")}
                     for c in comments],
        "linkedPullRequests": [],
    }


def intent_text(issue, details):
    parts = [f"Issue: {issue['url']}", f"Title: {details['title']}", "", details["body"].strip()]
    for comment in details["comments"]:
        if comment["body"].strip():
            parts += ["", f"Comment by {comment['author'] or 'unknown'}:", comment["body"].strip()]
    return "\n".join(parts).strip() + "\n"


def default_dir():
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "autofix"


def intake(url, out_dir=None, fetch=None):
    """Read the issue, write the Iterate with Review intent file, and return the facts."""
    issue = parse_issue(url)
    details = (fetch or {"github": fetch_github, "linear": fetch_linear}[issue["tracker"]])(issue)
    key = issue.get("identifier") or f"{issue['repository'].replace('/', '-')}-{issue['number']}"
    intent_file = Path(out_dir or default_dir()) / f"{key}.intent.md"
    intent_file.parent.mkdir(parents=True, exist_ok=True)
    intent_file.write_text(intent_text(issue, details), encoding="utf-8")
    closed = details.get("closed", details["state"] == "CLOSED")
    return dict(issue, title=details["title"], state=details["state"], closed=closed,
                stateReason=details.get("stateReason"), comments=len(details["comments"]),
                linkedPullRequests=details["linkedPullRequests"], reference=reference(issue),
                intentFile=str(intent_file))


def gate(ledger_path):
    """Return the publishable state, or raise when the ledger does not allow a PR yet."""
    ledger = load(ledger_path)
    repo = ledger["workspace"]
    rounds = ledger.get("rounds") or []
    last = rounds[-1] if rounds else None
    problems = []
    if not ledger.get("finished") or not last or last.get("status") != "clean":
        problems.append("Iterate with Review has not finished with a clean round")
    branch = git(repo, "branch", "--show-current")
    if branch != ledger["branch"]:
        problems.append(f"workspace is on {branch or 'a detached HEAD'}, not {ledger['branch']}")
    status = git(repo, "status", "--porcelain")
    if status:
        problems.append(f"workspace has uncommitted changes:\n{status}")
    head = git(repo, "rev-parse", "HEAD")
    if last and head != last.get("head"):
        problems.append(f"HEAD {head[:12]} is not the clean round's commit {str(last.get('head'))[:12]}; "
                        "run another Iterate with Review round")
    if problems:
        raise ValueError("PR gate is closed:\n" + "\n".join(f"- {p}" for p in problems))
    return {"ok": True, "workspace": repo, "branch": branch, "base": ledger["base"], "head": head,
            "rounds": len(rounds), "reviewers": reviewer_models(ledger)}


def reviewer_models(ledger):
    """Return 'provider/model' for each reviewer that completed at least one round."""
    done = {r["slug"] for entry in ledger.get("rounds", []) for r in entry.get("reviewers", [])
            if r.get("complete")}
    return [f"{provider}/{model}" for slug, provider, model in REVIEWERS if slug in done]


def identity(value):
    """Keep the footer on one line and represent missing metadata explicitly."""
    return escape(" ".join((value or "").split()) or "unknown")


def attribution(harness, model, effort=None, ledger=None):
    """Render the PR body footer in the small-text form used by Static Analysis."""
    fields = [f"Harness: {identity(harness)}", f"Model: {identity(model)}"]
    if effort and effort.strip():
        fields.append(f"Reasoning effort: {identity(effort)}")
    if ledger:
        rounds = len(ledger.get("rounds", []))
        fields.append(f"Review: Iterate with Review, {rounds} round{'s' if rounds != 1 else ''}")
        reviewers = reviewer_models(ledger)
        if reviewers:
            fields.append(f"Reviewers: {identity(', '.join(reviewers))}")
    return f"<sub>Autofix — {'; '.join(fields)}</sub>"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("issue", help="Read the issue and write the review intent file")
    read.add_argument("url")
    read.add_argument("--out-dir", help="Directory for the intent file (default: ~/.cache/autofix)")
    check = sub.add_parser("gate", help="Allow a PR only after a clean Iterate with Review round")
    check.add_argument("ledger")
    footer = sub.add_parser("attribution", help="Print the AI attribution footer for the PR body")
    footer.add_argument("--harness", required=True)
    footer.add_argument("--model", required=True)
    footer.add_argument("--effort", help="Reasoning effort, only when the session reports it")
    footer.add_argument("--ledger", help="Iterate with Review ledger, to list the review rounds and models")
    args = parser.parse_args()
    try:
        if args.command == "issue":
            print(json.dumps(intake(args.url, args.out_dir), indent=2, ensure_ascii=False))
        elif args.command == "gate":
            print(json.dumps(gate(args.ledger), indent=2))
        elif args.command == "attribution":
            print(attribution(args.harness, args.model, args.effort,
                              load(args.ledger) if args.ledger else None))
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        parser.exit(1, f"autofix: {error}\n")


if __name__ == "__main__":
    main()
