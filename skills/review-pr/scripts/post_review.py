#!/usr/bin/env python3
"""Render prioritized review findings as one GitHub pull request review.

`render` reads a findings file, reads the pull request, its author, and its
diff at the reviewed head, chooses the verdict and the review event from the
priorities, and writes three files to a new output directory:

- `review-body.md`: the review body without the info panel. It has the
  verdict, the optional summary, the counts, and the findings that cannot be
  inline.
- `comments.json`: one inline comment for each finding whose location is on a
  line of the diff, in the `post-text` comment format.
- `plan.json`: the author and their role, the verdict, the event, the head,
  the counts, and where each finding went and why.

The verdict policy:

- A P0 or P1 finding: "Request changes" (REQUEST_CHANGES).
- Otherwise a P2 finding: for an external contributor, "Request changes"
  (REQUEST_CHANGES). For a team member (author association OWNER, MEMBER, or
  COLLABORATOR), the pull request is not blocked.
- Otherwise (only P3 findings, or none): the pull request is not blocked. P3
  findings never block the pull request.

A review that the policy does not block is "Approve with changes" (with P2
findings) or "Approve", and its event is APPROVE. The human's request to post
the review is the request for this event.

`leaning` reads the pull request author and prints the verdict that the policy
gives for a list of priorities, with the approval: "Request changes", "Approve
with changes", or "Approve". The review report uses it for its leaning. It
posts nothing.

The policy is the default. The human's decision overrides it: `--event
REQUEST_CHANGES` or `--event APPROVE` sets the verdict and the event that the
human chose, whatever the priorities give. A human request for changes with
no P0–P2 finding makes the P3 findings the items to fix before merge, and they
are labelled that way. A human approval with P0–P2 findings is "Approve with
changes". The plan shows the policy verdict beside the chosen one.

When GitHub does not allow the event (the authenticated account wrote the pull
request), or `--comment-only` is given (the human asked for a comment-only
review, or confirmed it for repository rules that forbid the event), the event
is COMMENT and the body says why. Prepare, approve, and post the result with
`post-text`.
"""

import argparse
import json
from pathlib import Path
import re
import sys

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
import post_text  # noqa: E402

PRIORITIES = ("P0", "P1", "P2", "P3")
LABELS = {"P0": "Blocking", "P1": "Blocking", "P2": "Fix before merge", "P3": "Non-blocking"}
GROUPS = (
    (("P0", "P1"), "P0–P1 (blocking)"),
    (("P2",), "P2 (fix before merge)"),
    (("P3",), "P3 (non-blocking)"),
)
TEAM_ASSOCIATIONS = ("OWNER", "MEMBER", "COLLABORATOR")
ROLES = ("team", "external")
# Each verdict and its event.
VERDICTS = {
    "request-changes": ("Request changes", "REQUEST_CHANGES"),
    "approve-with-changes": ("Approve with changes", "APPROVE"),
    "approve": ("Approve", "APPROVE"),
}
# The events a human can choose for the review with `--event`, and the verdict each one sets.
HUMAN_EVENTS = ("REQUEST_CHANGES", "APPROVE")
FINDING_KEYS = {"priority", "title", "body", "path", "line", "start_line", "side", "start_side"}
LOCATION_KEYS = ("path", "line", "start_line", "side", "start_side")
SHA = re.compile(r"[0-9a-f]{7,64}")
# A finding states the problem only. These patterns find a suggested fix in a body.
FIX_PATTERNS = (
    re.compile(r"^\s*(?:`{3,}|~{3,})\s*suggestion\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^[\s>*_#-]*suggested fix", re.IGNORECASE | re.MULTILINE),
)


