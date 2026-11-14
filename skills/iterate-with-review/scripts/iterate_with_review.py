#!/usr/bin/env python3
"""Track Iterate with Review rounds: workspace setup, Review Once results, dispositions,
and the stop rule.

Iterate with Review stops only after a clean round: every reviewer completed, and every
finding was rejected with evidence, at the commit that the round reviewed.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REVIEW_ONCE_SCRIPTS = Path(__file__).resolve().parents[2] / "review-once" / "scripts"
sys.path.insert(0, str(REVIEW_ONCE_SCRIPTS))
from review_once import REVIEWERS, default_base, git, parse_pr, run  # noqa: E402

SLUGS = tuple(slug for slug, _, _ in REVIEWERS)
VERDICTS = ("right-direction", "right-direction-with-changes", "wrong-direction", "cannot-judge")
DISPOSITIONS = ("applied", "rejected")
PRIORITIES = ("P0", "P1", "P2", "P3")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_ledger(workspace, branch):
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "iterate-with-review"
    digest = hashlib.sha256(f"{Path(workspace).resolve()}\0{branch}".encode()).hexdigest()[:12]
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{Path(workspace).name}-{branch}")
    return base / f"{name}-{digest}.json"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, ledger):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def repo_slug(url):
    """Return 'host/owner/name' for an HTTPS, SSH, or scp-style Git remote URL."""
    match = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^:/]+)[:/](?::?\d+/)?([^/]+)/([^/]+?)(?:\.git)?/?$",
                     url.strip())
    return "/".join(match.groups()).lower() if match else None


def worktrees(repo):
    """Parse `git worktree list --porcelain` into dicts with path, head, and branch."""
    entries, current = [], {}
    for line in git(repo, "worktree", "list", "--porcelain").splitlines() + [""]:
        if not line:
            if current:
                entries.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        current[{"worktree": "path"}.get(key, key)] = value or True
    return entries


def is_ancestor(repo, ancestor, commit):
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, commit],
                          capture_output=True).returncode == 0


def pr_info(url):
    host, owner, name, number = parse_pr(url)
    fields = "number,url,title,body,state,baseRefName,headRefName,headRefOid"
    data = json.loads(run(["gh", "pr", "view", f"https://{host}/{owner}/{name}/pull/{number}",
                           "--json", fields]))
    data.update(host=host, owner=owner, name=name)
    return data


def pr_workspace(url, repo=".", dest=None):
    """Return a local worktree on the PR branch, creating one with `gh pr checkout` if needed."""
    pr = pr_info(url)
    repo = Path(git(repo, "rev-parse", "--show-toplevel"))
    for entry in worktrees(repo):
        if (entry.get("branch") == f"refs/heads/{pr['headRefName']}"
                and Path(entry["path"]).is_dir()
                and is_ancestor(entry["path"], pr["headRefOid"], "HEAD")):
            return {"workspace": entry["path"], "created": False, "branch": pr["headRefName"]}
    dest = Path(dest) if dest else repo.parent / f"{repo.name}-iterate-with-review-pr-{pr['number']}"
    if dest.exists():
        raise ValueError(f"{dest} already exists; pass --dest")
    run(["gh", "pr", "checkout", pr["url"], "--worktree", str(dest)], cwd=str(repo))
    branch = git(dest, "branch", "--show-current")
    return {"workspace": str(dest), "created": True, "branch": branch}


def base_remote(repo, host, owner, name):
    want = f"{host}/{owner}/{name}".lower()
    for remote in git(repo, "remote").splitlines():
        if repo_slug(git(repo, "remote", "get-url", remote)) == want:
            return remote
    raise ValueError(f"No remote points at {want}; add one or pass --base")


def init(workspace, pr_url=None, base=None, intent=None, ledger_path=None):
    """Create a ledger for the workspace's current branch and resolve a fixed base ref."""
    repo = Path(git(workspace, "rev-parse", "--show-toplevel"))
    branch = git(repo, "branch", "--show-current")
    if not branch:
        raise ValueError("The workspace is on a detached HEAD; check out a branch first")
    pr = None
    intent_parts = []
    if pr_url:
        pr = pr_info(pr_url)
        if pr["state"] != "OPEN":
            raise ValueError(f"PR is {pr['state']}, not open")
        if not is_ancestor(repo, pr["headRefOid"], "HEAD"):
            raise ValueError(f"Local HEAD does not contain the PR head {pr['headRefOid']}; "
                             "update the branch first")
        if not base:
            remote = base_remote(repo, pr["host"], pr["owner"], pr["name"])
            git(repo, "fetch", "--quiet", remote, pr["baseRefName"])
            base = f"{remote}/{pr['baseRefName']}"
        intent_parts.append(f"Pull request: {pr['url']}\nTitle: {pr['title']}\n\n{pr['body'] or ''}".strip())
    base = base or default_base(repo)
    git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    if intent and intent.strip():
        intent_parts.append(intent.strip())
    ledger_path = Path(ledger_path) if ledger_path else default_ledger(repo, branch)
    if ledger_path.exists():
        raise ValueError(f"Ledger {ledger_path} already exists; resume it or pass --ledger")
    intent_file = ledger_path.with_suffix(".intent.md")
    if intent_parts:
        intent_file.parent.mkdir(parents=True, exist_ok=True)
        intent_file.write_text("\n\n".join(intent_parts) + "\n", encoding="utf-8")
    ledger = {
        "workspace": str(repo), "branch": branch, "base": base,
        "pr": pr and {"url": pr["url"], "number": pr["number"], "headAtStart": pr["headRefOid"]},
        "startHead": git(repo, "rev-parse", "HEAD"),
        "intentFile": str(intent_file) if intent_parts else None,
        "createdAt": now(), "rounds": [], "finished": False,
    }
    save(ledger_path, ledger)
    return dict(ledger, ledger=str(ledger_path))


