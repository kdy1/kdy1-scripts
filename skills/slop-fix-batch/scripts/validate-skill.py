#!/usr/bin/env python3
"""Validate batch skill metadata for Codex and Claude Code. Requires PyYAML."""
import argparse
from pathlib import Path
import re
import yaml


def validate(skill):
    skill = Path(skill)
    text = (skill / "SKILL.md").read_text()
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
    if not match:
        raise ValueError("Missing YAML frontmatter")
    metadata = yaml.safe_load(match[1])
    allowed = {"name", "description", "license", "allowed-tools", "metadata", "disable-model-invocation"}
    if not isinstance(metadata, dict) or set(metadata) - allowed:
        raise ValueError("Unsupported skill frontmatter")
    if metadata.get("name") != "slop-fix-batch":
        raise ValueError("Incorrect skill name")
    if not isinstance(metadata.get("description"), str) or not metadata["description"].strip():
        raise ValueError("Missing description")
    if metadata.get("disable-model-invocation") is not True:
        raise ValueError("Claude invocation must be explicit-only")
    agent = yaml.safe_load((skill / "agents/openai.yaml").read_text())
    if agent.get("policy", {}).get("allow_implicit_invocation") is not False:
        raise ValueError("Codex invocation must be explicit-only")
    for path in [skill / "SKILL.md", *sorted((skill / "references").glob("*.md"))]:
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", path.read_text()):
            if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
                continue
            target_path = target.split("#", 1)[0]
            if not (path.parent / target_path).exists():
                raise ValueError(f"Broken local reference in {path}: {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        validate(args.skill)
    except (OSError, ValueError, yaml.YAMLError) as error:
        parser.exit(1, f"{error}\n")
    print("Codex/Claude metadata and local references are valid")