def normalize_finding(index, finding):
    label = f"findings[{index}]"
    if not isinstance(finding, dict):
        raise ValueError(f"{label} must be an object.")
    unknown = set(finding) - FINDING_KEYS
    if unknown:
        raise ValueError(f"{label} has unknown keys: {', '.join(sorted(unknown))}.")
    if finding.get("priority") not in PRIORITIES:
        raise ValueError(f"{label}.priority must be one of: {', '.join(PRIORITIES)}.")
    title = post_text.single_line(f"{label}.title", str(finding.get("title", "")))
    body = finding.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError(f"{label}.body must be nonempty Markdown text.")
    if any(pattern.search(body) for pattern in FIX_PATTERNS):
        raise ValueError(
            f"{label}.body has a suggested fix. State the problem only: remove the suggested fix "
            "and any suggestion block."
        )
    normalized = {"priority": finding["priority"], "title": title, "body": body.replace("\r\n", "\n").strip()}
    location = {key: finding[key] for key in LOCATION_KEYS if key in finding}
    if location:
        if "path" not in location or "line" not in location:
            raise ValueError(f"{label} needs both path and line for a location, or neither.")
        # Reuse the post-text checks for the location fields; the body here is a placeholder.
        normalized["location"] = post_text.normalize_comment(index, {**location, "body": "-"})
        del normalized["location"]["body"]
    return normalized


def load_findings(data):
    if not isinstance(data, dict):
        raise ValueError("The findings file must contain a JSON object.")
    unknown = set(data) - {"summary", "findings"}
    if unknown:
        raise ValueError(f"The findings file has unknown keys: {', '.join(sorted(unknown))}.")
    summary = data.get("summary", "")
    if not isinstance(summary, str):
        raise ValueError("summary must be Markdown text (omit it or use \"\" for no summary).")
    findings = data.get("findings")
    if not isinstance(findings, list):
        raise ValueError("findings must be a JSON array ([] when there is no finding).")
    findings = [normalize_finding(index, finding) for index, finding in enumerate(findings)]
    findings.sort(key=lambda item: item["priority"])
    return summary.replace("\r\n", "\n").strip(), findings


def author_role(pull, override=None):
    """Return (role, source). A team member has an OWNER, MEMBER, or COLLABORATOR association."""
    association = pull.get("author_association") or "NONE"
    if override is not None:
        if override not in ROLES:
            raise ValueError(f"The author role must be one of: {', '.join(ROLES)}.")
        return override, f"set by the human (GitHub author association: {association})"
    role = "team" if association in TEAM_ASSOCIATIONS else "external"
    return role, f"GitHub author association: {association}"


def choose_verdict(findings, role):
    priorities = {item["priority"] for item in findings}
    if priorities & {"P0", "P1"}:
        return "request-changes"
    if "P2" in priorities:
        return "approve-with-changes" if role == "team" else "request-changes"
    return "approve"


def human_verdict(event, findings):
    """Return the verdict for the event the human chose."""
    if event not in HUMAN_EVENTS:
        raise ValueError(f"The human event must be one of: {', '.join(HUMAN_EVENTS)}.")
    if event == "REQUEST_CHANGES":
        return "request-changes"
    blocking = {item["priority"] for item in findings} & {"P0", "P1", "P2"}
    return "approve-with-changes" if blocking else "approve"


def p3_blocks(verdict, findings):
    """True when the review requests changes and only P3 findings can be the reason."""
    priorities = {item["priority"] for item in findings}
    return verdict == "request-changes" and not priorities & {"P0", "P1", "P2"}


def verdict_name(verdict):
    return VERDICTS[verdict][0]


def verdict_text(verdict, findings):
    priorities = {item["priority"] for item in findings}
    if verdict == "request-changes":
        if p3_blocks(verdict, findings):
            if findings:
                return "This review requests changes. Fix the P3 items before merge."
            return "This review requests changes."
        items = []
        if priorities & {"P0", "P1"}:
            items.append("the blocking P0–P1 items")
        if "P2" in priorities:
            items.append("the P2 items")
        text = f"This review requests changes. Fix {' and '.join(items)} before merge."
    elif verdict == "approve-with-changes":
        items = []
        if priorities & {"P0", "P1"}:
            items.append("the P0–P1 items")
        if "P2" in priorities:
            items.append("the P2 items")
        text = f"This review approves the pull request with changes. Fix {' and '.join(items)} before merge."
    elif findings:
        return "This review approves the pull request. The P3 items are optional and do not block the merge."
    else:
        return "This review approves the pull request. It found no problems in the reviewed scope."
    if "P3" in priorities:
        text += " The P3 items are optional and do not block the merge."
    return text


