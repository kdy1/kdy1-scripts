#!/usr/bin/env python3
"""Free disk space by removing regenerable build output and tool caches until a target is met."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


GB = 1000 ** 3
HOUR = 3600
# Agent-created checkouts are cheap to rebuild; the user's own checkouts wait longer.
AGENT_ROOTS = [
    "~/.t3/worktrees", "~/.t3/slop-fix-batch", "~/.t3/batches", "~/.t3/scratch",
    "~/.t3/task-artifacts", "~/.t3/review-artifacts",
    "~/.claude/slop-fix-batch", "~/.codex/slop-fix-batch", "~/.codex/batches",
    "~/.codex/collect-review-runs", "/private/tmp",
]
PROJECT_ROOTS = ["~/projects"]
AGENT_IDLE_HOURS = 24
PROJECT_IDLE_HOURS = 24 * 7
NODE_ARTIFACTS = {".next", ".nuxt", ".parcel-cache", ".svelte-kit", ".turbo", "node_modules"}
ARTIFACT_NAMES = NODE_ARTIFACTS | {"target", ".build"}
SKIP_DESCEND = {".git", ".hg", ".svn"}
TOOL_CACHES = [
    # (name, executable, command, processes that indicate the cache is in use)
    ("npm cache", "npm", ["npm", "cache", "clean", "--force"], ["npm"]),
    ("pnpm store", "pnpm", ["pnpm", "store", "prune"], ["pnpm"]),
    ("yarn cache", "yarn", ["yarn", "cache", "clean"], ["yarn"]),
    ("bun cache", "bun", ["bun", "pm", "cache", "rm"], ["bun"]),
    ("go build cache", "go", ["go", "clean", "-cache", "-testcache"], ["go"]),
    ("uv cache", "uv", ["uv", "cache", "prune"], ["uv"]),
    ("pip cache", "pip3", ["pip3", "cache", "purge"], ["pip", "pip3"]),
    ("homebrew cache", "brew", ["brew", "cleanup", "--prune=all"], ["brew"]),
    ("docker build cache", "docker", ["docker", "builder", "prune", "-af"], []),
    ("docker dangling images", "docker", ["docker", "image", "prune", "-f"], []),
    ("unavailable simulators", "xcrun", ["xcrun", "simctl", "delete", "unavailable"], ["Simulator"]),
]
DERIVED_DATA = "~/Library/Developer/Xcode/DerivedData"


def expand(path):
    return Path(os.path.expanduser(path))


def free_bytes(path):
    return shutil.disk_usage(path).free


def mtime(path):
    try:
        return path.lstat().st_mtime
    except OSError:
        return 0.0


def artifact_kind(path):
    """Return the regenerable artifact type of a directory, or None."""
    name, parent = path.name, path.parent
    if name == "target":
        if (parent / "Cargo.toml").is_file():
            return "cargo-target"
        try:
            tag = (path / "CACHEDIR.TAG").read_text(errors="replace")
        except OSError:
            return None
        return "cargo-target" if "created by cargo" in tag else None
    if name in NODE_ARTIFACTS and (parent / "package.json").is_file():
        return name.lstrip(".")
    if name == ".build" and (parent / "Package.swift").is_file():
        return "swiftpm-build"
    return None


def find_artifacts(root):
    """Walk a root without following symlinks and stop descending at artifacts."""
    found, stack = [], [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            path = Path(entry.path)
            if entry.name in SKIP_DESCEND:
                continue
            if entry.name in ARTIFACT_NAMES:
                kind = artifact_kind(path)
                if kind:
                    found.append((path, kind))
                    continue
            stack.append(path)
    return found


def checkout(project, root=None):
    """Return the checkout root and git directory that contain project below root, if any."""
    for directory in [project, *project.parents]:
        if root is not None and directory == root:
            break
        dot_git = directory / ".git"
        if dot_git.is_dir():
            return directory, dot_git
        if dot_git.is_file():
            try:
                text = dot_git.read_text().strip()
            except OSError:
                return directory, None
            if not text.startswith("gitdir:"):
                return directory, None
            return directory, (directory / text.split(":", 1)[1].strip()).resolve()
    return None, None


def git_markers(project, root=None):
    _, git_dir = checkout(project, root)
    return [git_dir / "index", git_dir / "HEAD"] if git_dir else []


def last_activity(path, kind, root=None):
    """Newest mtime of the artifact's top levels, its manifest, and the checkout's git state."""
    depth = 2 if kind == "cargo-target" else 1
    newest, level = mtime(path), [path]
    for _ in range(depth):
        following = []
        for directory in level:
            try:
                entries = list(os.scandir(directory))
            except OSError:
                continue
            for entry in entries:
                child = Path(entry.path)
                newest = max(newest, mtime(child))
                if entry.is_dir(follow_symlinks=False):
                    following.append(child)
        level = following
    for marker in [path.parent, *git_markers(path.parent, root)]:
        newest = max(newest, mtime(marker))
    return newest


def process_cwds():
    result = subprocess.run(
        ["lsof", "-nP", "-d", "cwd", "-Fn"], capture_output=True, text=True, check=False
    )
    return [Path(line[1:]) for line in result.stdout.splitlines() if line.startswith("n/")]


class FreshCwds:
    """Process working directories, refreshed at most every `ttl` seconds."""

    def __init__(self, ttl=30):
        # The monotonic clock may start near zero, so "never fetched" needs its own marker.
        self.ttl, self.at, self.value = ttl, None, []

    def get(self):
        if self.at is None or time.monotonic() - self.at > self.ttl:
            self.value, self.at = process_cwds(), time.monotonic()
        return self.value


def is_within(path, other):
    return path == other or other in path.parents


def busy_reason(path, cwds, excludes, root=None):
    # A process working anywhere in the checkout may be building it.
    project = checkout(path.parent, root)[0] or path.parent
    for cwd in cwds:
        if is_within(cwd, project):
            return f"process cwd {cwd}"
    for excluded in excludes:
        if is_within(path, excluded) or is_within(excluded, project):
            return f"excluded {excluded}"
    return None


def collect(roots, idle_hours, cwds, excludes, now):
    """Return deletion candidates (oldest first) and skipped artifacts with reasons."""
    candidates, skipped = [], []
    for root in roots:
        root = expand(root)
        if not root.is_dir() or root.is_symlink():
            continue
        for path, kind in find_artifacts(root):
            reason = busy_reason(path, cwds, excludes, root)
            activity = last_activity(path, kind, root)
            idle = (now - activity) / HOUR
            if reason is None and idle < idle_hours:
                reason = f"active {idle:.1f}h ago (< {idle_hours}h)"
            record = {"path": str(path), "kind": kind, "root": str(root), "idleHours": round(idle, 1)}
            if reason:
                skipped.append({**record, "reason": reason})
            else:
                candidates.append(record)
    candidates.sort(key=lambda item: -item["idleHours"])
    return candidates, skipped


def du_bytes(path):
    result = subprocess.run(["du", "-sk", path], capture_output=True, text=True, check=False)
    try:
        return int(result.stdout.split()[0]) * 1024
    except (IndexError, ValueError):
        return 0


def measure(records, workers=8):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for record, size in zip(records, pool.map(du_bytes, [r["path"] for r in records])):
            record["bytes"] = size


def safe_to_delete(path, kind, roots):
    """Re-check a candidate immediately before deletion."""
    if path.is_symlink() or not path.is_dir() or path.name not in ARTIFACT_NAMES:
        return False
    if artifact_kind(path) != kind:
        return False
    resolved = path.resolve()
    return any(
        resolved != expand(root).resolve() and expand(root).resolve() in resolved.parents
        for root in roots
    )


def remove_tree(path):
    result = subprocess.run(["rm", "-rf", "--", str(path)], capture_output=True, text=True, check=False)
    return result.returncode == 0 and not path.exists(), result.stderr.strip()


def process_running(names):
    for name in names:
        if subprocess.run(["pgrep", "-x", name], capture_output=True, check=False).returncode == 0:
            return name
        # Node-based package managers run as `node .../bin/<name>.js` or `.../bin/<name>`.
        pattern = f"/{name}(\\.c?js)? "
        if subprocess.run(["pgrep", "-f", pattern], capture_output=True, check=False).returncode == 0:
            return name
    return None


class Cleaner:
    def __init__(self, target, volume, dry_run, excludes):
        self.target, self.volume, self.dry_run, self.excludes = target, volume, dry_run, excludes
        self.initial = free_bytes(volume)
        self.simulated = 0
        self.actions, self.skipped, self.errors = [], [], []

    def free(self):
        return free_bytes(self.volume) + self.simulated

    def met(self):
        return self.free() >= self.target

    def record(self, tier, name, before, status, detail=None):
        freed = self.free() - before if not self.dry_run else None
        action = {"tier": tier, "target": name, "status": status}
        if freed is not None:
            action["freedBytes"] = max(freed, 0)
        if detail:
            action.update(detail)
        self.actions.append(action)

    def artifacts(self, tier, roots, idle_hours, cwds, now):
        candidates, skipped = collect(roots, idle_hours, cwds.get(), self.excludes, now)
        self.skipped.extend({**item, "tier": tier} for item in skipped)
        if self.dry_run:
            measure(candidates)
        for item in candidates:
            if self.met():
                break
            path = Path(item["path"])
            if self.dry_run:
                self.simulated += item["bytes"]
                self.record(tier, item["path"], 0, "would-remove", {
                    "kind": item["kind"], "idleHours": item["idleHours"], "bytes": item["bytes"]})
                continue
            before = self.free()
            # Activity can change between the scan and deletion.
            root = Path(item["root"])
            current = (time.time() - last_activity(path, item["kind"], root)) / HOUR
            if current < idle_hours or busy_reason(path, cwds.get(), self.excludes, root):
                self.skipped.append({**item, "tier": tier, "reason": "became active"})
                continue
            if not safe_to_delete(path, item["kind"], roots):
                self.skipped.append({**item, "tier": tier, "reason": "failed safety re-check"})
                continue
            ok, error = remove_tree(path)
            self.record(tier, item["path"], before, "removed" if ok else "failed",
                        {"kind": item["kind"], "idleHours": item["idleHours"]})
            if not ok:
                self.errors.append({"target": item["path"], "error": error or "rm failed"})

    def tool_caches(self):
        tier = "tool-caches"
        for name, executable, command, processes in TOOL_CACHES:
            if self.met():
                return
            if not shutil.which(executable):
                continue
            if executable == "docker" and subprocess.run(
                ["docker", "info"], capture_output=True, check=False
            ).returncode:
                continue
            running = process_running(processes)
            if running:
                self.skipped.append({"tier": tier, "path": name, "reason": f"{running} is running"})
                continue
            if self.dry_run:
                self.record(tier, name, 0, "would-run", {"command": command})
                continue
            before = self.free()
            try:
                result = subprocess.run(
                    command, capture_output=True, text=True, check=False,
                    timeout=1800, cwd=os.path.expanduser("~"),
                )
                ok, error = result.returncode == 0, result.stderr.strip()[-500:]
            except subprocess.TimeoutExpired:
                ok, error = False, "timed out"
            self.record(tier, name, before, "ran" if ok else "failed", {"command": command})
            if not ok:
                self.errors.append({"target": name, "error": error})
        self.derived_data(tier)

    def derived_data(self, tier):
        root = expand(DERIVED_DATA)
        if self.met() or not root.is_dir():
            return
        if process_running(["Xcode", "xcodebuild"]):
            self.skipped.append({"tier": tier, "path": str(root), "reason": "Xcode is running"})
            return
        for child in sorted(root.iterdir()):
            if child.is_symlink() or not child.is_dir():
                continue
            if self.dry_run:
                size = du_bytes(str(child))
                self.simulated += size
                self.record(tier, str(child), 0, "would-remove", {"kind": "xcode-derived-data", "bytes": size})
                continue
            before = self.free()
            ok, error = remove_tree(child)
            self.record(tier, str(child), before, "removed" if ok else "failed", {"kind": "xcode-derived-data"})
            if not ok:
                self.errors.append({"target": str(child), "error": error or "rm failed"})

    def report(self, skipped_limit):
        final = self.free()
        reasons = {}
        for item in self.skipped:
            key = item["reason"].split(" ", 1)[0]
            reasons[key] = reasons.get(key, 0) + 1
        return {
            "dryRun": self.dry_run,
            "volume": str(self.volume),
            "targetBytes": self.target,
            "initialFreeBytes": self.initial,
            "finalFreeBytes": final,
            "freedBytes": final - self.initial,
            "met": final >= self.target,
            "actions": self.actions,
            "skippedCount": len(self.skipped),
            "skippedByReason": reasons,
            "skipped": self.skipped[:skipped_limit],
            "errors": self.errors,
        }


def gb(value):
    return f"{value / GB:.1f} GB"


def summary(report, top=10):
    lines = [
        f"{'Dry run: ' if report['dryRun'] else ''}free {gb(report['initialFreeBytes'])} -> "
        f"{gb(report['finalFreeBytes'])} (target {gb(report['targetBytes'])}, "
        f"{'met' if report['met'] else 'NOT met'})",
    ]
    tiers = {}
    for action in report["actions"]:
        size = action.get("freedBytes", action.get("bytes")) or 0
        count, total = tiers.get((action["tier"], action["status"]), (0, 0))
        tiers[(action["tier"], action["status"])] = (count + 1, total + size)
    for (tier, status), (count, total) in tiers.items():
        lines.append(f"  [{tier}] {status} {count} ({gb(total)})")
    largest = sorted(report["actions"], key=lambda a: -(a.get("freedBytes", a.get("bytes")) or 0))
    for action in largest[:top]:
        size = action.get("freedBytes", action.get("bytes")) or 0
        lines.append(f"    {gb(size)}  {action['target']}")
    if report["skippedCount"]:
        lines.append(f"  skipped {report['skippedCount']}: {report['skippedByReason']}")
    for error in report["errors"]:
        lines.append(f"  error: {error['target']}: {error['error']}")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "run"])
    parser.add_argument("--target-gb", type=float, default=400, help="required free space in decimal GB")
    parser.add_argument("--volume", default=os.path.expanduser("~"), help="path on the volume to measure")
    parser.add_argument("--dry-run", action="store_true", help="measure candidates without deleting")
    parser.add_argument("--exclude", action="append", default=[], help="never touch this path")
    parser.add_argument("--agent-idle-hours", type=float, default=AGENT_IDLE_HOURS)
    parser.add_argument("--project-idle-hours", type=float, default=PROJECT_IDLE_HOURS)
    parser.add_argument("--skipped-limit", type=int, default=50)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    target = int(args.target_gb * GB)
    if args.command == "status":
        free = free_bytes(args.volume)
        status = {"volume": args.volume, "targetBytes": target, "freeBytes": free, "met": free >= target}
        print(json.dumps(status) if args.json else
              f"free {gb(free)} (target {gb(target)}, {'met' if status['met'] else 'NOT met'})")
        return 0

    excludes = [expand(path).resolve() for path in args.exclude] + [Path.cwd().resolve()]
    cleaner = Cleaner(target, args.volume, args.dry_run, excludes)
    if not cleaner.met():
        now, cwds = time.time(), FreshCwds()
        cleaner.artifacts("agent-artifacts", AGENT_ROOTS, args.agent_idle_hours, cwds, now)
        if not cleaner.met():
            cleaner.tool_caches()
        if not cleaner.met():
            cleaner.artifacts("project-artifacts", PROJECT_ROOTS, args.project_idle_hours, cwds, now)
    report = cleaner.report(args.skipped_limit)
    print(json.dumps(report, indent=2) if args.json else summary(report))
    return 0 if report["met"] else 2


if __name__ == "__main__":
    sys.exit(main())
