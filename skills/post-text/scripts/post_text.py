#!/usr/bin/env python3
"""Prepare, check, and post Markdown text with an AI-provenance info panel.

`prepare` puts a GitHub NOTE alert (info panel) that names the harness and the
AI agents at the top of a Markdown body. `check` compares a file with the
SHA-256 digest of the approved draft. `post` checks the digest, posts the file
as a comment on a GitHub issue or pull request, and reads the comment back.

For a pull request review, `prepare-review` puts the info panel on the review
body, checks that each inline comment is on a line of the pull request diff at
its current head, and writes the review as one JSON file with its event
(COMMENT, REQUEST_CHANGES, or APPROVE), so the digest covers the event too.
`show-review` prints that file for approval. `post-review` checks the digest
and the head, submits the review with its event, and reads the review, its
state, and its comments back.

The helper cannot establish human approval. Get approval in the conversation.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PANEL_HEADER = "> [!NOTE]"
HUMAN_APPROVED = "This text was drafted with AI and posted after human approval."
REVIEW_KIND = "github-pull-request-review"
# Each review event the helper submits, with the state GitHub reports for the posted review.
REVIEW_STATES = {"COMMENT": "COMMENTED", "REQUEST_CHANGES": "CHANGES_REQUESTED", "APPROVE": "APPROVED"}
EVENT_EFFECTS = {
    "COMMENT": "comment only: no approval and no change request",
    "REQUEST_CHANGES": "requests changes on the pull request",
    "APPROVE": "approves the pull request",
}
SIDES = ("LEFT", "RIGHT")
COMMENT_KEYS = {"path", "line", "side", "start_line", "start_side", "body"}
HUNK_HEADER = re.compile(r"@@ -(?P<old>[0-9]+)(?:,[0-9]+)? \+(?P<new>[0-9]+)(?:,[0-9]+)? @@")
TARGET_URL = re.compile(
    r"https://(?P<host>[^/\s]+)/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/"
    r"(?:issues|pull)/(?P<number>[1-9][0-9]*)/?(?:[#?].*)?"
)


def single_line(label, value):
    value = value.strip()
    if not value or any(char in value for char in "\r\n"):
        raise ValueError(f"Provide a nonempty, single-line {label} value.")
    return value


def info_panel(harnesses, agents, statement=HUMAN_APPROVED, workflow=None):
    """Return the info panel. Other skills pass their own statement, and optionally the workflow that ran."""
    if not harnesses:
        raise ValueError("Provide at least one harness.")
    if not agents:
        raise ValueError("Provide at least one AI agent.")
    harnesses = [single_line("harness", value) for value in harnesses]
    agents = [single_line("AI agent", value) for value in agents]
    lines = [PANEL_HEADER, f"> {single_line('statement', statement)}", ">"]
    if workflow is not None:
        lines.append(f"> - Workflow: {single_line('workflow', workflow)}")
    lines.append(f"> - {'Harness' if len(harnesses) == 1 else 'Harnesses'}: {', '.join(harnesses)}")
    lines.append(f"> - {'AI agent' if len(agents) == 1 else 'AI agents'}: {', '.join(agents)}")
    return "\n".join(lines) + "\n"


def with_panel(text, harnesses, agents, statement=HUMAN_APPROVED, workflow=None):
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise ValueError("The Markdown text must not be empty.")
    if text.startswith(PANEL_HEADER):
        raise ValueError("The text already starts with an info panel. Pass only the text body.")
    return info_panel(harnesses, agents, statement, workflow) + "\n" + text + "\n"


def prepare(text, harnesses, agents):
    return with_panel(text, harnesses, agents).encode("utf-8")


def digest(body):
    return hashlib.sha256(body).hexdigest()


def check(body, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Provide the SHA-256 digest retained from the approved draft.")
    if digest(body) != expected:
        raise ValueError("The text differs from the approved draft. Get approval for the revised text.")


def parse_target(url):
    match = TARGET_URL.fullmatch(url.strip())
    if not match:
        raise ValueError("Provide a GitHub issue or pull request URL, for example https://github.com/o/r/issues/1.")
    return match.groupdict()


def parse_pull_target(url):
    target = parse_target(url)
    if "/pull/" not in url:
        raise ValueError("Provide a GitHub pull request URL for a review, for example https://github.com/o/r/pull/1.")
    return target


def canonical_pull_url(target):
    return f"https://{target['host']}/{target['owner']}/{target['repo']}/pull/{target['number']}"


def gh_api(host, *args, payload=None, paginate=False):
    if paginate:
        args = ("--paginate", "--slurp", *args)
    result = subprocess.run(
        ["gh", "api", "--hostname", host, *args],
        input=None if payload is None else json.dumps(payload),
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"gh api failed with exit code {result.returncode}.")
    data = json.loads(result.stdout)
    if paginate:
        return [item for page in data for item in page]
    return data


def post(body, target):
    target = parse_target(target)
    endpoint = f"repos/{target['owner']}/{target['repo']}/issues/{target['number']}/comments"
    text = body.decode("utf-8")
    created = gh_api(target["host"], "--method", "POST", endpoint, "--input", "-", payload={"body": text})
    comment_path = f"repos/{target['owner']}/{target['repo']}/issues/comments/{created['id']}"
    posted = gh_api(target["host"], comment_path)
    if posted.get("body", "").replace("\r\n", "\n") != text:
        raise RuntimeError(f"Posted comment body differs from the approved text: {created['html_url']}")
    return created["html_url"]


def positive_int(label, value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} must be a positive integer.")
    return value


def normalize_comment(index, comment):
    label = f"comments[{index}]"
    if not isinstance(comment, dict):
        raise ValueError(f"{label} must be an object.")
    unknown = set(comment) - COMMENT_KEYS
    if unknown:
        raise ValueError(f"{label} has unknown keys: {', '.join(sorted(unknown))}.")
    path = comment.get("path")
    if not isinstance(path, str) or not path.strip() or path != path.strip() or path.startswith("/"):
        raise ValueError(f"{label}.path must be a repository-relative file path.")
    body = comment.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError(f"{label}.body must be nonempty Markdown text.")
    side = comment.get("side", "RIGHT")
    if side not in SIDES:
        raise ValueError(f"{label}.side must be LEFT or RIGHT.")
    normalized = {"path": path, "line": positive_int(f"{label}.line", comment.get("line")), "side": side}
    if "start_line" in comment:
        start_line = positive_int(f"{label}.start_line", comment["start_line"])
        start_side = comment.get("start_side", side)
        if start_side not in SIDES:
            raise ValueError(f"{label}.start_side must be LEFT or RIGHT.")
        if start_side == side and start_line >= normalized["line"]:
            raise ValueError(f"{label}.start_line must be less than line.")
        normalized.update(start_line=start_line, start_side=start_side)
    elif "start_side" in comment:
        raise ValueError(f"{label}.start_side needs start_line.")
    normalized["body"] = body.replace("\r\n", "\n").strip() + "\n"
    return normalized


def commentable_lines(patch):
    """Map each (side, line) that a review comment can use to its hunk number."""
    lines = {}
    hunk = -1
    old = new = 0
    raw_lines = patch.split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()
    for raw in raw_lines:
        header = HUNK_HEADER.match(raw)
        if header:
            hunk += 1
            old, new = int(header["old"]), int(header["new"])
        elif hunk < 0 or raw.startswith("\\"):
            continue
        elif raw.startswith("+"):
            lines[("RIGHT", new)] = hunk
            new += 1
        elif raw.startswith("-"):
            lines[("LEFT", old)] = hunk
            old += 1
        else:
            lines[("RIGHT", new)] = hunk
            lines[("LEFT", old)] = hunk
            old += 1
            new += 1
    return lines


def diff_problems(comments, files):
    patches = {item["filename"]: item.get("patch") for item in files}
    problems = []
    for index, comment in enumerate(comments):
        where = f"comments[{index}] {comment['path']}:{comment.get('start_line', comment['line'])}"
        if "start_line" in comment:
            where += f"-{comment['line']}"
        where += f" ({comment['side']})"
        if comment["path"] not in patches:
            problems.append(f"{where}: the file is not changed in the pull request.")
            continue
        if patches[comment["path"]] is None:
            problems.append(f"{where}: GitHub shows no diff for this file (binary or too large).")
            continue
        lines = commentable_lines(patches[comment["path"]])
        end = lines.get((comment["side"], comment["line"]))
        if end is None:
            problems.append(f"{where}: the line is not in the pull request diff.")
        elif "start_line" in comment and lines.get((comment["start_side"], comment["start_line"])) != end:
            problems.append(f"{where}: start_line and line must be in the same diff hunk.")
    return problems


def pull_request(target):
    return gh_api(target["host"], f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}")


def pull_head(target):
    return pull_request(target)["head"]["sha"]


def review_event(event):
    if event not in REVIEW_STATES:
        raise ValueError(f"The review event must be one of: {', '.join(REVIEW_STATES)}.")
    return event


def prepare_review(
    text, comments, url, harnesses, agents, event="COMMENT",
    statement=HUMAN_APPROVED, workflow=None, expected_head=None,
):
    """Write a review file. With expected_head, stop when the pull request head is another commit."""
    target = parse_pull_target(url)
    event = review_event(event)
    if not isinstance(comments, list):
        raise ValueError("The comments file must contain a JSON array.")
    comments = [normalize_comment(index, comment) for index, comment in enumerate(comments)]
    body = with_panel(text, harnesses, agents, statement, workflow)
    pull = pull_request(target)
    head = pull["head"]["sha"]
    if expected_head is not None and head != expected_head:
        raise RuntimeError(
            f"The pull request head is {head}, not the reviewed commit {expected_head}. "
            "The review does not apply to the current head."
        )
    if event != "COMMENT":
        login = gh_api(target["host"], "user")["login"]
        if pull["user"]["login"] == login:
            raise ValueError(
                f"GitHub does not let {login} approve or request changes on their own pull request. "
                "Use the COMMENT event, or post from another account."
            )
    files = gh_api(
        target["host"], f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}/files?per_page=100",
        paginate=True,
    )
    if pull_head(target) != head:
        raise RuntimeError("The pull request head changed while the diff was read. Run prepare-review again.")
    problems = diff_problems(comments, files)
    if problems:
        raise ValueError(
            "These comments cannot be inline at the current head. Move each point into the review body "
            "with its file and line, or fix the location, and run prepare-review again:\n"
            + "\n".join(f"- {problem}" for problem in problems)
        )
    review = {
        "kind": REVIEW_KIND, "target": canonical_pull_url(target), "commit_id": head,
        "event": event, "body": body, "comments": comments,
    }
    return (json.dumps(review, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def load_review(data):
    review = json.loads(data.decode("utf-8"))
    if not isinstance(review, dict) or review.get("kind") != REVIEW_KIND or review.get("event") not in REVIEW_STATES:
        raise ValueError("The file is not a review that prepare-review wrote.")
    return review


def fence(text):
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    marks = "`" * max(3, longest + 1)
    return f"{marks}markdown\n{text.rstrip(chr(10))}\n{marks}"


def show_review(data):
    review = load_review(data)
    parts = [
        f"Destination: {review['target']}",
        f"Review event: {review['event']} ({EVENT_EFFECTS[review['event']]}), at commit `{review['commit_id']}`",
        f"Inline comments: {len(review['comments'])}",
        "",
        "### Review body",
        "",
        fence(review["body"]),
    ]
    for number, comment in enumerate(review["comments"], 1):
        lines = str(comment["line"])
        if "start_line" in comment:
            lines = f"{comment['start_line']}-{lines}"
        parts += ["", f"### Inline comment {number}: `{comment['path']}` line {lines} ({comment['side']})", ""]
        parts.append(fence(comment["body"]))
    return "\n".join(parts) + "\n"


def post_review(data):
    review = load_review(data)
    target = parse_pull_target(review["target"])
    prefix = f"repos/{target['owner']}/{target['repo']}/pulls/{target['number']}"
    head = pull_head(target)
    if head != review["commit_id"]:
        raise RuntimeError(
            f"The pull request head moved from {review['commit_id']} to {head}. "
            "Check the comments against the new head, run prepare-review again, and get approval again."
        )
    payload = {key: review[key] for key in ("commit_id", "body", "event", "comments")}
    created = gh_api(target["host"], "--method", "POST", f"{prefix}/reviews", "--input", "-", payload=payload)
    url = created["html_url"]
    posted = gh_api(target["host"], f"{prefix}/reviews/{created['id']}")
    if posted.get("body", "").replace("\r\n", "\n") != review["body"]:
        raise RuntimeError(f"Posted review body differs from the approved text: {url}")
    if posted.get("state") != REVIEW_STATES[review["event"]]:
        raise RuntimeError(
            f"Posted review state is {posted.get('state')}, not {REVIEW_STATES[review['event']]}: {url}"
        )
    posted_comments = gh_api(target["host"], f"{prefix}/reviews/{created['id']}/comments?per_page=100", paginate=True)
    actual = sorted((item["path"], item["body"].replace("\r\n", "\n")) for item in posted_comments)
    expected = sorted((item["path"], item["body"]) for item in review["comments"])
    if actual != expected:
        raise RuntimeError(f"Posted inline comments differ from the approved comments: {url}")
    return url


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    draft = commands.add_parser("prepare", help="Put the info panel on top of a Markdown text and print its digest.")
    draft.add_argument("--text", required=True, type=Path, help="UTF-8 Markdown file with only the text body.")
    draft.add_argument("--harness", required=True, action="append", help="Harness actually used. Repeat for several.")
    draft.add_argument("--agent", required=True, action="append", help="AI agent actually used. Repeat for several.")
    draft.add_argument("--output", required=True, type=Path, help="New file for the full text. Must not exist.")
    verify = commands.add_parser("check", help="Compare a file with the digest of the approved draft.")
    verify.add_argument("--body", required=True, type=Path)
    verify.add_argument("--sha256", required=True)
    publish = commands.add_parser("post", help="Check the digest, post a GitHub issue or PR comment, and read it back.")
    publish.add_argument("--body", required=True, type=Path)
    publish.add_argument("--sha256", required=True)
    publish.add_argument("--target", required=True, help="GitHub issue or pull request URL.")
    review = commands.add_parser(
        "prepare-review", help="Write a PR review with inline comments checked against the diff, and print its digest.",
    )
    review.add_argument("--text", required=True, type=Path, help="UTF-8 Markdown file with only the review body.")
    review.add_argument("--comments", required=True, type=Path, help="JSON array of inline comments ([] for none).")
    review.add_argument("--target", required=True, help="GitHub pull request URL.")
    review.add_argument("--harness", required=True, action="append", help="Harness actually used. Repeat for several.")
    review.add_argument("--agent", required=True, action="append", help="AI agent actually used. Repeat for several.")
    review.add_argument(
        "--event", choices=tuple(REVIEW_STATES), default="COMMENT",
        help="Review event the human asked for (default COMMENT).",
    )
    review.add_argument(
        "--head", help="Full SHA of the reviewed commit. Stop when the pull request head is another commit.",
    )
    review.add_argument("--output", required=True, type=Path, help="New file for the review JSON. Must not exist.")
    show = commands.add_parser("show-review", help="Print a review file as Markdown for approval.")
    show.add_argument("--review", required=True, type=Path)
    submit = commands.add_parser(
        "post-review", help="Check the digest and head, submit the review with its event, and read it back.",
    )
    submit.add_argument("--review", required=True, type=Path)
    submit.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            body = prepare(args.text.read_text(encoding="utf-8"), args.harness, args.agent)
            with args.output.open("xb") as output:
                output.write(body)
            print(digest(body))
        elif args.command == "check":
            check(args.body.read_bytes(), args.sha256)
            print(args.sha256)
        elif args.command == "prepare-review":
            comments = json.loads(args.comments.read_text(encoding="utf-8"))
            body = prepare_review(
                args.text.read_text(encoding="utf-8"), comments, args.target, args.harness, args.agent, args.event,
                expected_head=args.head.strip() if args.head else None,
            )
            with args.output.open("xb") as output:
                output.write(body)
            print(digest(body))
        elif args.command == "show-review":
            print(show_review(args.review.read_bytes()), end="")
        elif args.command == "post-review":
            body = args.review.read_bytes()
            check(body, args.sha256)
            print(post_review(body))
        else:
            body = args.body.read_bytes()
            check(body, args.sha256)
            print(post(body, args.target))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