def choose_event(verdict, pull, login, comment_only):
    """Return (event, note). The note says why the event is COMMENT instead of the verdict's event."""
    event = VERDICTS[verdict][1]
    if comment_only:
        return "COMMENT", comment_only
    if pull["user"]["login"] == login:
        return "COMMENT", f"GitHub does not let the account {login} approve or request changes on its own pull request"
    return event, None


def where(location):
    if location is None:
        return "the whole change"
    lines = str(location["line"])
    if "start_line" in location:
        lines = f"{location['start_line']}-{lines}"
    side = " (removed lines)" if location["side"] == "LEFT" else ""
    return f"`{location['path']}:{lines}`{side}"


def label(finding, blocking_p3):
    return LABELS["P2"] if blocking_p3 and finding["priority"] == "P3" else LABELS[finding["priority"]]


def heading(finding, blocking_p3=False):
    return f"{finding['priority']} · {label(finding, blocking_p3)} · {finding['title']}"


def inline_body(finding, blocking_p3=False):
    optional = finding["priority"] == "P3" and not blocking_p3
    note = "\n\n_Optional. This does not block the merge._" if optional else ""
    return f"**{heading(finding, blocking_p3)}**{note}\n\n{finding['body']}\n"


def indent(text):
    return "\n".join(f"  {line}" if line else "" for line in text.split("\n"))


def place(findings, files, blocking_p3=False):
    """Split findings into inline comments and body items, with the reason for each body item."""
    inline, body = [], []
    for finding in findings:
        location = finding.get("location")
        if location is None:
            body.append((finding, "no single location in the diff"))
            continue
        comment = {**location, "body": inline_body(finding, blocking_p3)}
        problems = post_text.diff_problems([comment], files)
        if problems:
            body.append((finding, problems[0].split(": ", 1)[1]))
        else:
            inline.append((finding, comment))
    return inline, body


def render_body(summary, head, verdict, findings, inline, body, note, blocking_p3=False):
    parts = [f"**Verdict: {verdict_name(verdict)}**", "", verdict_text(verdict, findings), ""]
    if summary:
        parts += [summary, ""]
    parts.append(f"Reviewed commit: `{head}`")
    if findings:
        parts.append("")
        for priorities, name in GROUPS:
            if blocking_p3 and priorities == ("P3",):
                name = "P3 (fix before merge)"
            total = sum(1 for item in findings if item["priority"] in priorities)
            placed = sum(1 for item, _ in inline if item["priority"] in priorities)
            if total:
                parts.append(f"- {name}: {total} ({placed} inline)")
    if note:
        parts += ["", f"This review is posted as a comment because {note}. The verdict above still applies."]
    if body:
        parts += ["", "### Items that cannot be inline", ""]
        for finding, _ in body:
            parts.append(f"- **{heading(finding, blocking_p3)}** — {where(finding.get('location'))}")
            parts.append("")
            parts.append(indent(finding["body"]))
            parts.append("")
        while parts[-1] == "":
            parts.pop()
    return "\n".join(parts) + "\n"


