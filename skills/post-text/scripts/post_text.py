#!/usr/bin/env python3
"""Prepare, check, and post Markdown text with an AI-provenance info panel.

`prepare` puts a GitHub NOTE alert (info panel) that names the harness and the
AI agents at the top of a Markdown body. `check` compares a file with the
SHA-256 digest of the approved draft. `post` checks the digest, posts the file
as a comment on a GitHub issue or pull request, and reads the comment back.

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
TARGET_URL = re.compile(
    r"https://(?P<host>[^/\s]+)/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/"
    r"(?:issues|pull)/(?P<number>[1-9][0-9]*)/?(?:[#?].*)?"
)


def single_line(label, value):
    value = value.strip()
    if not value or any(char in value for char in "\r\n"):
        raise ValueError(f"Provide a nonempty, single-line {label} value.")
    return value


def info_panel(harnesses, agents):
    if not harnesses:
        raise ValueError("Provide at least one harness.")
    if not agents:
        raise ValueError("Provide at least one AI agent.")
    harnesses = [single_line("harness", value) for value in harnesses]
    agents = [single_line("AI agent", value) for value in agents]
    lines = [PANEL_HEADER, "> This text was drafted with AI and posted after human approval.", ">"]
    lines.append(f"> - {'Harness' if len(harnesses) == 1 else 'Harnesses'}: {', '.join(harnesses)}")
    lines.append(f"> - {'AI agent' if len(agents) == 1 else 'AI agents'}: {', '.join(agents)}")
    return "\n".join(lines) + "\n"


def prepare(text, harnesses, agents):
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise ValueError("The Markdown text must not be empty.")
    if text.startswith(PANEL_HEADER):
        raise ValueError("The text already starts with an info panel. Pass only the text body.")
    return (info_panel(harnesses, agents) + "\n" + text + "\n").encode("utf-8")


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


def gh_api(host, *args, payload=None):
    result = subprocess.run(
        ["gh", "api", "--hostname", host, *args],
        input=None if payload is None else json.dumps(payload),
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"gh api failed with exit code {result.returncode}.")
    return json.loads(result.stdout)


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
        else:
            body = args.body.read_bytes()
            check(body, args.sha256)
            print(post(body, args.target))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
