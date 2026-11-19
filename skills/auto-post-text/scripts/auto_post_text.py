#!/usr/bin/env python3
"""Post Markdown text that AI wrote and posted without human review, with a disclosure panel.

This helper uses the `post-text` helper with another info panel statement: the
panel says that AI wrote and posted the text fully automatically and that no
human reviewed it before it was posted. It also names the workflow, the
harness, and the AI agents.

`prepare` writes the full text for a destination that you post to with another
tool, and prints its SHA-256 digest. `post` writes the full text and posts it
as a comment on a GitHub issue or pull request, then reads it back. `post-review`
writes a pull request review with inline comments, checks each comment against
the diff at the reviewed commit, submits the review with its event, and reads
it back. Each command writes its output file before it posts, so the file is
the record of what was posted.
"""

import argparse
import json
from pathlib import Path
import sys

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "post-text" / "scripts"))
import post_text  # noqa: E402

AUTOMATED = (
    "This text was written and posted fully automatically by AI. "
    "No human reviewed it before it was posted."
)


def prepare(text, harnesses, agents, workflow=None):
    return post_text.with_panel(text, harnesses, agents, AUTOMATED, workflow).encode("utf-8")


def prepare_review(text, comments, url, head, harnesses, agents, event="COMMENT", workflow=None):
    if not isinstance(head, str) or not head.strip():
        raise ValueError("Provide the commit that the review covers.")
    return post_text.prepare_review(
        text, comments, url, harnesses, agents, event,
        statement=AUTOMATED, workflow=workflow, expected_head=head.strip(),
    )


def write_new(path, data):
    with path.open("xb") as output:
        output.write(data)


def add_provenance(parser):
    parser.add_argument("--harness", required=True, action="append", help="Harness actually used. Repeat for several.")
    parser.add_argument("--agent", required=True, action="append", help="AI agent actually used. Repeat for several.")
    parser.add_argument("--workflow", help="Name of the automatic workflow, for example 'Auto Review PR'.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    draft = commands.add_parser("prepare", help="Write the full text with the panel and print its digest.")
    draft.add_argument("--text", required=True, type=Path, help="UTF-8 Markdown file with only the text body.")
    add_provenance(draft)
    draft.add_argument("--output", required=True, type=Path, help="New file for the full text. Must not exist.")

    publish = commands.add_parser("post", help="Write the full text, post it as an issue or PR comment, read it back.")
    publish.add_argument("--text", required=True, type=Path, help="UTF-8 Markdown file with only the text body.")
    publish.add_argument("--target", required=True, help="GitHub issue or pull request URL.")
    add_provenance(publish)
    publish.add_argument("--output", required=True, type=Path, help="New file for the full text. Must not exist.")

    review = commands.add_parser(
        "post-review", help="Write a PR review with checked inline comments, submit it, and read it back.",
    )
    review.add_argument("--text", required=True, type=Path, help="UTF-8 Markdown file with only the review body.")
    review.add_argument("--comments", required=True, type=Path, help="JSON array of inline comments ([] for none).")
    review.add_argument("--target", required=True, help="GitHub pull request URL.")
    review.add_argument("--head", required=True, help="Commit SHA that the review covers. Must be the PR head.")
    review.add_argument("--event", choices=tuple(post_text.REVIEW_STATES), default="COMMENT")
    add_provenance(review)
    review.add_argument("--output", required=True, type=Path, help="New file for the review JSON. Must not exist.")

    args = parser.parse_args()
    try:
        text = args.text.read_text(encoding="utf-8")
        if args.command == "prepare":
            body = prepare(text, args.harness, args.agent, args.workflow)
            write_new(args.output, body)
            print(post_text.digest(body))
        elif args.command == "post":
            post_text.parse_target(args.target)
            body = prepare(text, args.harness, args.agent, args.workflow)
            write_new(args.output, body)
            print(post_text.post(body, args.target))
        else:
            comments = json.loads(args.comments.read_text(encoding="utf-8"))
            data = prepare_review(
                text, comments, args.target, args.head, args.harness, args.agent, args.event, args.workflow,
            )
            write_new(args.output, data)
            print(post_text.post_review(data))
    except (OSError, UnicodeError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