def require_clean(repo):
    status = git(repo, "status", "--porcelain")
    if status:
        raise ValueError(f"Workspace has uncommitted changes:\n{status}")


def round_start(path):
    ledger = load(path)
    if ledger["finished"]:
        raise ValueError("Iteration already finished")
    if ledger["rounds"] and ledger["rounds"][-1]["status"] == "reviewing":
        raise ValueError(f"Round {ledger['rounds'][-1]['number']} is still open; record it first")
    repo = ledger["workspace"]
    if git(repo, "branch", "--show-current") != ledger["branch"]:
        raise ValueError(f"Workspace is no longer on {ledger['branch']}")
    require_clean(repo)
    entry = {"number": len(ledger["rounds"]) + 1, "head": git(repo, "rev-parse", "HEAD"),
             "startedAt": now(), "status": "reviewing"}
    ledger["rounds"].append(entry)
    save(path, ledger)
    return entry


def validate_result(result, repo, round_head):
    """Return problems in a round result; an empty list means the result is acceptable."""
    problems = []
    reviewers = {r.get("slug"): r for r in result.get("reviewers", [])}
    for slug in SLUGS:
        reviewer = reviewers.get(slug)
        if reviewer is None:
            problems.append(f"reviewer {slug} is missing")
        elif reviewer.get("complete") and reviewer.get("verdict") not in VERDICTS:
            problems.append(f"reviewer {slug} has invalid verdict {reviewer.get('verdict')!r}")
    for unknown in set(reviewers) - set(SLUGS):
        problems.append(f"unknown reviewer {unknown}")
    ids = set()
    for finding in result.get("findings", []):
        fid = finding.get("id")
        if not fid or fid in ids:
            problems.append(f"finding id {fid!r} is missing or duplicated")
        ids.add(fid)
        if finding.get("priority") not in PRIORITIES:
            problems.append(f"{fid}: priority must be one of {PRIORITIES}")
        if not finding.get("title") or not finding.get("reporters"):
            problems.append(f"{fid}: title and reporters are required")
        if set(finding.get("reporters") or []) - set(SLUGS):
            problems.append(f"{fid}: unknown reporter")
        disposition = finding.get("disposition")
        if disposition not in DISPOSITIONS:
            problems.append(f"{fid}: disposition must be applied or rejected, not {disposition!r}")
        elif disposition == "rejected" and not str(finding.get("evidence") or "").strip():
            problems.append(f"{fid}: a rejection needs evidence")
        elif disposition == "applied":
            commits = finding.get("commits") or []
            if not commits:
                problems.append(f"{fid}: an applied finding needs its fix commits")
            for commit in commits:
                if not (is_ancestor(repo, round_head, commit) and is_ancestor(repo, commit, "HEAD")
                        and commit != round_head):
                    problems.append(f"{fid}: commit {commit} is not a new commit on this branch")
    return problems


