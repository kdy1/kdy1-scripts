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

instructions="$repo_dir/global/AGENTS.md"
# Codex reads ~/.codex/AGENTS.md and Claude Code reads ~/.claude/CLAUDE.md.
instruction_links=("$HOME/.codex/AGENTS.md" "$HOME/.claude/CLAUDE.md")

# Check every destination before changing any of them.
for destination in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    if [[ -d "$destination" && ! -L "$destination" ]]; then
        printf 'Cannot replace existing directory with a symlink: %s\n' "$destination" >&2
        exit 1
    fi
done
for destination in "${instruction_links[@]}"; do
    if [[ -e "$destination" && ! -L "$destination" ]] && ! cmp -s -- "$destination" "$instructions"; then
        printf 'Cannot replace a file with different content: %s\nMerge it into %s, then run ./install.sh again.\n' "$destination" "$instructions" >&2
        exit 1
    fi
done

mkdir -p -- "$HOME/.agents" "$HOME/.claude" "$HOME/.codex"
for destination in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    ln -sfn "$repo_dir/skills" "$destination"
done
for destination in "${instruction_links[@]}"; do
    # A real file reaches this point only when it matches the repository copy.
    if [[ ! -L "$destination" ]]; then
        rm -f -- "$destination"
    fi
    ln -sfn "$instructions" "$destination"
done

# Both agents share the directory, so install external skills only once.
for source in \
    https://github.com/github/gh-stack/tree/main/skills/gh-stack \
    https://github.com/CodSpeedHQ/codspeed/tree/main/skills/codspeed-optimize; do
    npx --yes skills add "$source" --global --agent codex --yes
done

printf 'Skills installed in ~/.agents/skills and ~/.claude/skills.\n'
printf 'User-wide instructions linked at ~/.codex/AGENTS.md and ~/.claude/CLAUDE.md.\n'
