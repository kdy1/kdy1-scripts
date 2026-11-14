#!/usr/bin/env python3
"""Deterministic helpers for Review PR Once: targets, checkouts, prompts, checks."""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Stable reviewer order: slug, providerInstanceId, model.
REVIEWERS = (
    ("astra", "codex", "gpt-6-astra"),
    ("sol", "codex", "gpt-6.1-sol"),
    ("opus", "claudeAgent", "claude-opus-5-5"),
    ("sonnet", "claudeAgent", "claude-sonnet-5-5"),
)
PR_URL = re.compile(r"^https://([^/]+)/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$")
PR_FIELDS = "number,url,title,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid"
PROMPT_TEMPLATE = Path(__file__).resolve().parent.parent / "references" / "reviewer-prompt.md"


def parse_pr(ref, repo=None):
    """Return (host, owner, name, number) for a PR URL or a number plus OWNER/REPO."""
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
    raise ValueError(f"Expected a pull request URL or a number with --repo: {ref!r}")


def option_values(option):
    """Return the allowed values of a catalog option in either catalog shape."""
    if isinstance(option.get("values"), list):
        return [value.get("id") if isinstance(value, dict) else value
                for value in option["values"]]
    return [value.get("id") for value in option.get("options") or []
            if isinstance(value, dict)]


def parse_settings(entries):
    """Parse SLUG:OPTION=VALUE entries into {slug: {option: value}}."""
    slugs = {slug for slug, _, _ in REVIEWERS}
    settings = {}
    for entry in entries or []:
        match = re.match(r"^([a-z]+):([A-Za-z]+)=(.+)$", entry)
        if not match or match.group(1) not in slugs:
            raise ValueError(f"Expected SLUG:OPTION=VALUE with a known slug: {entry!r}")
        slug, option, value = match.groups()
        if value in ("true", "false"):
            value = value == "true"
        settings.setdefault(slug, {})[option] = value
    return settings


def select_targets(response, settings=None):
    """Validate the four reviewer models in a capabilities response and return targets."""
    if response.get("isError"):
        raise ValueError("T3 capabilities returned an error")
    catalog = response.get("structuredContent", response)
    if not isinstance(catalog, dict) or not isinstance(catalog.get("providers"), list):
        raise ValueError("Expected a T3 capabilities object with providers")
    if catalog.get("features", {}).get("appOwnedSubagents") is not True:
        raise ValueError("T3 app-owned subagents are unavailable")
    inherited = catalog.get("inheritedProviderInstanceId")
    providers = {provider.get("providerInstanceId"): provider for provider in catalog["providers"]}
    settings = settings or {}
    targets, problems = [], []
    for slug, provider_id, model_id in REVIEWERS:
        provider = providers.get(provider_id)
        if not provider or provider.get("canRunChildTask") is not True:
            problems.append(f"{slug}: provider {provider_id} cannot run child tasks")
            continue
        if provider_id != inherited and provider.get("canRunCrossProviderChildTask") is not True:
            problems.append(f"{slug}: provider {provider_id} cannot run cross-provider child tasks")
            continue
        model = next((m for m in provider.get("models", []) if m.get("id") == model_id), None)
        if model is None:
            problems.append(f"{slug}: model {provider_id}/{model_id} is not in the catalog "
                            "(rerun orchestrator_capabilities with search if it was omitted)")
            continue
        options = {option.get("id"): option for option in model.get("options") or []}
        for key, value in settings.get(slug, {}).items():
            if key not in options or value not in option_values(options[key]):
                problems.append(f"{slug}: {model_id} does not support {key}={value}")
        target = {"providerInstanceId": provider_id, "model": model_id}
        if settings.get(slug):
            target["options"] = settings[slug]
        targets.append({"slug": slug, "target": target})
    if problems:
        raise ValueError("; ".join(problems))
    return targets


def run(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:3])} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def pr_metadata(host, owner, name, number):
    url = f"https://{host}/{owner}/{name}/pull/{number}"
    data = json.loads(run(["gh", "pr", "view", url, "--json", PR_FIELDS]))
    data.update(host=host, repository=f"{owner}/{name}")
    return data


def prepare(ref, repo=None, run_dir=None):
    """Fetch the pinned PR into a private repository and create one checkout per reviewer."""
    host, owner, name, number = parse_pr(ref, repo)
    pr = pr_metadata(host, owner, name, number)
    if pr["state"] != "OPEN":
        print(f"warning: PR state is {pr['state']}", file=sys.stderr)
    created = run_dir is None
    root = Path(tempfile.mkdtemp(prefix="review-pr-once-")) if created else Path(run_dir)
    root.mkdir(parents=True, exist_ok=True)
    try:
        return _prepare_checkouts(root, host, owner, name, number, pr)
    except BaseException:
        if created:
            shutil.rmtree(root, ignore_errors=True)
        raise


