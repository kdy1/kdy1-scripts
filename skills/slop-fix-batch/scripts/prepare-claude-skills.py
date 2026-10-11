#!/usr/bin/env python3
"""Copy the complete Claude batch dependency set without replacing installed skills."""
import argparse
from pathlib import Path
import shutil

SKILLS = (
    "slop-fix-batch", "create-pr", "write-ste", "repair-pr",
    "manage-stacked-prs", "merge-pr",
)


def prepare(destination, source=None):
    source = Path(source) if source is not None else Path(__file__).resolve().parents[2]
    destination = Path(destination).resolve()
    # Check the entire set before copying anything, including dangling symlinks.
    for name in SKILLS:
        if not (source / name / "SKILL.md").is_file():
            raise ValueError(f"Missing dependency: {source / name / 'SKILL.md'}")
        target = destination / name
        if target.exists() or target.is_symlink():
            raise ValueError(f"Destination already exists: {target}")
        if target == (source / name).resolve() or (source / name).resolve() in target.parents:
            raise ValueError(f"Destination is inside source skill: {target}")
    destination.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in SKILLS:
        # copytree also rejects a target created after preflight. On I/O failure,
        # preserve partial output for inspection rather than deleting user data.
        shutil.copytree(source / name, destination / name,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        copied.append(str(destination / name))
    return copied


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="Target .claude/skills directory")
    args = parser.parse_args()
    try:
        for path in prepare(args.destination):
            print(path)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\nNo existing skill was replaced; inspect any partial copies before retrying.\n")
