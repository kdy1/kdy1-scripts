#!/usr/bin/env python3
"""Deterministic steps of Auto Review PR Strict, the automation-safe pull request review.

`check` decides whether the pull request needs a review now. It skips a pull
request that is not open, a draft (unless `--include-draft`), and a head that
this workflow already reviewed: a head in the local ledger, or a review by the
authenticated account at that commit whose body names this workflow. It also
lists this workflow's earlier change requests on other commits, with their
inline comments, so the coordinator can check them again at the new head.

`render` validates the gated findings and writes three files to a new output
directory: `review-body.md`, `comments.json` (in the `post-text` comment
format), and `plan.json`. Every finding must be a P0 or P1 problem that the
pull request introduces, with one command and its result on the base and on
the head. The helper writes the evidence into each comment, so no comment can
go out without it. The event is REQUEST_CHANGES; it becomes COMMENT when the
authenticated account wrote the pull request, or with `--comment-only`.

`record` appends the outcome of a completed run to the ledger, so the next run
skips that head. `dismiss-stale` dismisses this workflow's earlier
CHANGES_REQUESTED reviews on other commits after a completed run at the
current head, and reads each one back.

Post the rendered review with `auto-post-text post-review`.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
import post_text  # noqa: E402

WORKFLOW = "Auto Review PR Strict"
WORKFLOW_LINE = f"> - Workflow: {WORKFLOW}"
KINDS = {
    "behavior": "Regression",
    "check": "Broken check",
}
PRIORITIES = ("P0", "P1")
FINDING_KEYS = {"kind", "priority", "title", "problem", "evidence", "fix", *post_text.COMMENT_KEYS} - {"body"}
LOCATION_KEYS = ("path", "line", "start_line", "side", "start_side")
EVIDENCE_KEYS = {"command", "base", "head"}
OUTCOMES = ("posted", "no-findings")
SHA = re.compile(r"[0-9a-f]{7,64}")
FULL_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def ledger_path():
    """Return the ledger file. AUTO_REVIEW_PR_STRICT_LEDGER overrides the default location."""
    override = os.environ.get("AUTO_REVIEW_PR_STRICT_LEDGER")
    if override:
        return Path(override)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / "auto-review-pr-strict" / "ledger.jsonl"


def ledger_key(target, head):
    return f"{target['host']}/{target['owner']}/{target['repo']}#{target['number']}@{head}"


def read_ledger(path):
    """Return the ledger entries. A line that is not valid JSON is ignored, not fatal."""
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def text(label, value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be nonempty text.")
    return value.replace("\r\n", "\n").strip()


def normalize_finding(index, finding):
    label = f"findings[{index}]"
    if not isinstance(finding, dict):
        raise ValueError(f"{label} must be an object.")
    unknown = set(finding) - FINDING_KEYS
    if unknown:
        raise ValueError(f"{label} has unknown keys: {', '.join(sorted(unknown))}.")
    if finding.get("kind") not in KINDS:
        raise ValueError(f"{label}.kind must be one of: {', '.join(KINDS)}.")
    if finding.get("priority") not in PRIORITIES:
        raise ValueError(
            f"{label}.priority must be P0 or P1. A P2 or P3 problem does not pass the gate; "
            "list it in the chat report only."
        )
    evidence = finding.get("evidence")
    if not isinstance(evidence, dict) or set(evidence) != EVIDENCE_KEYS:
        raise ValueError(f"{label}.evidence must have exactly: command, base, head.")
    evidence = {key: text(f"{label}.evidence.{key}", evidence[key]) for key in sorted(EVIDENCE_KEYS)}
    if evidence["base"] == evidence["head"]:
        raise ValueError(f"{label}.evidence shows the same result on the base and the head; it is not a regression.")
    normalized = {
        "kind": finding["kind"],
        "priority": finding["priority"],
        "title": post_text.single_line(f"{label}.title", str(finding.get("title", ""))),
        "problem": text(f"{label}.problem", finding.get("problem")),
        "evidence": evidence,
    }
    if "fix" in finding:
        normalized["fix"] = text(f"{label}.fix", finding["fix"])
    location = {key: finding[key] for key in LOCATION_KEYS if key in finding}
    if location:
        if "path" not in location or "line" not in location:
            raise ValueError(f"{label} needs both path and line for a location, or neither.")
        normalized["location"] = post_text.normalize_comment(index, {**location, "body": "-"})
        del normalized["location"]["body"]
    return normalized


def load_findings(data):
    if not isinstance(data, dict):
        raise ValueError("The findings file must contain a JSON object.")
    unknown = set(data) - {"summary", "base", "findings"}
    if unknown:
        raise ValueError(f"The findings file has unknown keys: {', '.join(sorted(unknown))}.")
    summary = text("summary", data.get("summary"))
    base = data.get("base")
    if not isinstance(base, str) or not SHA.fullmatch(base):
        raise ValueError("base must be the SHA of the base commit that the evidence ran on.")
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        raise ValueError(
            "findings must be a nonempty JSON array. When no finding passes the gate, post nothing: "
            "run `record --outcome no-findings` instead."
        )
    findings = [normalize_finding(index, finding) for index, finding in enumerate(findings)]
    findings.sort(key=lambda item: item["priority"])
    return summary, base, findings


def fence(body, language="text"):
    longest = max((len(run) for run in re.findall(r"`+", body)), default=0)
    marks = "`" * max(3, longest + 1)
    return f"{marks}{language}\n{body}\n{marks}"


def where(location):
    if location is None:
        return "the whole change"
    lines = str(location["line"])
    if "start_line" in location:
        lines = f"{location['start_line']}-{lines}"
    side = " (removed lines)" if location["side"] == "LEFT" else ""
    return f"`{location['path']}:{lines}`{side}"


def finding_text(finding, base, head):
    """Return the complete text of one finding, with its evidence. It does not depend on the review body."""
    evidence = finding["evidence"]
    parts = [
        finding["problem"],
        "",
        "**Evidence:** the same command on the base and on the reviewed head.",
        "",
        fence(evidence["command"], "sh"),
        "",
        f"Base (`{base[:12]}`):",
        "",
        fence(evidence["base"]),
        "",
        f"Head (`{head[:12]}`):",
        "",
        fence(evidence["head"]),
    ]
    if "fix" in finding:
        parts += ["", f"**Suggested fix:** {finding['fix']}"]
    return "\n".join(parts)


def heading(finding):
    return f"{KINDS[finding['kind']]} · {finding['priority']} · {finding['title']}"


def inline_body(finding, base, head):
    return (
        f"**{heading(finding)}**\n\n"
        "_This pull request introduces this problem. Fix it before merge._\n\n"
        f"{finding_text(finding, base, head)}\n"
    )


def indent(body):
    return "\n".join(f"  {line}" if line else "" for line in body.split("\n"))


def place(findings, files, base, head):
    """Split findings into inline comments and body items, with the reason for each body item."""
    inline, body = [], []
    for finding in findings:
        location = finding.get("location")
        if location is None:
            body.append((finding, "no single location in the diff"))
            continue
        comment = {**location, "body": inline_body(finding, base, head)}
        problems = post_text.diff_problems([comment], files)
        if problems:
            body.append((finding, problems[0].split(": ", 1)[1]))
        else:
            inline.append((finding, comment))
    return inline, body


def render_body(summary, head, findings, inline, body, downgrade, base):
    parts = [
        summary,
        "",
        f"Reviewed commit: `{head}`",
        "",
        "This automatic review reports only P0 and P1 problems that this pull request introduces. "
        "For each one, the same command gives the correct result on the base and a wrong result on this head. "
        f"Fix them before merge. Problems found: {len(findings)} ({len(inline)} inline).",
    ]
    if downgrade:
        parts += ["", f"This review requests changes, but it is posted as a comment because {downgrade}."]
    if body:
        parts += ["", "### Problems that cannot be inline", ""]
        for finding, _ in body:
            parts.append(f"- **{heading(finding)}** — {where(finding.get('location'))}")
            parts.append("")
            parts.append(indent(finding_text(finding, base, head)))
            parts.append("")
        while parts[-1] == "":
            parts.pop()
    return "\n".join(parts) + "\n"


def choose_event(pull, login, comment_only):
    if comment_only:
        return "COMMENT", comment_only
    if pull["user"]["login"] == login:
        return "COMMENT", f"GitHub does not let the account {login} request changes on its own pull request"
    return "REQUEST_CHANGES", None


def pulls_path(target):
    return f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}"


def workflow_reviews(target, login):
    """Return the reviews that the authenticated account posted through this workflow."""
    reviews = post_text.gh_api(target["host"], f"{pulls_path(target)}/reviews?per_page=100", paginate=True)
    return [
        review for review in reviews
        if (review.get("user") or {}).get("login") == login
        and WORKFLOW_LINE in (review.get("body") or "").replace("\r\n", "\n").split("\n")
    ]


def check(url, include_draft=False):
    target = post_text.parse_pull_target(url)
    pull = post_text.pull_request(target)
    head = pull["head"]["sha"]
    login = post_text.gh_api(target["host"], "user")["login"]
    result = {
        "target": post_text.canonical_pull_url(target),
        "title": pull.get("title"),
        "state": pull.get("state"),
        "merged": bool(pull.get("merged")),
        "draft": bool(pull.get("draft")),
        "author": pull["user"]["login"],
        "login": login,
        "head": head,
        "base": pull["base"]["sha"],
        "ledger": str(ledger_path()),
        "decision": "review",
        "reason": None,
        "earlierChangeRequests": [],
    }

    def skip(reason):
        result.update(decision="skip", reason=reason)
        return result

    if pull.get("state") != "open":
        return skip("the pull request is merged" if pull.get("merged") else "the pull request is closed")
    if pull.get("draft") and not include_draft:
        return skip("the pull request is a draft")
    key = ledger_key(target, head)
    for entry in read_ledger(ledger_path()):
        if entry.get("key") == key:
            return skip(f"the ledger already has this head ({entry.get('outcome')}, {entry.get('recordedAt')})")
    reviews = workflow_reviews(target, login)
    for review in reviews:
        if review.get("commit_id") == head:
            return skip(f"this workflow already reviewed this head: {review.get('html_url')}")
    for review in reviews:
        if review.get("state") != "CHANGES_REQUESTED":
            continue
        comments = post_text.gh_api(
            target["host"], f"{pulls_path(target)}/reviews/{review['id']}/comments?per_page=100", paginate=True,
        )
        result["earlierChangeRequests"].append({
            "id": review["id"],
            "commit": review.get("commit_id"),
            "url": review.get("html_url"),
            "body": review.get("body"),
            "comments": [
                {"path": item.get("path"), "line": item.get("original_line") or item.get("line"),
                 "body": item.get("body")}
                for item in comments
            ],
        })
    if post_text.pull_head(target) != head:
        return skip("the pull request head changed during the check; the next run reviews the new head")
    return result


def render(data, url, head, comment_only=None):
    target = post_text.parse_pull_target(url)
    if not SHA.fullmatch(head):
        raise ValueError("Provide the full or abbreviated SHA of the reviewed commit.")
    if comment_only is not None:
        comment_only = post_text.single_line("comment-only reason", comment_only).rstrip(".")
    summary, base, findings = load_findings(data)
    pull = post_text.pull_request(target)
    current = pull["head"]["sha"]
    if not current.startswith(head):
        raise RuntimeError(
            f"The pull request head is {current}, not the reviewed commit {head}. Do not post this review."
        )
    login = post_text.gh_api(target["host"], "user")["login"]
    files = post_text.gh_api(target["host"], f"{pulls_path(target)}/files?per_page=100", paginate=True)
    if post_text.pull_head(target) != current:
        raise RuntimeError("The pull request head changed while the diff was read. Do not post this review.")
    inline, body = place(findings, files, base, current)
    event, downgrade = choose_event(pull, login, comment_only)
    plan = {
        "target": post_text.canonical_pull_url(target),
        "head": current,
        "event": event,
        "eventNote": downgrade,
        "workflow": WORKFLOW,
        "inline": [{"title": f["title"], "at": where(f["location"])} for f, _ in inline],
        "body": [
            {"title": f["title"], "at": where(f.get("location")), "reason": reason} for f, reason in body
        ],
    }
    return {
        "review-body.md": render_body(summary, current, findings, inline, body, downgrade, base),
        "comments.json": json.dumps([comment for _, comment in inline], ensure_ascii=False, indent=2) + "\n",
        "plan.json": json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
    }, plan


def record(url, head, outcome, review_url=None, titles=(), now=None):
    """Append the outcome of a completed run to the ledger and return the entry."""
    target = post_text.parse_pull_target(url)
    if not FULL_SHA.fullmatch(head):
        raise ValueError("Provide the full SHA of the reviewed head.")
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of: {', '.join(OUTCOMES)}.")
    if (outcome == "posted") != (review_url is not None):
        raise ValueError("Give --review-url for the posted outcome, and only for it.")
    entry = {
        "key": ledger_key(target, head),
        "target": post_text.canonical_pull_url(target),
        "head": head,
        "outcome": outcome,
        "recordedAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
    }
    if review_url is not None:
        entry["reviewUrl"] = post_text.single_line("review URL", review_url)
    if titles:
        entry["findings"] = [post_text.single_line("finding title", title) for title in titles]
    path = ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as ledger:
        ledger.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    return entry


def dismiss_stale(url, head, keep=()):
    """Dismiss this workflow's CHANGES_REQUESTED reviews on commits other than head, except those in keep."""
    target = post_text.parse_pull_target(url)
    if not FULL_SHA.fullmatch(head):
        raise ValueError("Provide the full SHA of the reviewed head.")
    if post_text.pull_head(target) != head:
        raise RuntimeError("The pull request head is not the reviewed commit. Dismiss nothing.")
    login = post_text.gh_api(target["host"], "user")["login"]
    keep = {int(item) for item in keep}
    results = []
    for review in workflow_reviews(target, login):
        if review.get("state") != "CHANGES_REQUESTED" or review.get("commit_id") == head:
            continue
        if review["id"] in keep:
            results.append({"id": review["id"], "url": review.get("html_url"), "result": "kept"})
            continue
        message = (
            f"{WORKFLOW} reviewed the newer commit {head}. "
            "That review replaces this one; problems that still reproduce are reported there."
        )
        path = f"{pulls_path(target)}/reviews/{review['id']}"
        post_text.gh_api(
            target["host"], "--method", "PUT", f"{path}/dismissals", "--input", "-",
            payload={"message": message, "event": "DISMISS"},
        )
        state = post_text.gh_api(target["host"], path).get("state")
        if state != "DISMISSED":
            raise RuntimeError(f"Review {review.get('html_url')} is {state} after the dismissal, not DISMISSED.")
        results.append({"id": review["id"], "url": review.get("html_url"), "result": "dismissed"})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    checking = commands.add_parser("check", help="Decide whether the pull request head needs a review now.")
    checking.add_argument("--target", required=True, help="GitHub pull request URL.")
    checking.add_argument("--include-draft", action="store_true", help="Review a draft pull request too.")

    build = commands.add_parser("render", help="Write the review body, inline comments, and plan.")
    build.add_argument("--findings", required=True, type=Path, help="JSON file with the gated findings.")
    build.add_argument("--target", required=True, help="GitHub pull request URL.")
    build.add_argument("--head", required=True, help="SHA of the reviewed commit.")
    build.add_argument("--out-dir", required=True, type=Path, help="New directory for the output files.")
    build.add_argument("--comment-only", metavar="REASON", help="Post as COMMENT, for example when repository rules forbid change requests.")

    log = commands.add_parser("record", help="Record the outcome of a completed run in the ledger.")
    log.add_argument("--target", required=True, help="GitHub pull request URL.")
    log.add_argument("--head", required=True, help="Full SHA of the reviewed commit.")
    log.add_argument("--outcome", required=True, choices=OUTCOMES)
    log.add_argument("--review-url", help="URL of the posted review (posted outcome only).")
    log.add_argument("--finding", action="append", default=[], help="Title of a posted finding. Repeat for several.")

    dismiss = commands.add_parser("dismiss-stale", help="Dismiss this workflow's change requests on older commits.")
    dismiss.add_argument("--target", required=True, help="GitHub pull request URL.")
    dismiss.add_argument("--head", required=True, help="Full SHA of the reviewed commit.")
    dismiss.add_argument("--keep", action="append", default=[], help="ID of an earlier review to keep. Repeat for several.")

    args = parser.parse_args()
    try:
        if args.command == "check":
            output = check(args.target, args.include_draft)
        elif args.command == "render":
            data = json.loads(args.findings.read_text(encoding="utf-8"))
            outputs, output = render(data, args.target, args.head.strip(), args.comment_only)
            args.out_dir.mkdir(parents=True, exist_ok=False)
            for name, content in outputs.items():
                (args.out_dir / name).write_text(content, encoding="utf-8")
        elif args.command == "record":
            output = record(args.target, args.head.strip(), args.outcome, args.review_url, args.finding)
        else:
            output = dismiss_stale(args.target, args.head.strip(), args.keep)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
