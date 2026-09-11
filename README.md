# kdy1-scripts

A collection of standalone [Codex skills](https://learn.chatgpt.com/docs/build-skills) for GitHub, product planning, writing, and UI-design workflows. Each directory under [`skills/`](./skills) is a complete skill: its `SKILL.md` contains the workflow instructions and it may include scripts, references, or UI metadata.

## Included skills

| Skill | Purpose |
| --- | --- |
| `add-issue` | Investigate confirmed work and create evidence-backed GitHub issues. |
| `list-good-prs` | List clean or unstable pull requests that were approved by the Codex connector. |
| `redesign-ui` | Plan and visualize a UI redesign before creating an issue. |
| `repair-pr` | Repair merge conflicts, actionable bot feedback, and failing CI on a pull request. |
| `review-full` | Run repeated independent reviews and publish one consolidated pull-request review. |
| `write-blog-post` | Develop a blog-post draft from material supplied by the user. |
| `write-marketing-copy` | Rephrase source material into LinkedIn, X, and Threads posts. |
| `write-prd` | Capture product decisions and create an implementation-ready GitHub issue. |

## Install for Codex

Codex discovers a skill when a scanned directory contains its `SKILL.md`. It scans repository skills in `.agents/skills` from the current working directory to the repository root, and user-wide skills in `~/.agents/skills`. Symlinked skill directories are supported. See the official [local skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) reference for the complete precedence rules.

After installing or updating a skill, Codex normally detects it automatically. Restart Codex if it does not appear.

### Quickest option: `npx skills`

The [`skills` CLI](https://www.skills.sh/docs/cli) recognizes this repository and its eight skills. Run it from the repository where you want project-scoped skills installed:

```sh
# Install one skill for Codex in the current project.
npx skills add kdy1/kdy1-scripts --agent codex --skill write-prd

# Install every skill for Codex in the current project.
npx skills add kdy1/kdy1-scripts --agent codex --skill '*'
```

Add `--global` to install for the current user instead of the current project:

```sh
npx skills add kdy1/kdy1-scripts --agent codex --global --skill '*'
```

The CLI can list the available skills before installing anything:

```sh
npx skills add kdy1/kdy1-scripts --list --agent codex
```

It prompts for the installation method when necessary. Add `--copy` to use independent copies instead of symlinks.

### Manual option: Copy one skill into a repository

Use this option to share a selected, versioned skill with everyone working in one repository. Clone this repository, then copy the selected skill into the target project:

```sh
git clone https://github.com/kdy1/kdy1-scripts.git "$HOME/src/kdy1-scripts"
cd /path/to/target-repository
mkdir -p .agents/skills
cp -R "$HOME/src/kdy1-scripts/skills/write-prd" .agents/skills/
git add .agents/skills/write-prd
```

Replace `write-prd` with any directory listed in [`skills/`](./skills), then commit the copied directory in the target repository. This preserves the exact skill version used by the project; copy it again when you intentionally want to update it.

### Manual option: Install all skills for one user with symlinks

Use this option to make the skills available from every local repository while keeping them connected to this checkout. Pulling updates in the checkout updates the installed skills as well.

```sh
git clone https://github.com/kdy1/kdy1-scripts.git "$HOME/src/kdy1-scripts"
mkdir -p "$HOME/.agents/skills"
ln -s "$HOME/src/kdy1-scripts/skills"/* "$HOME/.agents/skills/"
```

To update the installed skills later:

```sh
git -C "$HOME/src/kdy1-scripts" pull --ff-only
```

### Manual option: Copy a skill instead of linking it

Copying is useful when symlinks are unavailable or when you need an independent, pinned version. This example installs `repair-pr` for the current user:

```sh
git clone https://github.com/kdy1/kdy1-scripts.git "$HOME/src/kdy1-scripts"
mkdir -p "$HOME/.agents/skills"
cp -R "$HOME/src/kdy1-scripts/skills/repair-pr" "$HOME/.agents/skills/repair-pr"
```

A copied skill is not updated by `git pull`; copy it again when you want a newer version. To scope a copied skill to one project instead, copy it to `.agents/skills/` in that project.

## Verify and invoke a skill

In Codex CLI or the IDE extension, use `/skills` to inspect discovered skills, then explicitly invoke one with `$`:

```text
$write-prd
```

The ChatGPT desktop app also shows standalone skills in its Skills sidebar. Several skills in this repository intentionally require explicit invocation, so invoking them by name is the reliable way to start their workflows.

## Notes

- Do not place the repository itself directly inside `~/.agents/skills`: Codex expects each immediate child there to be a skill directory containing `SKILL.md`. Clone the repository elsewhere and link or copy its individual directories from `skills/`.
- Avoid installing two different directories with the same skill `name`. Codex does not merge duplicate skill names; both may appear in the selector.
- Review a skill's `SKILL.md` and any included scripts before installing it, especially when it can run commands or access external services.
