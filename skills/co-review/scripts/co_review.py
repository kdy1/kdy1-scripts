#!/usr/bin/env python3
"""Deterministic helpers for Co-Review: pin a PR, collect its review context, and clean up.

The coordinator (the agent) does the judgment. This helper only fetches, pins, classifies,
and summarizes facts about a GitHub pull request, so that the agent and the human review
the same snapshot.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PR_URL = re.compile(r"^https://([^/]+)/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$")
PR_FIELDS = ("number,url,title,body,author,state,isDraft,baseRefName,baseRefOid,headRefName,"
             "headRefOid,labels,reviewDecision,mergeStateStatus,closingIssuesReferences,"
             "statusCheckRollup,latestReviews")
RUN_PREFIX = "co-review-"
# Temporary files of a T3 Code worktree go in .t3-tmp/ at its root (see global/AGENTS.md):
# settling the thread deletes the worktree and them with it.
T3_WORKTREES = Path.home() / ".t3" / "worktrees"
T3_TMP = ".t3-tmp"
LARGE_DIFF_LINES = 500
THREAD_BODY_LIMIT = 300
# Markdown images and HTML tags, such as review-bot priority badges, in thread excerpts.
MARKUP = re.compile(r"!\[[^\]]*\]\([^)]*\)|<[^>]+>")

THREADS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) { totalCount nodes { author { login } body url } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""

# Ordered: the first matching category wins. "sensitive" is a separate flag, not a category.
CATEGORIES = (
    ("ci", re.compile(r"(^\.github/(workflows|actions)/|^\.gitlab-ci|(^|/)Jenkinsfile$|"
                      r"^\.circleci/|(^|/)azure-pipelines|^\.buildkite/)")),
    ("dependencies", re.compile(
        r"(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|"
        r"pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|"
        r"go\.sum|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|"
        r"setup\.py|setup\.cfg|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|"
        r"build\.gradle(\.kts)?|gradle\.lockfile|Package\.swift|Package\.resolved|Podfile(\.lock)?|"
        r"mix\.(exs|lock)|flake\.lock|deno\.lock)$")),
    ("migrations", re.compile(r"((^|/)migrations?/|(^|/)migrate/|\.sql$)", re.I)),
    ("generated", re.compile(r"((^|/)__snapshots__/|\.snap$|(^|/)generated/|\.generated\.|"
                             r"\.min\.(js|css)$|\.pb\.go$|_pb2\.pyi?$|(^|/)dist/|(^|/)vendor/)")),
    ("tests", re.compile(r"((^|/)(tests?|__tests__|spec|specs|testdata|fixtures|e2e)/|"
                         r"[._-](test|spec)s?\.[^/]+$|(^|/)test_[^/]+$|_test\.go$)", re.I)),
    ("docs", re.compile(r"(\.(md|mdx|rst|adoc)$|(^|/)docs?/|(^|/)(LICENSE|CHANGELOG|"
                        r"CONTRIBUTING|README)[^/]*$)", re.I)),
    ("config", re.compile(r"((^|/)\.[^/]+$|\.(ya?ml|toml|ini|cfg|conf|json|jsonc|properties)$|"
                          r"(^|/)Dockerfile[^/]*$|(^|/)Makefile$|(^|/)\.env)", re.I)),
)
SENSITIVE = re.compile(r"(auth|crypt|secret|token|passw|permission|privilege|session|oauth|"
                       r"security|sanitiz|csrf|cors|acl|credential|login|signature|jwt)", re.I)


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


def run(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:4])} failed: {result.stderr.strip()}")
    return result.stdout


def git(repo, *args):
    return run(["git", "-C", str(repo), *args]).strip()


def has_commit(repo, rev):
    return subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{rev}^{{commit}}"],
                          capture_output=True).returncode == 0


def classify(path):
    """Return (category, sensitive) for a changed path."""
    category = next((name for name, pattern in CATEGORIES if pattern.search(path)), "source")
    return category, bool(SENSITIVE.search(path))


def changed_files(repo, base, head):
    """Return per-file status, line counts, category, and sensitivity for base..head."""
    # With -z and --no-renames the output alternates: status, path, status, path, ...
    tokens = git(repo, "diff", "--no-renames", "--name-status", "-z", base, head).split("\0")
    status_by_path = dict(zip(tokens[1::2], tokens[0::2]))
    files = []
    for line in git(repo, "diff", "--no-renames", "--numstat", "-z", base, head).split("\0"):
        if not line:
            continue
        added, deleted, path = line.split("\t", 2)
        binary = added == "-"
        category, sensitive = classify(path)
        files.append({
            "path": path, "status": status_by_path.get(path, "M"), "binary": binary,
            "additions": 0 if binary else int(added), "deletions": 0 if binary else int(deleted),
            "category": category, "sensitive": sensitive,
        })
    return files


def summarize_checks(rollup):
    """Group status check results into failing, pending, and passing lists."""
    groups = {"failing": [], "pending": [], "passing": []}
    for item in rollup or []:
        if item.get("__typename") == "StatusContext" or "context" in item:
            name, url = item.get("context"), item.get("targetUrl")
            state = (item.get("state") or "").upper()
            group = ("passing" if state == "SUCCESS" else
                     "pending" if state in ("PENDING", "EXPECTED", "") else "failing")
        else:
            workflow = item.get("workflowName")
            name = f"{workflow} / {item.get('name')}" if workflow else item.get("name")
            url = item.get("detailsUrl")
            status = (item.get("status") or "").upper()
            conclusion = (item.get("conclusion") or "").upper()
            if status and status != "COMPLETED":
                group = "pending"
            elif conclusion in ("SUCCESS", "NEUTRAL", "SKIPPED"):
                group = "passing"
            else:
                group = "failing"
            state = conclusion or status
        groups[group].append({"name": name, "state": state, "url": url})
    return groups


def unresolved_threads(pages):
    """Return unresolved review threads from slurped GraphQL pages, newest data trimmed."""
    threads = []
    for page in pages:
        nodes = page["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        for node in nodes:
            if node.get("isResolved"):
                continue
            comments = node.get("comments") or {}
            first = (comments.get("nodes") or [{}])[0]
            body = MARKUP.sub("", first.get("body") or "")
            body = " ".join(body.split())
            if len(body) > THREAD_BODY_LIMIT:
                body = body[:THREAD_BODY_LIMIT - 1] + "…"
            threads.append({
                "path": node.get("path"), "line": node.get("line") or node.get("originalLine"),
                "outdated": bool(node.get("isOutdated")),
                "author": (first.get("author") or {}).get("login"),
                "comments": comments.get("totalCount", 0), "body": body, "url": first.get("url"),
            })
    return threads


def risk_signals(pr, files, checks, threads):
    """Return path- and metadata-based hints. They are prompts for review, not findings."""
    signals = []

    def paths(predicate):
        return [f["path"] for f in files if predicate(f)]

    if pr.get("state") != "OPEN":
        signals.append(f"PR state is {pr.get('state')}")
    if pr.get("isDraft"):
        signals.append("PR is a draft")
    if not (pr.get("body") or "").strip() and not pr.get("closingIssuesReferences"):
        signals.append("No PR description and no linked issue: the intent must be inferred")
    for category, label in (("dependencies", "Dependency manifests or lockfiles changed"),
                            ("ci", "CI or workflow files changed"),
                            ("migrations", "Migrations or SQL changed")):
        matched = paths(lambda f, c=category: f["category"] == c)
        if matched:
            signals.append(f"{label}: {', '.join(matched)}")
    sensitive = paths(lambda f: f["sensitive"])
    if sensitive:
        signals.append(f"Security-sensitive paths changed: {', '.join(sensitive)}")
    source = paths(lambda f: f["category"] == "source")
    if source and not paths(lambda f: f["category"] == "tests"):
        signals.append("Source files changed without test changes")
    deleted = paths(lambda f: f["status"].startswith("D"))
    if deleted:
        signals.append(f"Files deleted: {', '.join(deleted)}")
    binary = paths(lambda f: f["binary"])
    if binary:
        signals.append(f"Binary files changed: {', '.join(binary)}")
    total = sum(f["additions"] + f["deletions"] for f in files)
    if total > LARGE_DIFF_LINES:
        signals.append(f"Large diff: {total} changed lines in {len(files)} files")
    if checks["failing"]:
        signals.append("Failing checks: " + ", ".join(c["name"] or "?" for c in checks["failing"]))
    if checks["pending"]:
        signals.append(f"{len(checks['pending'])} checks still pending")
    if threads:
        signals.append(f"{len(threads)} unresolved review threads")
    if pr.get("reviewDecision") == "CHANGES_REQUESTED":
        signals.append("A reviewer requested changes")
    return signals


def pr_metadata(host, owner, name, number):
    url = f"https://{host}/{owner}/{name}/pull/{number}"
    data = json.loads(run(["gh", "pr", "view", url, "--json", PR_FIELDS]))
    data.update(host=host, repository=f"{owner}/{name}")
    return data


def fetch_threads(host, owner, name, number):
    args = ["gh", "api", "graphql", "--paginate", "--slurp", "-f", f"query={THREADS_QUERY}",
            "-F", f"owner={owner}", "-F", f"name={name}", "-F", f"number={number}"]
    if host != "github.com":
        args[3:3] = ["--hostname", host]
    return unresolved_threads(json.loads(run(args)))


def fetch_pr(root, remote, base_branch, number, head_sha, base_sha):
    """Fetch the PR into root/repo and create a detached head checkout. Return paths and SHAs."""
    mirror = root / "repo"
    git(root, "init", "--quiet", str(mirror))
    git(mirror, "config", "credential.helper", "")
    git(mirror, "config", "--add", "credential.helper", "!gh auth git-credential")
    git(mirror, "fetch", "--quiet", "--filter=blob:none", remote,
        f"+refs/heads/{base_branch}:refs/remotes/base",
        f"+refs/pull/{number}/head:refs/remotes/head")
    head = git(mirror, "rev-parse", "refs/remotes/head")
    if head != head_sha:
        raise RuntimeError(f"Fetched head {head} does not match PR head {head_sha}; "
                           "the PR changed, run prepare again")
    # The recorded base can trail the branch tip (merged PRs, moved base); pin it exactly.
    if not has_commit(mirror, base_sha):
        git(mirror, "fetch", "--quiet", "--filter=blob:none", remote, base_sha)
    merge_base = git(mirror, "merge-base", base_sha, head)
    checkout = root / "head"
    git(mirror, "worktree", "add", "--quiet", "--detach", str(checkout), head)
    return {"mirror": str(mirror), "checkout": str(checkout), "headSha": head,
            "baseSha": base_sha, "mergeBase": merge_base}


def build_context(pr, files, threads):
    checks = summarize_checks(pr.get("statusCheckRollup"))
    reviews = [{"author": (r.get("author") or {}).get("login"), "state": r.get("state")}
               for r in pr.get("latestReviews") or []]
    issues = [{"number": i.get("number"), "url": i.get("url"),
               "repository": "/".join(filter(None, [((i.get("repository") or {}).get("owner")
                                                      or {}).get("login"),
                                                     (i.get("repository") or {}).get("name")]))}
              for i in pr.get("closingIssuesReferences") or []]
    return {
        "url": pr["url"], "repository": pr["repository"], "number": pr["number"],
        "title": pr["title"], "author": (pr.get("author") or {}).get("login"),
        "state": pr["state"], "isDraft": pr["isDraft"],
        "labels": [label.get("name") for label in pr.get("labels") or []],
        "reviewDecision": pr.get("reviewDecision") or None,
        "mergeStateStatus": pr.get("mergeStateStatus"),
        "linkedIssues": issues, "reviews": reviews, "checks": checks,
        "unresolvedThreads": threads, "files": files,
        "totals": {"files": len(files),
                   "additions": sum(f["additions"] for f in files),
                   "deletions": sum(f["deletions"] for f in files)},
        "signals": risk_signals(pr, files, checks, threads),
    }


def render_summary(manifest, context):
    """Return a compact Markdown summary of the pinned PR for the coordinator."""
    lines = [
        f"# {context['repository']}#{context['number']}: {context['title']}",
        f"- URL: {context['url']}",
        f"- Author: {context['author']}; state: {context['state']}"
        + (" (draft)" if context["isDraft"] else "")
        + f"; merge state: {context['mergeStateStatus']}; review decision: "
        + f"{context['reviewDecision'] or 'none'}",
        f"- Base: {manifest['baseRef']} at {manifest['baseSha']}",
        f"- Head: {manifest['headRef']} at {manifest['headSha']}",
        f"- Merge base: {manifest['mergeBase']}",
        f"- Checkout (detached at head): {manifest['checkout']}",
        f"- Diff: git -C {manifest['checkout']} diff {manifest['mergeBase']} {manifest['headSha']}",
        f"- Size: {context['totals']['files']} files, +{context['totals']['additions']} "
        f"-{context['totals']['deletions']}",
    ]
    if context["linkedIssues"]:
        lines.append("- Linked issues: " + ", ".join(i["url"] for i in context["linkedIssues"]))
    if context["labels"]:
        lines.append("- Labels: " + ", ".join(context["labels"]))
    if context["reviews"]:
        lines.append("- Latest reviews: " + ", ".join(f"{r['author']} {r['state']}"
                                                      for r in context["reviews"]))
    checks = context["checks"]
    lines.append(f"- Checks: {len(checks['failing'])} failing, {len(checks['pending'])} pending, "
                 f"{len(checks['passing'])} passing")
    for check in checks["failing"]:
        lines.append(f"  - FAILING {check['name']} ({check['state']}): {check['url']}")

    lines.append("\n## Files by category")
    by_category = {}
    for f in context["files"]:
        by_category.setdefault(f["category"], []).append(f)
    for category in [name for name, _ in CATEGORIES] + ["source"]:
        group = by_category.get(category)
        if not group:
            continue
        lines.append(f"- {category} ({len(group)}):")
        for f in group:
            flags = "binary" if f["binary"] else f"+{f['additions']} -{f['deletions']}"
            mark = " [sensitive]" if f["sensitive"] else ""
            lines.append(f"  - {f['status']} {f['path']} ({flags}){mark}")

    lines.append("\n## Unresolved review threads")
    if context["unresolvedThreads"]:
        for t in context["unresolvedThreads"]:
            where = f"{t['path']}:{t['line']}" if t["line"] else t["path"]
            outdated = " (outdated)" if t["outdated"] else ""
            lines.append(f"- {where}{outdated} by {t['author']}, {t['comments']} comments: "
                         f"{t['body']} {t['url']}")
    else:
        lines.append("- none")

    lines.append("\n## Risk signals (path and metadata hints, not findings)")
    lines.extend(f"- {s}" for s in context["signals"] or ["none"])
    lines.append(f"\nManifest: {manifest['manifest']}")
    lines.append(f"Full context JSON: {manifest['context']}")
    return "\n".join(lines)


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def t3_worktree_root(cwd=None, worktrees=T3_WORKTREES):
    """Return the T3 Code worktree that contains cwd, or None outside one."""
    proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd or Path.cwd(),
                          capture_output=True, text=True)
    if proc.returncode or not proc.stdout.strip():
        return None
    top = Path(proc.stdout.strip()).resolve()
    # A checkout inside .t3-tmp/ (for example a Co-Review head checkout) belongs to the
    # worktree that holds that .t3-tmp/.
    if T3_TMP in top.parts:
        top = Path(*top.parts[:top.parts.index(T3_TMP)])
    try:
        top.relative_to(Path(worktrees).resolve())
    except ValueError:
        return None
    return top


def temp_parent(cwd=None, worktrees=T3_WORKTREES):
    """Return the directory for a new run directory: .t3-tmp/ in a T3 Code worktree, else
    None (the system temporary directory, which TMPDIR sets)."""
    root = t3_worktree_root(cwd, worktrees)
    if root is None:
        return None
    parent = root / T3_TMP
    parent.mkdir(exist_ok=True)
    return str(parent)


def prepare(ref, repo=None, run_dir=None):
    """Pin the PR, create a head checkout, and write manifest.json and context.json."""
    host, owner, name, number = parse_pr(ref, repo)
    pr = pr_metadata(host, owner, name, number)
    threads = fetch_threads(host, owner, name, number)
    created = run_dir is None
    root = (Path(tempfile.mkdtemp(prefix=RUN_PREFIX, dir=temp_parent())) if created
            else Path(run_dir))
    root.mkdir(parents=True, exist_ok=True)
    try:
        pinned = fetch_pr(root, f"https://{host}/{owner}/{name}.git", pr["baseRefName"], number,
                          pr["headRefOid"], pr["baseRefOid"])
        files = changed_files(pinned["mirror"], pinned["mergeBase"], pinned["headSha"])
        if not files:
            raise ValueError("Nothing to review: the PR head has no changes against its base")
        context = build_context(pr, files, threads)
        manifest = dict(pinned, host=host, repository=pr["repository"], number=number,
                        url=pr["url"], baseRef=pr["baseRefName"], headRef=pr["headRefName"],
                        runDir=str(root), manifest=str(root / "manifest.json"),
                        context=str(root / "context.json"))
        write_json(root / "manifest.json", manifest)
        write_json(root / "context.json", context)
        return manifest, context
    except BaseException:
        if created:
            shutil.rmtree(root, ignore_errors=True)
        raise


def add_base(manifest):
    """Create a detached checkout at the merge base for base-vs-head runs."""
    path = Path(manifest["runDir"]) / "base"
    if not path.exists():
        git(manifest["mirror"], "worktree", "add", "--quiet", "--detach", str(path),
            manifest["mergeBase"])
    return str(path)


def refresh(manifest):
    """Re-read the PR and return (notes, context) for the pinned snapshot's current state."""
    owner, name = manifest["repository"].split("/")
    pr = pr_metadata(manifest["host"], owner, name, manifest["number"])
    threads = fetch_threads(manifest["host"], owner, name, manifest["number"])
    files = json.loads(Path(manifest["context"]).read_text(encoding="utf-8"))["files"]
    context = build_context(pr, files, threads)
    notes = []
    if pr["headRefOid"] != manifest["headSha"]:
        notes.append(f"PR head moved to {pr['headRefOid']}; the review covers {manifest['headSha']}. "
                     "Run prepare again to review the new head.")
    for side in ("head", "base"):
        path = Path(manifest["runDir"]) / side
        if path.exists() and git(path, "status", "--porcelain"):
            notes.append(f"The {side} checkout has local edits (instrumentation or trial fixes)")
    write_json(Path(manifest["context"]), context)
    return notes, context