def round_record(path, result):
    """Store a round's reviewers and finding dispositions, after all fixes are committed."""
    ledger = load(path)
    if not ledger["rounds"] or ledger["rounds"][-1]["status"] != "reviewing":
        raise ValueError("No open round; run round-start first")
    entry = ledger["rounds"][-1]
    repo = ledger["workspace"]
    require_clean(repo)
    problems = validate_result(result, repo, entry["head"])
    if problems:
        raise ValueError("Invalid round result:\n" + "\n".join(problems))
    complete = all(r.get("complete") for r in result["reviewers"])
    applied = [f for f in result.get("findings", []) if f["disposition"] == "applied"]
    clean = complete and not applied and git(repo, "rev-parse", "HEAD") == entry["head"]
    entry.update(reviewers=result["reviewers"], findings=result.get("findings", []),
                 recordedAt=now(), endHead=git(repo, "rev-parse", "HEAD"),
                 status="clean" if clean else ("incomplete" if not complete else "fixed"))
    if clean:
        ledger["finished"] = True
    save(path, ledger)
    return {"round": entry["number"], "status": entry["status"], "finished": ledger["finished"],
            "applied": len(applied), "rejected": len(result.get("findings", [])) - len(applied)}


def summary(ledger):
    """Return a Markdown summary of all rounds."""
    lines = ["| Round | Status | Verdicts | Applied | Rejected |", "| --- | --- | --- | --- | --- |"]
    for entry in ledger["rounds"]:
        verdicts = ", ".join(f"{r['slug']}: {r.get('verdict') if r.get('complete') else 'incomplete'}"
                             for r in entry.get("reviewers", []))
        findings = entry.get("findings", [])
        applied = sum(f["disposition"] == "applied" for f in findings)
        lines.append(f"| {entry['number']} | {entry['status']} | {verdicts or '-'} | "
                     f"{applied} | {len(findings) - applied} |")
    lines.append("")
    lines.append(f"Finished: {'yes' if ledger['finished'] else 'no'}; "
                 f"commits {ledger['startHead'][:12]}..{git(ledger['workspace'], 'rev-parse', 'HEAD')[:12]}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    ws = sub.add_parser("pr-workspace", help="Find or create a local worktree on a PR's branch")
    ws.add_argument("pr")
    ws.add_argument("--repo", default=".", help="Directory inside the local clone (default: .)")
    ws.add_argument("--dest", help="Worktree path to create (default: sibling of the clone)")
    start = sub.add_parser("init", help="Create the ledger and fix the base ref")
    start.add_argument("--workspace", default=".")
    start.add_argument("--pr", help="PR URL when iterating on a pull request")
    start.add_argument("--base", help="Base ref (default: the PR base, else Review Once's default)")
    start.add_argument("--intent-file", type=Path, help="File with the user's stated intent")
    start.add_argument("--ledger", help="Ledger path (default: under ~/.cache/iterate-with-review)")
    for name, help_text in (("round-start", "Open the next round at the committed HEAD"),
                            ("status", "Print the ledger"), ("summary", "Print a Markdown summary")):
        cmd = sub.add_parser(name, help=help_text)
        cmd.add_argument("ledger")
    record = sub.add_parser("round-record", help="Record the open round's result JSON")
    record.add_argument("ledger")
    record.add_argument("result", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "pr-workspace":
            print(json.dumps(pr_workspace(args.pr, args.repo, args.dest), indent=2))
        elif args.command == "init":
            intent = args.intent_file.read_text(encoding="utf-8") if args.intent_file else None
            print(json.dumps(init(args.workspace, args.pr, args.base, intent, args.ledger), indent=2))
        elif args.command == "round-start":
            print(json.dumps(round_start(args.ledger), indent=2))
        elif args.command == "round-record":
            result = json.loads(args.result.read_text(encoding="utf-8"))
            print(json.dumps(round_record(args.ledger, result), indent=2))
        elif args.command == "status":
            print(json.dumps(load(args.ledger), indent=2, ensure_ascii=False))
        elif args.command == "summary":
            print(summary(load(args.ledger)))
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        parser.exit(1, f"iterate-with-review: {error}\n")


if __name__ == "__main__":
    main()
