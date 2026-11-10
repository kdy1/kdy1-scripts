#!/usr/bin/env python3
"""Partition an analysis scope into deterministic, balanced work units."""

import argparse
import json
import os
import sys
from pathlib import Path

SKIP_DIRS = {
    ".git", ".hg", ".svn", ".idea", ".vscode", ".venv", "venv", "env",
    "__pycache__", "node_modules", "vendor", "dist", "build", "target",
    "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", "Pods",
    "DerivedData", ".gradle", ".mypy_cache", ".pytest_cache", ".ruff_cache",
}
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
    "poetry.lock", "Pipfile.lock", "composer.lock", "go.sum", "Gemfile.lock",
}
SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".tar", ".tgz", ".bz2", ".xz", ".7z", ".woff", ".woff2", ".ttf", ".otf",
    ".eot", ".mp3", ".mp4", ".mov", ".avi", ".wav", ".so", ".dylib", ".dll",
    ".exe", ".bin", ".class", ".jar", ".pyc", ".o", ".a", ".wasm", ".map",
}
MAX_BYTES = 2 * 1024 * 1024


def count_lines(path):
    """Return the line count, or None for binary and oversized files."""
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8192]:
        return None
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def collect(root):
    """Return relative paths and line counts for analyzable files under root."""
    lines = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRS)
        for name in sorted(filenames):
            if name in SKIP_FILES or Path(name).suffix.lower() in SKIP_SUFFIXES:
                continue
            path = Path(dirpath) / name
            if not path.is_file():
                continue
            count = count_lines(path)
            if count is None:
                continue
            lines[path.relative_to(root)] = count
    return lines


def chunk(paths, lines, max_files, max_lines):
    """Split a flat file list into balanced chunks."""
    chunks = []
    current = []
    current_lines = 0
    for rel in sorted(paths):
        size = lines[rel]
        if current and (len(current) >= max_files or current_lines + size > max_lines):
            chunks.append(current)
            current = []
            current_lines = 0
        current.append(rel)
        current_lines += size
    if current:
        chunks.append(current)
    return chunks


def split_group(paths, depth, lines, max_files, max_lines):
    """Split one directory group until each part fits the limits."""
    total = sum(lines[rel] for rel in paths)
    if len(paths) <= max_files and total <= max_lines:
        return [sorted(paths)]
    subgroups = {}
    for rel in paths:
        key = rel.parts[depth] if len(rel.parts) > depth + 1 else "."
        subgroups.setdefault(key, []).append(rel)
    if len(subgroups) > 1:
        result = []
        for key in sorted(subgroups):
            result.extend(split_group(subgroups[key], depth + 1, lines, max_files, max_lines))
        return result
    return chunk(paths, lines, max_files, max_lines)


def merge_units(units, lines, max_units):
    """Merge the smallest units until the unit count fits the budget."""
    units = [list(unit) for unit in units]
    while len(units) > max_units:
        sizes = sorted((sum(lines[rel] for rel in unit), index)
                       for index, unit in enumerate(units))
        first, second = sizes[0][1], sizes[1][1]
        low, high = sorted((first, second))
        units[low] = sorted(units[low] + units[high])
        del units[high]
    return units


def label_for(paths):
    """Return the longest common directory prefix of the unit's paths."""
    directories = [rel.parts[:-1] for rel in paths]
    common = []
    for column in zip(*directories):
        if len(set(column)) == 1:
            common.append(column[0])
        else:
            break
    return "/".join(common) or "."


def plan(scope, max_units, max_files, max_lines):
    """Build the unit plan for a file or directory scope."""
    scope = Path(scope).resolve()
    if not scope.exists():
        raise ValueError(f"Scope does not exist: {scope}")
    root = scope if scope.is_dir() else scope.parent
    lines = collect(root) if scope.is_dir() else {}
    if not scope.is_dir():
        count = count_lines(scope)
        if count is None:
            raise ValueError(f"Scope is not analyzable text: {scope}")
        lines[Path(scope.name)] = count
    if not lines:
        raise ValueError(f"No analyzable files under: {scope}")

    groups = {}
    for rel in lines:
        key = rel.parts[0] if len(rel.parts) > 1 else "."
        groups.setdefault(key, []).append(rel)
    units = []
    for key in sorted(groups):
        units.extend(split_group(groups[key], 1, lines, max_files, max_lines))
    units = merge_units(units, lines, max_units)
    units.sort(key=lambda unit: (label_for(unit), unit[0]))

    return {
        "scope": str(scope),
        "root": str(root),
        "fileCount": len(lines),
        "lineCount": sum(lines.values()),
        "units": [
            {
                "id": f"unit-{index:02d}",
                "label": label_for(unit),
                "files": len(unit),
                "lines": sum(lines[rel] for rel in unit),
                "paths": [rel.as_posix() for rel in unit],
            }
            for index, unit in enumerate(units, start=1)
        ],
    }


def render_text(plan_data):
    """Render a compact human-readable plan."""
    out = [
        f"scope: {plan_data['scope']}",
        f"files: {plan_data['fileCount']}  lines: {plan_data['lineCount']}  "
        f"units: {len(plan_data['units'])}",
    ]
    for unit in plan_data["units"]:
        out.append(f"{unit['id']}  {unit['label']}  "
                   f"{unit['files']} files  {unit['lines']} lines")
        out.extend(f"  {path}" for path in unit["paths"])
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", type=Path, help="File or directory to analyze")
    parser.add_argument("--max-units", type=int, default=6,
                        help="Maximum number of units (default: 6)")
    parser.add_argument("--max-files", type=int, default=40,
                        help="Maximum files per unit before splitting (default: 40)")
    parser.add_argument("--max-lines", type=int, default=4000,
                        help="Maximum lines per unit before splitting (default: 4000)")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    args = parser.parse_args()
    for name in ("max_units", "max_files", "max_lines"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be at least 1")
    try:
        plan_data = plan(args.scope, args.max_units, args.max_files, args.max_lines)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Unit planning failed: {error}\n")
    if args.format == "text":
        print(render_text(plan_data))
    else:
        print(json.dumps(plan_data, indent=2))


if __name__ == "__main__":
    sys.exit(main())
