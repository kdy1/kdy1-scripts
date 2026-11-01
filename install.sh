#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

for command in git npx; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$command" >&2
        exit 1
    fi
done

# Keep local changes and commits intact; stop if main cannot be fast-forwarded.
if [[ -n $(git -C "$repo_dir" status --porcelain) ]]; then
    printf 'Commit or stash checkout changes before running install.sh.\n' >&2
    exit 1
fi
git -C "$repo_dir" fetch origin main
git -C "$repo_dir" merge --ff-only origin/main

link_skill() {
    local source=$1 destination=$2
    if [[ -L "$destination" && $(readlink "$destination") == "$source" ]]; then
        return
    fi
    if [[ -e "$destination" || -L "$destination" ]]; then
        rm -rf -- "$destination"
    fi
    ln -s -- "$source" "$destination"
}

for destination in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    mkdir -p -- "$destination"
    for skill in "$repo_dir"/skills/*; do
        [[ -f "$skill/SKILL.md" ]] || continue
        link_skill "$skill" "$destination/${skill##*/}"
    done
done

# The CLI stores global skills in ~/.agents/skills and links Claude Code to them.
for source in \
    https://github.com/github/gh-stack/tree/main/skills/gh-stack \
    https://github.com/CodSpeedHQ/codspeed/tree/main/skills/codspeed-optimize; do
    npx --yes skills add "$source" --global --agent codex claude-code --yes
done

printf 'Skills installed in ~/.agents/skills and ~/.claude/skills.\n'
