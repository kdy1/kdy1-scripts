#!/usr/bin/env python3
"""Render verified Auto Review PR findings as one GitHub pull request review.

`render` reads a findings file, reads the pull request and its diff at the
reviewed head, and writes three files to a new output directory:

- `review-body.md`: the review body without the info panel. It has the
  summary, the counts, and the findings that cannot be inline.
- `comments.json`: one inline comment for each finding whose location is on a
  line of the diff, in the `post-text` comment format.
- `plan.json`: the event, the head, the counts, and where each finding went
  and why.

A finding is a "request-changes" item when the pull request introduces the
defect, and a "follow-up" item when it does not. The event is REQUEST_CHANGES
when at least one request-changes item exists, otherwise COMMENT. When GitHub
does not allow the event (the authenticated account wrote the pull request),
or `--comment-only` is given, the event is COMMENT and the body says why.

Post the result with `auto-post-text post-review`.
"""

import argparse
import json
from pathlib import Path
import re
import sys

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
import post_text  # noqa: E402

CLASSES = {
    "request-changes": {
        "label": "Request changes",
        "heading": "Request changes",
        "meaning": "This pull request introduces this problem. Fix it before merge.",
        "section": "This pull request introduces these problems. Fix them before merge.",
    },
    "follow-up": {
        "label": "Optional follow-up",
        "heading": "Optional follow-ups",
        "meaning": "This pull request does not introduce this problem. Fixing it here is optional; "
                   "a follow-up change is also fine.",
        "section": "This pull request does not introduce these problems. Fixing them here is optional; "
                   "follow-up changes are also fine.",
    },
}
PRIORITIES = ("P0", "P1", "P2", "P3")
FINDING_KEYS = {"class", "priority", "title", "body", "path", "line", "start_line", "side", "start_side"}
LOCATION_KEYS = ("path", "line", "start_line", "side", "start_side")
SHA = re.compile(r"[0-9a-f]{7,64}")


def normalize_finding(index, finding):
    label = f"findings[{index}]"
    if not isinstance(finding, dict):
        raise ValueError(f"{label} must be an object.")
    unknown = set(finding) - FINDING_KEYS
    if unknown:
        raise ValueError(f"{label} has unknown keys: {', '.join(sorted(unknown))}.")
    if finding.get("class") not in CLASSES:
        raise ValueError(f"{label}.class must be one of: {', '.join(CLASSES)}.")
    if finding.get("priority") not in PRIORITIES:
        raise ValueError(f"{label}.priority must be one of: {', '.join(PRIORITIES)}.")
    title = post_text.single_line(f"{label}.title", str(finding.get("title", "")))
    body = finding.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError(f"{label}.body must be nonempty Markdown text.")
    normalized = {
        "class": finding["class"], "priority": finding["priority"], "title": title,
        "body": body.replace("\r\n", "\n").strip(),
    }
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
        raise ValueError("findings must be a JSON array ([] when nothing was confirmed).")
    findings = [normalize_finding(index, finding) for index, finding in enumerate(findings)]
    order = list(CLASSES)
    findings.sort(key=lambda item: (order.index(item["class"]), item["priority"]))
    return summary.replace("\r\n", "\n").strip(), findings


def where(location):
    if location is None:
        return "the whole change"
    lines = str(location["line"])
    if "start_line" in location:
        lines = f"{location['start_line']}-{lines}"
    side = " (removed lines)" if location["side"] == "LEFT" else ""
    return f"`{location['path']}:{lines}`{side}"


def inline_body(finding):
    kind = CLASSES[finding["class"]]
    return (
        f"**{kind['label']} · {finding['priority']} · {finding['title']}**\n\n"
        f"_{kind['meaning']}_\n\n{finding['body']}\n"
    )


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