def cleanup(manifest):
    root = Path(manifest["runDir"])
    if not (root / "manifest.json").is_file() or not root.name.startswith(RUN_PREFIX):
        raise ValueError(f"Refusing to delete {root}: not a Co-Review run directory")
    shutil.rmtree(root)


def load_manifest(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="Pin a PR, check out its head, and summarize it")
    prep.add_argument("pr", help="PR URL, or a number with --repo")
    prep.add_argument("--repo", help="[HOST/]OWNER/REPO when the PR is a number")
    prep.add_argument("--run-dir", help="Run directory (default: a new directory in .t3-tmp/ at "
                      "the root of a T3 Code worktree, else in the system temporary directory)")
    base = sub.add_parser("base", help="Create a checkout at the merge base for base-vs-head runs")
    base.add_argument("manifest")
    again = sub.add_parser("refresh", help="Re-read checks, reviews, and threads; report head moves")
    again.add_argument("manifest")
    clean = sub.add_parser("cleanup", help="Delete the run directory")
    clean.add_argument("manifest")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            manifest, context = prepare(args.pr, args.repo, args.run_dir)
            if context["state"] != "OPEN":
                print(f"warning: PR state is {context['state']}", file=sys.stderr)
            print(render_summary(manifest, context))
        elif args.command == "base":
            print(add_base(load_manifest(args.manifest)))
        elif args.command == "refresh":
            manifest = load_manifest(args.manifest)
            notes, context = refresh(manifest)
            for note in notes:
                print(f"note: {note}")
            print(render_summary(manifest, context))
        elif args.command == "cleanup":
            cleanup(load_manifest(args.manifest))
            print("removed")
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        parser.exit(1, f"co-review: {error}\n")


if __name__ == "__main__":
    main()
