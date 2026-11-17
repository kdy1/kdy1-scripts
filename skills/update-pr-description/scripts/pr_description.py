#!/usr/bin/env python3
"""Deterministic helpers for Update PR Description.

The agent decides what the title and body should say. This helper only:

- snapshot: reads the PR, its commits, files, linked issues, and the repository's PR template
  into a private run directory, so that the agent drafts against a fixed copy;
- check:    compares a draft title and body with the snapshot and reports content that the
            draft drops or breaks (issue references, images, HTML comments, template headings,
            checked boxes, mentions, local paths, title format, size limits);
- apply:    refuses when the PR changed since the snapshot, then writes only the changed
            fields and verifies the result;
- cleanup:  deletes the run directory.
"""

import argparse
import base64
import difflib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

PR_URL = re.compile(r"^https://([^/]+)/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$")
PR_FIELDS = ("number,url,title,body,author,state,isDraft,baseRefName,headRefName,headRefOid,"
             "closingIssuesReferences,commits,files,additions,deletions,changedFiles,labels")
RUN_PREFIX = "pr-description-"
TITLE_LIMIT = 256
BODY_LIMIT = 65536
TEMPLATE_PATHS = (
    ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE.md",
)

CONVENTIONAL_TITLE = re.compile(r"^[a-z]+(\([^()\s][^()]*\))?!?: \S")
# A standalone issue reference line, for example "Closes #12", "Refs owner/repo#3", "Ref ENG-4".
REF_LINE = re.compile(
    r"^\s*(?:[-*]\s+)?(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of|related to)\b:?\s+"
    r"(\S+)\s*$", re.I)
CLOSING = {"close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"}
IMAGE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", re.I)
ATTACHMENT = re.compile(r"https://(?:github\.com/user-attachments/[^\s)\"'>]+|"
                        r"user-images\.githubusercontent\.com/[^\s)\"'>]+|"
                        r"private-user-images\.githubusercontent\.com/[^\s)\"'>]+)")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", re.M)
CHECKED_BOX = re.compile(r"^\s*[-*]\s+\[[xX]\]\s+(.+?)\s*$", re.M)
MENTION = re.compile(r"(?<![\w`/.@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:/[\w.-]+)?\b")
LOCAL_PATH = re.compile(r"(?<![\w/.~-])(/home/|/Users/|/tmp/|/private/var/|/var/folders/|"
                        r"[A-Za-z]:\\Users\\|~/)[^\s)`'\"]*")
CODE_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,}).*?^\1\2\s*$", re.M | re.S)


# ---------------------------------------------------------------------------
# Process helpers

def run(args, cwd=None, stdin=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, input=stdin)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:4])} failed: {result.stderr.strip()}")
    return result.stdout


def gh_json(args, host):
    out = run(["gh", *args, *(["--hostname", host] if args[0] == "api" else [])])
    return json.loads(out) if out.strip() else None


def parse_pr(ref, repo=None):
    """Return (host, owner, name, number) for a PR URL or a number plus [HOST/]OWNER/REPO."""
    match = PR_URL.match(ref.strip())
    if match:
        host, owner, name, number = match.groups()
        return host, owner, name, int(number)
    if ref.strip().isdigit() and repo:
        parts = repo.split("/")
        if len(parts) == 2 and all(parts):
            return "github.com", parts[0], parts[1], int(ref)
        if len(parts) == 3 and all(parts):
            return parts[0], parts[1], parts[2], int(ref)
    raise ValueError(f"Expected a pull request URL, or a number with --repo: {ref!r}")


def current_pr_url():
    out = run(["gh", "pr", "view", "--json", "url"])
    return json.loads(out)["url"]


# ---------------------------------------------------------------------------
# Pure text analysis (unit-tested)

def strip_code(text):
    """Remove fenced code blocks and inline code so that literals inside them are ignored."""
    text = CODE_FENCE.sub("", text or "")
    return re.sub(r"`[^`\n]*`", "", text)


def issue_refs(text, repo=None):
    """Return {normalized target: kind} for standalone reference lines outside code.

    `repo` is OWNER/NAME of the PR; with it, "#12" and "owner/name#12" are the same issue.
    """
    refs = {}
    for line in strip_code(text).splitlines():
        match = REF_LINE.match(line)
        if not match:
            continue
        keyword, target = match.group(1).lower(), match.group(2).rstrip(".,;")
        if not re.search(r"#\d+$|^[A-Z][A-Z0-9]+-\d+$|/issues/\d+$", target):
            continue
        refs[normalize_ref(target, repo)] = "closes" if keyword in CLOSING else "refs"
    return refs