def _prepare_checkouts(root, host, owner, name, number, pr):
    mirror = root / "repo"
    run(["git", "init", "--quiet", str(mirror)])
    run(["git", "-C", str(mirror), "config", "credential.helper", ""])
    run(["git", "-C", str(mirror), "config", "--add", "credential.helper",
         "!gh auth git-credential"])
    remote = f"https://{host}/{owner}/{name}.git"
    run(["git", "-C", str(mirror), "fetch", "--quiet", "--filter=blob:none", remote,
         f"+refs/heads/{pr['baseRefName']}:refs/remotes/base",
         f"+refs/pull/{number}/head:refs/remotes/head"])
    head = run(["git", "-C", str(mirror), "rev-parse", "refs/remotes/head"])
    if head != pr["headRefOid"]:
        raise RuntimeError(f"Fetched head {head} does not match PR head {pr['headRefOid']}; "
                           "the PR changed, rerun prepare")
    # The recorded base can trail the branch tip (merged PRs, moved base); pin it exactly.
    base = pr["baseRefOid"]
    if subprocess.run(["git", "-C", str(mirror), "cat-file", "-e", f"{base}^{{commit}}"],
                      capture_output=True).returncode != 0:
        run(["git", "-C", str(mirror), "fetch", "--quiet", "--filter=blob:none", remote, base])
    merge_base = run(["git", "-C", str(mirror), "merge-base", base, head])
    checkouts = {}
    for slug, _, _ in REVIEWERS:
        path = root / "reviewers" / slug
        run(["git", "-C", str(mirror), "worktree", "add", "--quiet", "--detach", str(path), head])
        checkouts[slug] = str(path)
    manifest = {
        "runDir": str(root), "host": host, "repository": pr["repository"], "number": number,
        "url": pr["url"], "title": pr["title"], "state": pr["state"], "isDraft": pr["isDraft"],
        "baseRef": pr["baseRefName"], "baseSha": base, "headRef": pr["headRefName"],
        "headSha": head, "mergeBase": merge_base, "checkouts": checkouts,
    }
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest["manifest"] = str(path)
    return manifest


def render_prompt(manifest, slug, template=None):
    """Render the reviewer prompt for one slug from a manifest."""
    if slug not in manifest["checkouts"]:
        raise ValueError(f"Unknown reviewer slug: {slug}")
    text = template if template is not None else PROMPT_TEMPLATE.read_text(encoding="utf-8")
    values = {
        "PR_URL": manifest["url"], "PR_TITLE": manifest["title"],
        "REPOSITORY": manifest["repository"], "BASE_REF": manifest["baseRef"],
        "BASE_SHA": manifest["baseSha"], "HEAD_REF": manifest["headRef"],
        "HEAD_SHA": manifest["headSha"], "MERGE_BASE": manifest["mergeBase"],
        "CHECKOUT": manifest["checkouts"][slug],
    }
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", str(value))
    leftover = re.findall(r"\{\{[A-Z_]+\}\}", text)
    if leftover:
        raise ValueError(f"Unreplaced placeholders: {sorted(set(leftover))}")
    return text


def verify(manifest):
    """Return problems for checkouts that moved or gained changes, plus PR drift."""
    problems = []
    for slug, path in manifest["checkouts"].items():
        try:
            head = run(["git", "-C", path, "rev-parse", "HEAD"])
            status = run(["git", "-C", path, "status", "--porcelain"])
        except RuntimeError as error:
            problems.append(f"{slug}: {error}")
            continue
        if head != manifest["headSha"]:
            problems.append(f"{slug}: checkout moved to {head}")
        if status:
            problems.append(f"{slug}: checkout has changes:\n{status}")
    owner, name = manifest["repository"].split("/")
    current = pr_metadata(manifest["host"], owner, name, manifest["number"])
    if current["headRefOid"] != manifest["headSha"]:
        problems.append(f"PR head changed to {current['headRefOid']} after review started")
    return problems


def cleanup(manifest):
    root = Path(manifest["runDir"])
    if not (root / "manifest.json").is_file() or not root.name.startswith("review-pr-once-"):
        raise ValueError(f"Refusing to delete {root}: not a Review PR Once run directory")
    shutil.rmtree(root)


def load_manifest(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    targets = sub.add_parser("targets", help="Validate reviewer models in a capabilities JSON")
    targets.add_argument("capabilities", type=Path)
    targets.add_argument("--set", action="append", metavar="SLUG:OPTION=VALUE",
                         help="Explicit user-requested model option, e.g. astra:reasoningEffort=xhigh")
    prep = sub.add_parser("prepare", help="Fetch the PR and create reviewer checkouts")
    prep.add_argument("pr", help="PR URL, or a number with --repo")
    prep.add_argument("--repo", help="[HOST/]OWNER/REPO when the PR is a number")
    prep.add_argument("--run-dir", help="Run directory (default: new temporary directory)")
    prompt = sub.add_parser("prompt", help="Render one reviewer prompt")
    prompt.add_argument("manifest")
    prompt.add_argument("slug", choices=[slug for slug, _, _ in REVIEWERS])
    check = sub.add_parser("verify", help="Check checkouts are unchanged and the PR did not move")
    check.add_argument("manifest")
    clean = sub.add_parser("cleanup", help="Delete the run directory")
    clean.add_argument("manifest")
    args = parser.parse_args()
    try:
        if args.command == "targets":
            response = json.loads(args.capabilities.read_text(encoding="utf-8"))
            print(json.dumps(select_targets(response, parse_settings(args.set)), indent=2))
        elif args.command == "prepare":
            print(json.dumps(prepare(args.pr, args.repo, args.run_dir), indent=2))
        elif args.command == "prompt":
            print(render_prompt(load_manifest(args.manifest), args.slug))
        elif args.command == "verify":
            problems = verify(load_manifest(args.manifest))
            if problems:
                parser.exit(1, "\n".join(problems) + "\n")
            print("ok")
        elif args.command == "cleanup":
            cleanup(load_manifest(args.manifest))
            print("removed")
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        parser.exit(1, f"review-pr-once: {error}\n")


if __name__ == "__main__":
    main()
