# kdy1-scripts

A collection of standalone [Codex skills](https://learn.chatgpt.com/docs/build-skills) for GitHub, product planning, writing, and UI-design workflows. Each directory under [`skills/`](./skills) is a complete skill: its `SKILL.md` contains the workflow instructions and it may include scripts, references, or UI metadata.

## Included skills

| Skill | Purpose |
| --- | --- |
| `add-issue` | Investigate confirmed work and create evidence-backed GitHub issues. |
| `bulk` | Explicitly apply one common prompt to a text list of items through per-item worktree chats in the current project, coordinating parallel execution and results in the current chat. |
| `bulk-watch` | Explicitly watch a user-specified source and apply one common prompt to existing and newly discovered items through per-item worktree chats, defaulting to five-minute heartbeats. |
| `create-human-reviewed-pr` | Explicitly publish human-reviewed changes as a non-draft PR with AI-use disclosure, a reviewer mention, and known harness, model, and reasoning-effort details. |
| `list-good-prs` | List clean or unstable pull requests that were approved by the Codex connector. |
| `redesign-ui` | Plan and visualize a UI redesign before creating an issue. |
| `repair-pr` | Repair merge conflicts, actionable bot feedback, and failing CI on a pull request. |
| `review-full` | Run a sustained three-reviewer pull-request review and publish one consolidated review. |
| `slop-fix-issue` | Generate AI slop for one GitHub issue: close it with supporting evidence if already resolved; otherwise implement and verify it, open a non-draft PR with a Closes reference, and delegate maintenance to `$slop-maintain-pr`. |
| `slop-fix-repo-issues` | Explicitly watch my open issues in the current repository with `$bulk-watch` and delegate each issue to `$slop-fix-issue`. |
| `slop-maintain-pr` | Maintain one PR through explicit scheduled `$repair-pr` invocations at a configurable interval, defaulting to five minutes, until merged, closed, or stopped. |
| `slop-maintain-repo-prs` | Explicitly watch my open PRs in the current repository with `$bulk-watch` and delegate each PR to `$slop-maintain-pr`. |
| `write-blog-post` | Develop a blog-post draft from material supplied by the user. |
| `write-marketing-copy` | Rephrase source material into LinkedIn, X, and Threads posts. |
| `write-prd` | Capture product decisions and create an implementation-ready GitHub issue. |

## Install for Codex

Codex discovers a skill when a scanned directory contains its `SKILL.md`. It scans repository skills in `.agents/skills` from the current working directory to the repository root, and user-wide skills in `~/.agents/skills`. Symlinked skill directories are supported. See the official [local skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) reference for the complete precedence rules.

After installing or updating a skill, Codex normally detects it automatically. Restart Codex if it does not appear.

### Quickest option: `npx skills`

The [`skills` CLI](https://www.skills.sh/docs/cli) recognizes this repository and its fifteen skills. Run it from the repository where you want project-scoped skills installed:

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

For example, invoke `bulk-watch` with source instructions and a common prompt:

```text
$bulk-watch

Source:
Search GitHub issues in kdy1/kdy1-scripts matching
repo:kdy1/kdy1-scripts is:issue is:open label:ready.

Common prompt:
Investigate the assigned issue and report a concrete implementation plan.

Interval: 5 minutes
Concurrency: 3
```

The source can be any available read-only lookup with stable item identities. The interval and concurrency limit are optional. The first read includes existing items; later reads add only previously unrecorded identities. Tell the coordinating chat to stop when you want to end discovery.

To watch your open PRs in the current repository and start maintenance for each, invoke:

```text
$slop-maintain-repo-prs
```

It uses `repo:<owner/repo> is:pr is:open author:@me` on the resolved GitHub host, including draft PRs. An optional interval applies to both discovery and PR maintenance; concurrency applies to the watch. Without an interval, each skill preserves an existing cadence or defaults to five minutes.

To watch your open issues in the current repository and handle each, invoke:

```text
$slop-fix-repo-issues
```

It uses `repo:<owner/repo> is:issue is:open author:@me` on the resolved GitHub host. Each item chat explicitly invokes `$slop-fix-issue` with its assigned issue's exact URL. An optional interval applies to both discovery and resulting PR maintenance; concurrency and an explicitly requested starting Git state apply to the watch. Without an interval, each scheduling skill preserves an existing cadence or defaults to five minutes.

## Notes

- `bulk` starts only when the user explicitly invokes `$bulk` with an item list and a common prompt. It requires a Git project and the Codex app's chat tools, creates one worktree chat per item in the current project from its default branch unless the user requests another starting Git state, and tracks progress through completion in the coordinating chat. Independent items continue when one fails or needs input; follow-up messages require the user's authorization for that chat.
- `bulk-watch` starts on a human's explicit invocation with source instructions and a common prompt, or an authorized handoff from another explicitly invoked skill within the original request's source and task. Handoffs retain the original human invocation, delegation chain, and authorized scope through scheduling and item chats. GitHub sources may target issues or PRs. It is self-contained and does not require installing `bulk`. It requires read-only source access, stable item identities, a Git project, the Codex app's chat tools, and its heartbeat automation tool. One heartbeat in the coordinating chat defaults to five minutes; users can specify another supported interval. It keeps watching after an empty read or completion of all known items, and retains its ledger in that chat to avoid reassigning recorded items. Local scheduled work requires the computer and app to remain running. A user stop ends further dispatch; existing item chats retain their actual state. Follow-up messages require authorization for the affected chat.
- `create-human-reviewed-pr` starts only when the human directly invokes `$create-human-reviewed-pr`; invoking it declares that the current changes have been human-reviewed. It resolves the reviewer from an explicit username or the target GitHub host's authenticated account and includes execution details only when known.
- `slop-fix-issue` starts on a human's explicit invocation or an authorized issue handoff from another explicitly invoked skill, including item chats created for `slop-fix-repo-issues`. Handoffs carry the original human invocation, delegation chain, authorized scope, and exact issue URL through PR maintenance. It generates AI slop to implement one issue while retaining required verification. It closes already-resolved issues as completed after posting and confirming an evidence comment, then stops without selecting another issue or creating a PR or automation. Its implementation path requires `slop-maintain-pr`, `repair-pr`, and the desktop app's heartbeat automation tools; these dependencies are not required for evidence-backed issue closure. After verifying and attaching its non-draft PR, it delegates maintenance to `slop-maintain-pr`, forwarding any user-specified interval.
- `slop-fix-repo-issues` starts only when the human explicitly invokes it. Install `bulk-watch`, `slop-fix-issue`, `slop-maintain-pr`, and `repair-pr` alongside it for the full workflow. It delegates discovery and per-issue handling instead of implementing their procedures again. The first successful read includes existing matching issues; later reads admit newly discovered identities. Stopping the coordinating watch stops discovery and new assignments; assigned issue work and PR maintenance retain their own state and termination rules.
- `slop-maintain-pr` starts on a human's explicit invocation or an authorized maintenance handoff from another explicitly invoked skill, including `slop-fix-issue` and item chats created for `slop-maintain-repo-prs`. Handoffs carry the original human invocation, delegation chain, authorized scope, and exact PR URL. Previously authorized maintenance and handoffs remain valid for their recorded PR after skill renames. Install `repair-pr` alongside it. It uses one heartbeat in the current chat, defaults to five minutes for new maintenance, and preserves an existing cadence when resuming unless the user changes it. Every eligible pass explicitly invokes `repair-pr` once, even when the PR appears healthy. It continues until merged, closed, or stopped; merging remains the user's responsibility.
- `slop-maintain-repo-prs` starts only when the human explicitly invokes it. Install `bulk-watch`, `slop-maintain-pr`, and `repair-pr` alongside it. It delegates discovery and per-PR maintenance instead of implementing their procedures again. Stopping the coordinating watch stops discovery and new assignments; existing PR maintenance follows its own termination rules.
- Do not place the repository itself directly inside `~/.agents/skills`: Codex expects each immediate child there to be a skill directory containing `SKILL.md`. Clone the repository elsewhere and link or copy its individual directories from `skills/`.
- Avoid installing two different directories with the same skill `name`. Codex does not merge duplicate skill names; both may appear in the selector.
- Review a skill's `SKILL.md` and any included scripts before installing it, especially when it can run commands or access external services.