def normalize_ref(target, repo=None):
    match = re.match(r"https?://[^/]+/([^/]+/[^/]+)/issues/(\d+)$", target)
    if match:
        target = f"{match.group(1)}#{match.group(2)}"
    if target.startswith("#") and repo:
        target = f"{repo}{target}"
    return target.lower() if "#" in target else target


def images(text):
    found = set()
    for match in IMAGE.finditer(text or ""):
        found.add(match.group(1) or match.group(2))
    found.update(ATTACHMENT.findall(text or ""))
    return found


def html_comments(text):
    return [c.strip() for c in HTML_COMMENT.findall(text or "")]


def headings(text):
    return [h.group(2).strip() for h in HEADING.finditer(strip_code(HTML_COMMENT.sub("", text or "")))]


def checked_boxes(text):
    return [m.group(1) for m in CHECKED_BOX.finditer(strip_code(text))]


def mentions(text):
    return {m.group(1).lower() for m in MENTION.finditer(strip_code(HTML_COMMENT.sub("", text or "")))}


def local_paths(text):
    return sorted({m.group(0) for m in LOCAL_PATH.finditer(text or "")})


def text_diff(old, new, label):
    lines = difflib.unified_diff((old or "").splitlines(), (new or "").splitlines(),
                                 f"{label} (current)", f"{label} (draft)", lineterm="")
    return "\n".join(lines)


def check_draft(snapshot, title, body, conventional=True):
    """Return (errors, warnings) for a draft against the snapshot. Errors block `apply`."""
    old_title, old_body = snapshot["pr"]["title"], snapshot["pr"]["body"] or ""
    template = snapshot.get("template") or ""
    errors, warnings = [], []

    if not title.strip():
        errors.append("title: empty")
    if "\n" in title.strip():
        errors.append("title: contains a line break")
    if len(title) > TITLE_LIMIT:
        errors.append(f"title: {len(title)} characters; GitHub allows {TITLE_LIMIT}")
    if conventional and not CONVENTIONAL_TITLE.match(title.strip()):
        warnings.append("title: not in Conventional Commits format `type(scope)!: description`")
    if len(body) > BODY_LIMIT:
        errors.append(f"body: {len(body)} characters; GitHub allows {BODY_LIMIT}")
    if "\r\n" in body:
        warnings.append("body: contains CRLF line endings")

    repo = f"{snapshot['owner']}/{snapshot['name']}" if "owner" in snapshot else None
    old_refs, new_refs = issue_refs(old_body, repo), issue_refs(body, repo)
    for ref, kind in sorted(old_refs.items()):
        if ref not in new_refs:
            errors.append(f"issue reference removed: {kind} {ref}")
        elif new_refs[ref] != kind:
            errors.append(f"issue reference changed: {kind} -> {new_refs[ref]} {ref}")
    for ref, kind in sorted(new_refs.items()):
        if ref not in old_refs:
            warnings.append(f"issue reference added: {kind} {ref} (verify the issue and its completion)")

    for url in sorted(images(old_body) - images(body)):
        errors.append(f"image or attachment removed: {url}")
    new_comments = html_comments(body)
    for comment in html_comments(old_body):
        if comment not in new_comments and comment not in template:
            errors.append(f"HTML comment removed: {comment[:120]}")

    template_headings = headings(template)
    new_headings = headings(body)
    for heading in template_headings:
        if heading in headings(old_body) and heading not in new_headings:
            errors.append(f"template heading removed: {heading}")
    new_boxes = checked_boxes(body)
    for box in checked_boxes(old_body):
        if box not in new_boxes:
            warnings.append(f"checked box removed or unchecked: {box}")

    for login in sorted(mentions(old_body) - mentions(body)):
        warnings.append(f"mention removed: @{login}")
    for login in sorted(mentions(body) - mentions(old_body)):
        warnings.append(f"mention added: @{login} (GitHub notifies this account)")
    for path in local_paths(body):
        if path not in local_paths(old_body):
            errors.append(f"local file path in body: {path}")

    if title == old_title and body == old_body:
        warnings.append("draft is identical to the current title and body")
    return errors, warnings


# ---------------------------------------------------------------------------
# Snapshot

def read_template(host, owner, name, base):
    """Return the first PR template found on the base branch, or None."""
    for path in TEMPLATE_PATHS:
        try:
            data = gh_json(["api", f"repos/{owner}/{name}/contents/{path}?ref={quote(base, safe='')}"], host)
        except RuntimeError:
            continue
        if isinstance(data, dict) and data.get("content"):
            return path, base64.b64decode(data["content"]).decode("utf-8", "replace")
    try:
        listing = gh_json(["api", f"repos/{owner}/{name}/contents/.github/PULL_REQUEST_TEMPLATE"
                           f"?ref={quote(base, safe='')}"], host)
    except RuntimeError:
        return None, None
    if isinstance(listing, list) and listing:
        names = ", ".join(item["path"] for item in listing)
        return names, None
    return None, None