def render(data, url, head, author=None, comment_only=None, event=None):
    target = post_text.parse_pull_target(url)
    if not SHA.fullmatch(head):
        raise ValueError("Provide the full or abbreviated SHA of the reviewed commit.")
    if comment_only is not None and event is not None:
        raise ValueError("Give --event or --comment-only, not both.")
    if event is not None and event not in HUMAN_EVENTS:
        raise ValueError(f"The human event must be one of: {', '.join(HUMAN_EVENTS)}.")
    if comment_only is not None:
        comment_only = post_text.single_line("comment-only reason", comment_only).rstrip(".")
    summary, findings = load_findings(data)
    pull = post_text.pull_request(target)
    if pull.get("state") != "open":
        raise RuntimeError(f"The pull request is {'merged' if pull.get('merged_at') else pull.get('state')}.")
    current = pull["head"]["sha"]
    if not current.startswith(head):
        raise RuntimeError(
            f"The pull request head is {current}, not the reviewed commit {head}. "
            "The findings do not apply to the current head."
        )
    login = post_text.gh_api(target["host"], "user")["login"]
    files = post_text.gh_api(
        target["host"], f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}/files?per_page=100",
        paginate=True,
    )
    if post_text.pull_head(target) != current:
        raise RuntimeError("The pull request head changed while the diff was read. Run render again.")
    role, source = author_role(pull, author)
    policy = choose_verdict(findings, role)
    verdict = policy if event is None else human_verdict(event, findings)
    blocking_p3 = p3_blocks(verdict, findings)
    event, note = choose_event(verdict, pull, login, comment_only)
    inline, body = place(findings, files, blocking_p3)
    plan = {
        "target": post_text.canonical_pull_url(target),
        "head": current,
        "author": {"login": pull["user"]["login"], "role": role, "source": source},
        "verdict": verdict_name(verdict),
        "verdictSource": "policy" if verdict == policy else "human",
        "policyVerdict": verdict_name(policy),
        "event": event,
        "eventNote": note,
        "counts": {priority: sum(1 for item in findings if item["priority"] == priority) for priority in PRIORITIES},
        "inline": [{"title": f["title"], "priority": f["priority"], "at": where(f["location"])} for f, _ in inline],
        "body": [
            {"title": f["title"], "priority": f["priority"], "at": where(f.get("location")), "reason": reason}
            for f, reason in body
        ],
    }
    return {
        "review-body.md": render_body(summary, current, verdict, findings, inline, body, note, blocking_p3),
        "comments.json": json.dumps([comment for _, comment in inline], ensure_ascii=False, indent=2) + "\n",
        "plan.json": json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
    }, plan


def leaning(url, priorities, author=None):
    """Return the author and the verdict that the policy gives for the priorities."""
    for priority in priorities:
        if priority not in PRIORITIES:
            raise ValueError(f"A priority must be one of: {', '.join(PRIORITIES)}.")
    pull = post_text.pull_request(post_text.parse_pull_target(url))
    role, source = author_role(pull, author)
    verdict = choose_verdict([{"priority": priority} for priority in priorities], role)
    return {
        "author": {"login": pull["user"]["login"], "role": role, "source": source},
        "verdict": verdict_name(verdict),
        "counts": {priority: priorities.count(priority) for priority in PRIORITIES},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("render", help="Choose the verdict and write the review body, comments, and plan.")
    build.add_argument("--findings", required=True, type=Path, help="JSON file with the findings and an optional summary.")
    build.add_argument("--target", required=True, help="GitHub pull request URL.")
    build.add_argument("--head", required=True, help="SHA of the reviewed commit.")
    build.add_argument("--out-dir", required=True, type=Path, help="New directory for the output files.")
    build.add_argument(
        "--author", choices=ROLES,
        help="Author role when the human states it. Default: from the GitHub author association.",
    )
    build.add_argument(
        "--event", choices=HUMAN_EVENTS,
        help="The event the human chose. It overrides the policy and sets the verdict.",
    )
    build.add_argument(
        "--comment-only", metavar="REASON",
        help="Post as COMMENT when the human asks for that, or confirms it for repository rules that forbid "
        "the event. The body keeps the verdict.",
    )
    lean = commands.add_parser("leaning", help="Print the policy verdict for the priorities.")
    lean.add_argument("--target", required=True, help="GitHub pull request URL.")
    lean.add_argument(
        "--priority", action="append", default=[], metavar="P0-P3",
        help="Priority of one finding. Repeat for each finding; omit when there is none.",
    )
    lean.add_argument(
        "--author", choices=ROLES,
        help="Author role when the human states it. Default: from the GitHub author association.",
    )
    args = parser.parse_args()
    if args.command == "leaning":
        try:
            print(json.dumps(leaning(args.target, args.priority, args.author), ensure_ascii=False, indent=2))
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            parser.exit(1, f"{error}\n")
        return 0
    try:
        data = json.loads(args.findings.read_text(encoding="utf-8"))
        outputs, plan = render(data, args.target, args.head.strip(), args.author, args.comment_only, args.event)
        args.out_dir.mkdir(parents=True, exist_ok=False)
        for name, text in outputs.items():
            (args.out_dir / name).write_text(text, encoding="utf-8")
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
