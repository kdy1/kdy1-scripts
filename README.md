# kdy1-scripts

A collection of standalone [Codex skills](https://learn.chatgpt.com/docs/build-skills) for GitHub, product planning, writing, and UI-design workflows. Each directory under [`skills/`](./skills) is a complete skill: its `SKILL.md` contains the workflow instructions and it may include scripts, references, or UI metadata.

## Included skills

| Skill | Purpose |
| --- | --- |
| `add-issue` | Investigate confirmed work and create evidence-backed GitHub issues. |
| `bulk` | Explicitly apply one common prompt to a text list of items through per-item worktree chats, collecting results and automatically archiving chats that no longer need attention. |
| `bulk-watch` | Explicitly watch a source and apply one common prompt to existing and new items through per-item worktree chats, with five-minute heartbeats and automatic archiving of chats that no longer need attention. |
| `create-human-reviewed-pr` | Explicitly publish human-reviewed changes as a non-draft PR with AI-use disclosure, a reviewer mention, and known harness, model, and reasoning-effort details. |
| `create-pr` | Publish changes through a shared PR workflow with verified Closes references for resolved issues and Refs for partial or related work. |
| `list-good-prs` | List clean or unstable pull requests that were approved by the Codex connector. |
| `main-qa` | Explicitly run parallel functional and usability QA with GPT-5.6 Luna `xhigh` subagents and report discovered problems through `$add-issue`. |
| `redesign-ui` | Automatically plan and visualize UI changes, then implement the approved design in the same chat. |
| `repair-pr` | Repair merge conflicts, actionable bot feedback, and failing CI on a pull request. |
| `review-full` | Run a sustained three-reviewer pull-request review and publish one consolidated review. |
| `slop-fix-issue` | Generate AI slop for one GitHub issue: close it with supporting evidence if already resolved; otherwise implement and verify it, open and attach a non-draft PR with a Closes reference, and stop. |
| `slop-fix-repo-issues` | Explicitly collect open issues matching required user-specified conditions in the current repository once, then use `$bulk` to delegate each issue to `$slop-fix-issue` through PR creation. |
| `slop-maintain-repo-prs` | Periodically scan all my open repo PRs, dispatch needed one-shot `$repair-pr` runs in GPT-5.6 Luna worktree chats with `xhigh` reasoning effort, and archive successfully completed repair chats. |
| `write-blog-post` | Develop a blog-post draft from material supplied by the user. |
| `write-marketing-copy` | Rephrase source material into LinkedIn, X, and Threads posts. |
| `write-prd` | Capture product decisions and create an implementation-ready GitHub issue. |
| `write-ste` | Automatically apply practical ASD-STE100 clarity principles to technical text while preserving its language and meaning. |

## Install for Codex

Codex discovers a skill when a scanned directory contains its `SKILL.md`. It scans repository skills in `.agents/skills` from the current working directory to the repository root, and user-wide skills in `~/.agents/skills`. Symlinked skill directories are supported. See the official [local skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) reference for the complete precedence rules.

After installing or updating a skill, Codex normally detects it automatically. Restart Codex if it does not appear.

### Quickest option: `npx skills`

The [`skills` CLI](https://www.skills.sh/docs/cli) recognizes the skills in this repository. Run it from the repository where you want project-scoped skills installed:

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

When installing selected skills, include their skill dependencies. `create-pr` requires `write-ste`. `create-human-reviewed-pr` and `slop-fix-issue` require both `create-pr` and its `write-ste` dependency. `slop-fix-repo-issues` requires `bulk`, `slop-fix-issue`, `create-pr`, and `write-ste`. Installing every skill includes these dependencies. The same rule applies when copying individual skill directories manually.

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

`create-pr` applies automatically when an authorized task includes PR creation, and can also be invoked as `$create-pr`. Other skills must invoke it for their PR publishing step. `slop-fix-issue` passes its resolved issue and validation results; `create-human-reviewed-pr` passes its human-review disclosure and source-preservation constraint. The shared skill owns publishing, reuse, verification, and attachment. PR titles and bodies follow an explicit user language request first, then an explicit repository language requirement, and otherwise default to English. Conversation language and existing PR language do not change that default. Required fixed template text and unrelated existing PR content are preserved. It explicitly invokes `write-ste` with the selected language while preserving templates, disclosures, issue references, and validation status. It writes and verifies Conventional Commits PR titles that summarize the full change set, with optional scope and a `!` marker for breaking changes, and verifies the selected language for new or revised title and body prose. It requires standalone `Closes` lines in the PR body for fully resolved issues and `Refs` lines for partial or related work.

`redesign-ui` is selected automatically whenever a task requires UI changes, including layout, styling, components, content, interaction, navigation, or responsive behavior. It runs the proposal phase in Plan Mode; if needed, it asks for a mode switch and resumes without an explicit `$redesign-ui` invocation. After the preview and text specification are approved and Plan Mode is no longer active, it implements and verifies the design in the same chat when implementation is within the original task. No new skill invocation or issue handoff is required. Proposal-only requests end with the approved plan. Approved previews remain in the image-generation default storage as implementation references, with their paths, descriptions, and final prompts retained in the conversation.

`write-ste` allows automatic selection when drafting or revising PRs, issues, reviews, technical documentation, and code explanations, including technical chat replies. It applies practical ASD-STE100 clarity principles while preserving the text's language, meaning, templates, and technical literals. For Korean and other languages, it uses natural local grammar. Ordinary conversation and marketing copy are excluded. It does not check the official approved vocabulary or certify full standard compliance. Automatic selection does not guarantee invocation for every eligible task; invoke `$write-ste` explicitly when needed.

When using `$add-issue` in Plan Mode, finish investigation and finalize the exact issue title, complete body or duplicate comment, metadata, attachments, and recording action in the final plan. After approval and leaving Plan Mode, it resumes directly at recording with that payload; it does not repeat investigation, classification, reproduction, or drafting. It performs only bounded pre-write checks and verifies the result. A new matching duplicate or changed required condition stops that candidate and is reported without automatically changing the target or content. A missing finalized payload is reported rather than reconstructed. Draft-only restrictions continue after a mode change, and the issue's proposed work is never implemented in the same invocation. A fresh invocation outside Plan Mode retains the full investigation workflow.

To run MainQA against an existing app server, explicitly invoke:

```text
$main-qa
URL: http://localhost:3000
```

If the development server needs to be started, supply its startup method and directory instead:

```text
$main-qa
Start: pnpm dev
Directory: /path/to/app
```

Without a checklist, MainQA discovers and tests the whole app; it does not ask for a checklist. Supply a checklist to restrict the run to only those items. Independent screens and workflows are divided among GPT-5.6 Luna subagents with `xhigh` reasoning. Up to ten subagents may run simultaneously across QA and nested issue investigation/recording, further limited by actual runtime capacity. Install `add-issue` alongside `main-qa`: reporting subagents explicitly invoke it for in-scope candidates after central reconciliation. It applies its classification-specific evidence requirements, including confirmed root causes at the identified commit for bugs, before recording; a browser observation does not automatically become an issue. Local investigation defaults to the current HEAD unless another revision is specified, including a non-default branch or detached HEAD, without fetching or comparing the default branch. Reported runtime behavior still requires identifying its actual revision.

Coverage includes usability problems even when actions succeed: ambiguous controls or instructions, hard-to-find existing actions, unclear results, missing next steps or recovery guidance, and inconsistent interactions that make an existing flow hard to use. Usability candidates require a reproducible obstacle, exact screen/state and viewport, sanitized screenshot, and concrete user impact. Cosmetic polish without usability impact, new features, and broad redesigns are excluded. `$add-issue` distinguishes existing behavior defects (`Bug`) from bounded UI clarification or cleanup that preserves product behavior (`Task`); an unresolved bug cannot be relabeled as a task to bypass investigation.

MainQA honors a user-specified browser or tab. Otherwise it prefers Chrome and falls back to the in-app Browser only when Chrome cannot be controlled with the available tools, recording the reason. This policy also applies to QA workers and browser reproduction during issue investigation.

Request draft-only reporting to receive the issue handoff payloads in chat without writing to GitHub.

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

To periodically scan all your open PRs in the current repository and repair those that need attention, invoke:

```text
$slop-maintain-repo-prs
```

It uses `repo:<owner/repo> is:pr is:open author:@me` on the resolved GitHub host, including draft PRs, and records the authenticated author for subsequent scans. One heartbeat scans every matching PR on every pass, including previously repaired PRs. The interval is configurable: a new watch defaults to five minutes, while resuming preserves its existing cadence. Concurrency defaults to three preparing/running repairs and can be configured within app limits.

Confirmed merge conflicts, current-head CI failures, or unresolved, non-outdated Codex bot review threads trigger a one-shot `$repair-pr` invocation in a dedicated GPT-5.6 Luna worktree chat with `xhigh` reasoning effort. Healthy PRs, pending checks, and missing approvals alone do not create repair chats. The coordinator prevents overlapping repairs and unchanged failed or blocked retries, but can dispatch a new attempt when relevant new evidence appears, including a new review on the same head. After capturing a successful repair's results, it archives the repair chat without waiting for the PR to merge or follow-up CI to finish. Failed, uncertain, and input-waiting chats remain open; the coordinator and Git worktrees remain available.

`repair-pr` and `slop-maintain-repo-prs` report routine repair progress and results in Codex chats without posting PR comments or reviews by default. Other comments require an explicit human request, preserved with its scope through heartbeats and repair chats. Objectively incorrect bot findings are the exception: a concise English explanation with concrete evidence may be posted in the original inline thread. After a successful final push, or when no push is needed, those threads must be resolved even if the optional reply is omitted or fails. Uncertain findings remain unresolved, and reply or resolution failures are reported in chat. This policy applies to PR repairs; `review-full` publication and issue-comment workflows retain their own policies.

To handle a batch of currently open issues in the repository once, invoke with explicit selection conditions in natural language or as a GitHub search expression:

```text
$slop-fix-repo-issues
Conditions: label:bug
```

It combines `repo:<owner/repo> is:issue is:open` with the user's conditions on the resolved GitHub host. For example, “issues labeled bug” is equivalent to `label:bug`; an author filter applies only when requested. A bare invocation asks for conditions before searching, and an explicit request for “all open issues” is valid. Ambiguous conditions or conditions conflicting with the base scope require clarification. It fetches all search pages and checks completeness before fixing the issue URL list; an incomplete or capped search is reported without dispatch, and an empty result ends the run. The original conditions, exact resolved query, fixed list, and authorization context are retained in the batch ledger and item chats. Each item chat explicitly invokes `$slop-fix-issue` with its assigned issue's exact URL. Concurrency and an explicitly requested starting Git state apply to `$bulk`. The batch collects closure or PR-creation results and ends without adding new issues, registering a heartbeat, or starting PR maintenance.

## Notes

- `main-qa` starts only on a human's direct `$main-qa` invocation or explicit request to run MainQA. Generic QA requests, URLs alone, and skill editing do not start a run. It requires browser tools, subagent controls, and `gpt-5.6-luna` with `xhigh`; unavailable settings are reported without substitution. Missing server details are requested when needed. A human MainQA invocation authorizes only its scoped `$add-issue` handoffs, which retain the original request and delegation context; other skill handoffs do not gain this exception. All investigation and recording descendants share the concurrency limit and Luna settings. In Plan Mode it prepares a plan only. It reports blocked or incomplete coverage honestly, cleans up only its own server/test resources, and never fixes code, deploys, or starts a monitor.
- `bulk` starts on the human's explicit invocation with a finite item list and a common prompt, or an authorized handoff from another explicitly invoked skill within the original request's scope. Handoffs retain the original human invocation, delegation chain, fixed list, common prompt, and authorized scope through the ledger and item chats. It requires a Git project and the Codex app's chat tools, creates one worktree chat per item in the current project from its default branch unless the user requests another starting Git state, and tracks progress through completion in the coordinating chat. Independent items continue when one fails or needs input; follow-up messages require the user's authorization for that chat.
- `bulk-watch` starts on a human's explicit invocation with source instructions and a common prompt, or an authorized handoff from another explicitly invoked skill within the original request's source and task. Handoffs retain the original human invocation, delegation chain, and authorized scope through scheduling and item chats. GitHub sources may target issues or PRs. It is self-contained and does not require installing `bulk`. It requires read-only source access, stable item identities, a Git project, the Codex app's chat tools, and its heartbeat automation tool. One heartbeat in the coordinating chat defaults to five minutes; users can specify another supported interval. It keeps watching after an empty read or completion of all known items, and retains its ledger in that chat to avoid reassigning recorded items. Local scheduled work requires the computer and app to remain running. A user stop ends further dispatch; existing item chats retain their actual state. Follow-up messages require authorization for the affected chat.
- Both `bulk` and `bulk-watch` automatically archive their item chats after collecting verified results when no continuing work or unresolved human action needs that chat. They retain chats with failures, pending input, uncaptured review context, or active maintenance heartbeats, and honor user requests to keep chats open. Archived items remain in the coordinator's ledger and results and are never reassigned merely because their chat was archived. Coordinating chats, worktrees, branches, commits, and PRs remain available; chat archiving does not clean up Git state.
- `create-pr` is the shared publishing dependency for PR-creating skills. Install `write-ste` alongside it for required PR title and body drafting. Automatic selection requires an already authorized PR-creation task; ordinary code changes or skill editing do not start publication. It defaults to non-draft, honors requested draft state, and verifies `Closes` for fully resolved issues and `Refs` for partial or related work. Existing references are preserved in later body edits, and changes without an associated issue get no invented reference. It publishes only intended changes and stops on blocking checks without rewriting source. Existing matching PRs are reused and uncertain writes are reconciled before retries.
- `create-human-reviewed-pr` starts only when the human directly invokes `$create-human-reviewed-pr`; invoking it declares that the current changes have been human-reviewed. It resolves the reviewer from an explicit username or the target GitHub host's authenticated account and includes execution details only when known. Install `create-pr` alongside it; it prepares the disclosure, then invokes `create-pr` for verified non-draft publication while preserving reviewed source. Missing publication dependencies are reported without a direct-publishing fallback.
- `slop-fix-issue` starts on a human's explicit invocation or an authorized issue handoff from another explicitly invoked skill, including item chats created for `slop-fix-repo-issues`. Handoffs carry the original human invocation, delegation chain, authorized scope, and exact issue URL through closure or PR creation. It generates AI slop to implement one issue while retaining required verification. It closes already-resolved issues as completed after posting and confirming an evidence comment, then stops without selecting another issue or creating a PR or automation. Otherwise it invokes `create-pr` to publish, verify, and attach a non-draft PR with a Closes reference and stops. Install `create-pr` alongside it; unavailable publication dependencies block implementation of unresolved issues, but are not needed for evidence-backed closure. It uses authenticated `gh` and the desktop app's PR attachment tool; PR-maintenance skills and heartbeat tools are not dependencies. Existing PRs are reconciled and reported without replacement or maintenance, and no CI, review, or merge loop follows PR creation.
- `slop-fix-repo-issues` starts only when the human explicitly invokes it and supplies issue-selection conditions. Install `bulk`, `slop-fix-issue`, `create-pr`, and `write-ste` alongside it. It collects matching issues once, deduplicates by host/repository/issue number, and delegates the fixed URL list to `bulk`; each implementing worker reaches `create-pr` through `slop-fix-issue`. It resumes only unfinished items from that run's recorded list and ledger; new issues require a new human-authorized run. Result collection and automatic item-chat archiving follow `bulk`, with closure or verified PR creation as the completion condition.
- `slop-maintain-repo-prs` starts only when the human explicitly invokes it to maintain their PRs. Install `repair-pr` alongside it; it manages its own scanning, heartbeat, and repair chats without requiring `bulk` or `bulk-watch`. It requires authenticated `gh` access, the current Git project, and the Codex app's scheduling and chat tools. Repair chats use `model: "gpt-5.6-luna"` and `thinking: "xhigh"` with no model or reasoning-effort fallback and never register their own automations. Full inventories and relevant review/check data must be verified before dispatch; incomplete reads are reported rather than treated as healthy state. The watch continues when no PR needs repair and stops new assignments when the user stops it; already-running repairs retain their actual state. It never merges or enables auto-merge. Local scheduled work requires the computer and app to remain running. Editing the skill does not start a watch, migrate existing automations, or archive existing chats.
- Do not place the repository itself directly inside `~/.agents/skills`: Codex expects each immediate child there to be a skill directory containing `SKILL.md`. Clone the repository elsewhere and link or copy its individual directories from `skills/`.
- Avoid installing two different directories with the same skill `name`. Codex does not merge duplicate skill names; both may appear in the selector.
- Review a skill's `SKILL.md` and any included scripts before installing it, especially when it can run commands or access external services.