def write_snapshot(ref, repo):
    if not ref:
        ref = current_pr_url()
    host, owner, name, number = parse_pr(ref, repo)
    full = f"{host}/{owner}/{name}" if host != "github.com" else f"{owner}/{name}"
    pr = json.loads(run(["gh", "pr", "view", str(number), "--repo", full, "--json", PR_FIELDS]))
    user = gh_json(["api", "user"], host)["login"]
    template_path, template = read_template(host, owner, name, pr["baseRefName"])
    try:
        diff = run(["gh", "pr", "diff", str(number), "--repo", full])
    except RuntimeError as exc:  # GitHub refuses very large diffs; the agent can use git instead.
        diff = f"# gh pr diff failed: {exc}\n"

    run_dir = Path(tempfile.mkdtemp(prefix=RUN_PREFIX))
    (run_dir / "title-before.txt").write_text(pr["title"], encoding="utf-8")
    (run_dir / "body-before.md").write_text(pr["body"] or "", encoding="utf-8")
    (run_dir / "pr.diff").write_text(diff, encoding="utf-8")
    snapshot = {
        "host": host, "owner": owner, "name": name, "number": number, "repo": full,
        "viewer": user, "pr": pr, "templatePath": template_path, "template": template,
        "runDir": str(run_dir),
    }
    path = run_dir / "snapshot.json"
    path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
    return path, snapshot