def render_body(summary, head, findings, inline, body, downgrade):
    counts = {kind: sum(1 for item in findings if item["class"] == kind) for kind in CLASSES}
    inline_counts = {kind: sum(1 for item, _ in inline if item["class"] == kind) for kind in CLASSES}
    parts = [summary, "", f"Reviewed commit: `{head}`", ""]
    if not findings:
        parts.append(
            "No reportable problems were found in the reviewed scope. "
            "This does not prove that the change is correct."
        )
    else:
        for kind, data in CLASSES.items():
            parts.append(f"- {data['heading']}: {counts[kind]} ({inline_counts[kind]} inline)")
    if downgrade:
        parts += ["", f"This review requests changes, but it is posted as a comment because {downgrade}."]
    for kind, data in CLASSES.items():
        items = [(finding, reason) for finding, reason in body if finding["class"] == kind]
        if not counts[kind]:
            continue
        parts += ["", f"### {data['heading']}", "", data["section"], ""]
        if inline_counts[kind]:
            parts.append(f"Inline comments on the diff: {inline_counts[kind]}.")
        if items:
            if inline_counts[kind]:
                parts.append("")
            parts += ["Items that cannot be inline:", ""]
        for finding, _ in items:
            location = where(finding.get("location"))
            parts.append(f"- **{finding['priority']} · {finding['title']}** — {location}")
            parts.append("")
            parts.append(indent(finding["body"]))
            parts.append("")
        while parts and parts[-1] == "":
            parts.pop()
    return "\n".join(parts) + "\n"


def choose_event(findings, pull, login, comment_only):
    if not any(item["class"] == "request-changes" for item in findings):
        return "COMMENT", None
    if comment_only:
        return "COMMENT", comment_only
    if pull["user"]["login"] == login:
        return "COMMENT", f"GitHub does not let the account {login} request changes on its own pull request"
    return "REQUEST_CHANGES", None


def render(data, url, head, comment_only=None):
    target = post_text.parse_pull_target(url)
    if not SHA.fullmatch(head):
        raise ValueError("Provide the full or abbreviated SHA of the reviewed commit.")
    if comment_only is not None:
        comment_only = post_text.single_line("comment-only reason", comment_only).rstrip(".")
    summary, findings = load_findings(data)
    pull = post_text.pull_request(target)
    current = pull["head"]["sha"]
    if not current.startswith(head):
        raise RuntimeError(
            f"The pull request head is {current}, not the reviewed commit {head}. "
            "Do not post this review."
        )
    login = post_text.gh_api(target["host"], "user")["login"]
    files = post_text.gh_api(
        target["host"], f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}/files?per_page=100",
        paginate=True,
    )
    if post_text.pull_head(target) != current:
        raise RuntimeError("The pull request head changed while the diff was read. Do not post this review.")
    inline, body = place(findings, files)
    event, downgrade = choose_event(findings, pull, login, comment_only)
    plan = {
        "target": post_text.canonical_pull_url(target),
        "head": current,
        "event": event,
        "eventNote": downgrade,
        "counts": {kind: sum(1 for item in findings if item["class"] == kind) for kind in CLASSES},
        "inline": [{"title": f["title"], "class": f["class"], "at": where(f["location"])} for f, _ in inline],
        "body": [
            {"title": f["title"], "class": f["class"], "at": where(f.get("location")), "reason": reason}
            for f, reason in body
        ],
    }
    return {
        "review-body.md": render_body(summary, current, findings, inline, body, downgrade),
        "comments.json": json.dumps([comment for _, comment in inline], ensure_ascii=False, indent=2) + "\n",
        "plan.json": json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
    }, plan


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("render", help="Write the review body, inline comments, and plan for a PR review.")
    build.add_argument("--findings", required=True, type=Path, help="JSON file with summary and verified findings.")
    build.add_argument("--target", required=True, help="GitHub pull request URL.")
    build.add_argument("--head", required=True, help="SHA of the reviewed commit.")
    build.add_argument("--out-dir", required=True, type=Path, help="New directory for the output files.")
    build.add_argument(
        "--comment-only", metavar="REASON",
        help="Post as COMMENT even with request-changes items, for example when repository rules forbid the event.",
    )
    args = parser.parse_args()
    try:
        data = json.loads(args.findings.read_text(encoding="utf-8"))
        outputs, plan = render(data, args.target, args.head.strip(), args.comment_only)
        args.out_dir.mkdir(parents=True, exist_ok=False)
        for name, text in outputs.items():
            (args.out_dir / name).write_text(text, encoding="utf-8")
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
