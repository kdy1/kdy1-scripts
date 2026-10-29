#!/usr/bin/env python3
"""Prepare a disclosed research comment or check an approved file's identity.

This helper performs no network writes and cannot establish human approval.
"""

import argparse
import hashlib
from pathlib import Path
import re
import sys


def prepare(findings, reviewer, harness, model):
    reviewer = reviewer.removeprefix("@")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", reviewer) or "--" in reviewer:
        raise ValueError("Provide a GitHub login, not a display name or URL.")
    if not findings.strip():
        raise ValueError("Research findings must not be empty.")
    for label, value in (("harness", harness), ("model", model)):
        if not value.strip() or any(char in value for char in "\r\n"):
            raise ValueError(f"Provide a nonempty, single-line {label} value.")
    return (
        findings.rstrip() + "\n\n"
        "AI was used to conduct this research. The findings and this comment "
        f"were reviewed and approved by @{reviewer}.\n"
        f"Harness: {harness.strip()}\n"
        f"AI model: {model.strip()}\n"
    ).encode("utf-8")


def digest(body):
    return hashlib.sha256(body).hexdigest()


def check(body, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Provide the SHA-256 digest retained from the approved draft.")
    if digest(body) != expected:
        raise ValueError("Comment differs from the approved draft. Obtain approval for the revised text.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    draft = commands.add_parser("prepare", help="Append disclosures and write a new UTF-8 comment file.")
    draft.add_argument("--findings", required=True, type=Path)
    draft.add_argument("--reviewer", required=True)
    draft.add_argument("--harness", required=True)
    draft.add_argument("--model", required=True)
    draft.add_argument("--output", required=True, type=Path)
    verify = commands.add_parser("check", help="Check exact bytes against a retained SHA-256 digest.")
    verify.add_argument("--body", required=True, type=Path)
    verify.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            body = prepare(args.findings.read_text(encoding="utf-8"), args.reviewer, args.harness, args.model)
            with args.output.open("xb") as output:
                output.write(body)
        else:
            body = args.body.read_bytes()
            check(body, args.sha256)
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(digest(body))
    return 0


if __name__ == "__main__":
    sys.exit(main())