def summarize(snapshot_path, snapshot):
    pr, run_dir = snapshot["pr"], Path(snapshot["runDir"])
    author = (pr.get("author") or {}).get("login") or "unknown"
    lines = [
        f"PR: {pr['url']}",
        f"Title: {pr['title']}",
        f"Author: {author}  Viewer: {snapshot['viewer']}  State: {pr['state']}"
        f"{' (draft)' if pr['isDraft'] else ''}",
        f"Base: {pr['baseRefName']}  Head: {pr['headRefName']} @ {pr['headRefOid'][:12]}",
        f"Size: {pr['changedFiles']} files, +{pr['additions']} -{pr['deletions']}",
    ]
    if author.lower() != snapshot["viewer"].lower():
        lines.append("note: the PR author is not the authenticated user")
    if pr["state"] != "OPEN":
        lines.append(f"note: the PR is {pr['state'].lower()}")
    closing = pr.get("closingIssuesReferences") or []
    lines.append("Linked closing issues: " + (", ".join(i.get("url") or f"#{i['number']}"
                                                        for i in closing) or "none"))
    refs = issue_refs(pr["body"] or "", f"{snapshot['owner']}/{snapshot['name']}")
    lines.append("Reference lines in body: " + (", ".join(f"{k} {r}" for r, k in sorted(refs.items()))
                                                 or "none"))
    lines.append(f"Images and attachments in body: {len(images(pr['body']))}")
    lines.append(f"HTML comments in body: {len(html_comments(pr['body']))}")
    lines.append(f"Template: {snapshot['templatePath'] or 'none found'}"
                 + ("" if snapshot["template"] or not snapshot["templatePath"] else " (directory; not read)"))
    lines.append(f"Commits ({len(pr['commits'])}):")
    for commit in pr["commits"][-50:]:
        lines.append(f"  {commit['oid'][:10]} {commit['messageHeadline']}")
    if len(pr["commits"]) > 50:
        lines.append(f"  ... {len(pr['commits']) - 50} earlier commits omitted")
    lines.append("Files:")
    for f in pr["files"][:100]:
        lines.append(f"  +{f['additions']} -{f['deletions']} {f['path']}")
    if len(pr["files"]) > 100:
        lines.append(f"  ... {len(pr['files']) - 100} more files")
    lines += [
        f"Snapshot: {snapshot_path}",
        f"Current title: {run_dir / 'title-before.txt'}",
        f"Current body:  {run_dir / 'body-before.md'}",
        f"Diff:          {run_dir / 'pr.diff'}",
        f"Write the draft to {run_dir / 'title.txt'} and {run_dir / 'body.md'}.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Draft loading, apply, verify

def load_snapshot(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_draft(snapshot, title_file, body_file):
    run_dir = Path(snapshot["runDir"])
    title_path = Path(title_file) if title_file else run_dir / "title.txt"
    body_path = Path(body_file) if body_file else run_dir / "body.md"
    title = (title_path.read_text(encoding="utf-8").strip() if title_path.exists()
             else snapshot["pr"]["title"])
    body = body_path.read_text(encoding="utf-8") if body_path.exists() else (snapshot["pr"]["body"] or "")
    return title, body.rstrip("\n") + "\n" if body.strip() else ""


def live_pr(snapshot):
    return json.loads(run(["gh", "pr", "view", str(snapshot["number"]), "--repo", snapshot["repo"],
                           "--json", "title,body,state,headRefOid"]))


def same_body(a, b):
    return (a or "").replace("\r\n", "\n").rstrip() == (b or "").replace("\r\n", "\n").rstrip()


def report_check(snapshot, title, body, conventional):
    errors, warnings = check_draft(snapshot, title, body, conventional)
    pr = snapshot["pr"]
    if title != pr["title"]:
        print(f"Title:\n  - {pr['title']}\n  + {title}")
    else:
        print("Title: unchanged")
    diff = text_diff(pr["body"], body, "body")
    print(diff if diff else "Body: unchanged")
    for e in errors:
        print(f"error: {e}")
    for w in warnings:
        print(f"warning: {w}")
    print(f"result: {'blocked' if errors else 'ok'} ({len(errors)} errors, {len(warnings)} warnings)")
    return errors


def apply(snapshot, title, body, conventional, allow):
    errors, _ = check_draft(snapshot, title, body, conventional)
    allowed = [e for e in errors if any(a in e for a in allow)]
    blocking = [e for e in errors if e not in allowed]
    if blocking:
        raise SystemExit("apply refused; run `check` and fix:\n" + "\n".join(f"  {e}" for e in blocking))

    pr = snapshot["pr"]
    live = live_pr(snapshot)
    if live["title"] != pr["title"] or not same_body(live["body"], pr["body"]):
        raise SystemExit("apply refused: the PR title or body changed after the snapshot. "
                         "Run `snapshot` again and merge the new text into the draft.")

    fields = []
    if title != pr["title"]:
        fields += ["-f", f"title={title}"]
    if not same_body(body, pr["body"]):
        body_path = Path(snapshot["runDir"]) / "body-apply.md"
        body_path.write_text(body, encoding="utf-8")
        fields += ["-F", f"body=@{body_path}"]
    if not fields:
        print("result: noop (draft equals the current title and body)")
        return
    run(["gh", "api", "--hostname", snapshot["host"], "-X", "PATCH",
         f"repos/{snapshot['owner']}/{snapshot['name']}/pulls/{snapshot['number']}", *fields,
         "--silent"])

    after = live_pr(snapshot)
    ok = after["title"] == title and same_body(after["body"], body)
    print(f"updated: {', '.join(f.split('=')[0] for f in fields[1::2])}")
    print(f"verify: {'ok' if ok else 'MISMATCH'} ({pr['url']})")
    if not ok:
        raise SystemExit("verify failed: the PR text on GitHub differs from the draft")
    if after["headRefOid"] != pr["headRefOid"]:
        print(f"note: the PR head moved from {pr['headRefOid'][:12]} to {after['headRefOid'][:12]} "
              "after the snapshot; check that the text still matches the code")


def cleanup(snapshot_path):
    run_dir = Path(snapshot_path).resolve().parent
    if not run_dir.name.startswith(RUN_PREFIX) or not (run_dir / "snapshot.json").exists():
        raise SystemExit(f"refusing to delete {run_dir}: not a {RUN_PREFIX}* run directory")
    shutil.rmtree(run_dir)
    print(f"deleted {run_dir}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("snapshot", help="read the PR into a new run directory")
    p.add_argument("pr", nargs="?", help="PR URL, or a number with --repo; default: current branch")
    p.add_argument("--repo", help="[HOST/]OWNER/REPO for a PR number")

    for command in ("check", "apply"):
        p = sub.add_parser(command)
        p.add_argument("snapshot")
        p.add_argument("--title-file", help="default: <run dir>/title.txt (missing = keep title)")
        p.add_argument("--body-file", help="default: <run dir>/body.md (missing = keep body)")
        p.add_argument("--no-conventional", action="store_true",
                       help="do not check the title for Conventional Commits format")
        if command == "apply":
            p.add_argument("--allow", action="append", default=[],
                           help="accept errors that contain this text, after the human approved it")

    p = sub.add_parser("cleanup")
    p.add_argument("snapshot")

    args = parser.parse_args(argv)
    try:
        if args.command == "snapshot":
            path, snapshot = write_snapshot(args.pr, args.repo)
            print(summarize(path, snapshot))
        elif args.command == "cleanup":
            cleanup(args.snapshot)
        else:
            snapshot = load_snapshot(args.snapshot)
            title, body = load_draft(snapshot, args.title_file, args.body_file)
            if args.command == "check":
                return 1 if report_check(snapshot, title, body, not args.no_conventional) else 0
            apply(snapshot, title, body, not args.no_conventional, args.allow)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
