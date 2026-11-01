#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

for command in git npx; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$command" >&2
        exit 1
    fi
done

git -C "$repo_dir" fetch origin main
git -C "$repo_dir" merge --ff-only origin/main

mkdir -p -- "$HOME/.agents" "$HOME/.claude"
ln -sfnT -- "$repo_dir/skills" "$HOME/.agents/skills"
ln -sfnT -- "$repo_dir/skills" "$HOME/.claude/skills"

# Both agents share the directory, so install external skills only once.
for source in \
    https://github.com/github/gh-stack/tree/main/skills/gh-stack \
    https://github.com/CodSpeedHQ/codspeed/tree/main/skills/codspeed-optimize; do
    npx --yes skills add "$source" --global --agent codex --yes
done

printf 'Skills installed in ~/.agents/skills and ~/.claude/skills.\n'
