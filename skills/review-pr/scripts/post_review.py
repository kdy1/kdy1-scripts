#!/usr/bin/env python3
"""Render prioritized review findings as one GitHub pull request review.

`render` reads a findings file, reads the pull request, its author, and its
diff at the reviewed head, chooses the verdict and the review event from the
priorities, and writes three files to a new output directory:

- `review-body.md`: the review body without the info panel. It has the
  verdict, the summary, the counts, and the findings that cannot be inline.
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

The helper approves only with `--approve`, which the human must ask for. A
review that is not blocked is then "Approve with changes" (with P2 findings) or
"Approve" (APPROVE). Without `--approve`, it is a COMMENT review. `--approve`
fails when the policy requests changes.

When GitHub does not allow the event (the authenticated account wrote the pull
request), or `--comment-only` is given, the event is COMMENT and the body says
why. Prepare, approve, and post the result with `post-text`.
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
# Each policy result: its verdict and event with an approval, and without one.
VERDICTS = {
    "request-changes": (("Request changes", "REQUEST_CHANGES"), ("Request changes", "REQUEST_CHANGES")),
    "approve-with-changes": (("Approve with changes", "APPROVE"), ("Changes suggested", "COMMENT")),
    "approve": (("Approve", "APPROVE"), ("No blocking problems", "COMMENT")),
}
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
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("summary must be nonempty Markdown text.")
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


def verdict_name(verdict, approve, findings):
    if verdict == "approve" and not approve and not findings:
        return "No problems found"
    return VERDICTS[verdict][0 if approve else 1][0]


def verdict_text(verdict, approve, findings):
    priorities = {item["priority"] for item in findings}
    if verdict != "request-changes" and not approve:
        if not findings:
            return "This review found no problems in the reviewed scope."
        text = "This review does not block the pull request."
        if "P2" in priorities:
            text += " Fix the P2 items before merge."
        if "P3" in priorities:
            text += " The P3 items are optional and do not block the merge."
        return text
    if verdict == "request-changes":
        items = []
        if priorities & {"P0", "P1"}:
            items.append("the blocking P0–P1 items")
        if "P2" in priorities:
            items.append("the P2 items")
        text = f"This review requests changes. Fix {' and '.join(items)} before merge."
    elif verdict == "approve-with-changes":
        text = "This review approves the pull request with changes. Fix the P2 items before merge."
    elif findings:
        return "This review approves the pull request. The P3 items are optional and do not block the merge."
    else:
        return "This review approves the pull request. It found no problems in the reviewed scope."
    if "P3" in priorities:
        text += " The P3 items are optional and do not block the merge."
    return text


def choose_event(verdict, approve, pull, login, comment_only):
    """Return (event, note). The note says why the event is COMMENT instead of the verdict's event."""
    if approve and verdict == "request-changes":
        raise ValueError(
            "The policy requests changes for these findings (a P0 or P1, or a P2 from an external contributor). "
            "Do not approve; ask the human whether the priorities or the author role are wrong."
        )
    event = VERDICTS[verdict][0 if approve else 1][1]
    if event == "COMMENT":
        return event, None
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


def heading(finding):
    return f"{finding['priority']} · {LABELS[finding['priority']]} · {finding['title']}"


def inline_body(finding):
    note = "\n\n_Optional. This does not block the merge._" if finding["priority"] == "P3" else ""
    return f"**{heading(finding)}**{note}\n\n{finding['body']}\n"


def indent(text):
    return "\n".join(f"  {line}" if line else "" for line in text.split("\n"))


def place(findings, files):
    """Split findings into inline comments and body items, with the reason for each body item."""
    inline, body = [], []
    for finding in findings:
        location = finding.get("location")
        if location is None:
            body.append((finding, "no single location in the diff"))
            continue
        comment = {**location, "body": inline_body(finding)}
        problems = post_text.diff_problems([comment], files)
        if problems:
            body.append((finding, problems[0].split(": ", 1)[1]))
        else:
            inline.append((finding, comment))
    return inline, body


def render_body(summary, head, verdict, approve, findings, inline, body, note):
    parts = [
        f"**Verdict: {verdict_name(verdict, approve, findings)}**", "",
        verdict_text(verdict, approve, findings), "", summary, "",
    ]
    parts.append(f"Reviewed commit: `{head}`")
    if findings:
        parts.append("")
        for priorities, name in GROUPS:
            total = sum(1 for item in findings if item["priority"] in priorities)
            placed = sum(1 for item, _ in inline if item["priority"] in priorities)
            if total:
                parts.append(f"- {name}: {total} ({placed} inline)")
    if note:
        parts += ["", f"This review is posted as a comment because {note}. The verdict above still applies."]
    if body:
        parts += ["", "### Items that cannot be inline", ""]
        for finding, _ in body:
            parts.append(f"- **{heading(finding)}** — {where(finding.get('location'))}")
            parts.append("")
            parts.append(indent(finding["body"]))
            parts.append("")
        while parts[-1] == "":
            parts.pop()
    return "\n".join(parts) + "\n"


def render(data, url, head, author=None, comment_only=None, approve=False):
    target = post_text.parse_pull_target(url)
    if not SHA.fullmatch(head):
        raise ValueError("Provide the full or abbreviated SHA of the reviewed commit.")
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
    verdict = choose_verdict(findings, role)
    event, note = choose_event(verdict, approve, pull, login, comment_only)
    inline, body = place(findings, files)
    plan = {
        "target": post_text.canonical_pull_url(target),
        "head": current,
        "author": {"login": pull["user"]["login"], "role": role, "source": source},
        "verdict": verdict_name(verdict, approve, findings),
        "approve": approve,
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
        "review-body.md": render_body(summary, current, verdict, approve, findings, inline, body, note),
        "comments.json": json.dumps([comment for _, comment in inline], ensure_ascii=False, indent=2) + "\n",
        "plan.json": json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
    }, plan


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("render", help="Choose the verdict and write the review body, comments, and plan.")
    build.add_argument("--findings", required=True, type=Path, help="JSON file with the summary and findings.")
    build.add_argument("--target", required=True, help="GitHub pull request URL.")
    build.add_argument("--head", required=True, help="SHA of the reviewed commit.")
    build.add_argument("--out-dir", required=True, type=Path, help="New directory for the output files.")
    build.add_argument(
        "--author", choices=ROLES,
        help="Author role when the human states it. Default: from the GitHub author association.",
    )
    build.add_argument(
        "--approve", action="store_true",
        help="Approve a review that the policy does not block. Use only when the human asks to approve.",
    )
    build.add_argument(
        "--comment-only", metavar="REASON",
        help="Post as COMMENT, for example when repository rules forbid the event. The body keeps the verdict.",
    )
    args = parser.parse_args()
    try:
        data = json.loads(args.findings.read_text(encoding="utf-8"))
        outputs, plan = render(data, args.target, args.head.strip(), args.author, args.comment_only, args.approve)
        args.out_dir.mkdir(parents=True, exist_ok=False)
        for name, text in outputs.items():
            (args.out_dir / name).write_text(text, encoding="utf-8")
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
