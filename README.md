# kdy1-scripts

A collection of standalone [T3 Chat skills](./skills) for GitHub, product planning, writing, and UI-design workflows. Each directory under [`skills/`](./skills) is a complete skill: its `SKILL.md` contains the workflow instructions and it may include scripts, references, or UI metadata.

## Included skills

| Skill | Purpose |
| --- | --- |
| `add-issue` | Investigate locally by default, inspect logs, repair confirmed regenerable state, and create evidence-backed GitHub issues for confirmed work. |
| `collect-review` | Collect unresolved review-bot bug candidates from merged PRs, hand them to `add-issue`, resolve handled threads, and summarize verified issue links. |
| `create-human-reviewed-pr` | Explicitly publish human-reviewed changes as a non-draft PR with AI-use disclosure, a reviewer mention, and known harness, model, and reasoning-effort details. |
| `create-pr` | Publish changes through a shared PR workflow with verified Closes references for resolved issues and Refs for partial or related work. |
| `improve-skill-efficiency` | Use local T3 Chat session history and current API prices to make evidence-backed skill improvements while preserving quality and model settings. |
| `list-good-prs` | List clean or unstable pull requests that were approved by the review bot. |
| `main-qa` | Explicitly run parallel functional and usability QA with GPT-5.6 Luna `xhigh` subagents and report discovered problems through `$add-issue`. |
| `manage-stacked-prs` | Modify existing stacked PRs, fix necessary lower-layer causes, and restack and verify only affected upper layers. |
| `merge-pr` | Squash merge authorized GitHub PRs without overriding the commit subject, then verify the result. |
| `design-ui` | Design and preview new or changed UI, including plans, specifications, and issues; obtain approval and implement in the same conversation when authorized, without a mode switch. |
| `repair-pr` | Repair merge conflicts, actionable bot feedback, and failing CI on a pull request. |
| `review-full` | Run a sustained three-reviewer pull-request review and publish one consolidated review. |
| `slop-fix-batch` | Fix a fixed issue batch, publish dependency-based PR stacks, and directly maintain and conditionally merge verified stacks. |
| `slop-fix-issue` | Handle one GitHub issue: close it with evidence if already resolved; otherwise implement and verify it, publish a non-draft PR or a stack for a large issue, and stop. |
| `static-analysis` | Analyze all code in the requested scope and hand each confirmed bug to `add-issue` immediately. |
| `write-blog-post` | Develop a blog-post draft from material supplied by the user. |
| `write-comment` | Explicitly plan exact public comments in Plan Mode, default to English, and publish approved text unchanged after authorized execution. |
| `write-marketing-copy` | Rephrase source material into LinkedIn, X, and Threads posts. |
| `write-prd` | Capture product decisions and create an implementation-ready GitHub issue. |
| `write-ste` | Automatically apply practical ASD-STE100 clarity principles to technical text while preserving its language and meaning. |

## Install for T3 Chat

T3 Chat exposes the skills discovered by the selected provider. Install each skill as a directory containing `SKILL.md` in a location that provider scans. The examples below use `.agents/skills` for project skills and `~/.agents/skills` for user-wide skills; use `.claude/skills` or `~/.claude/skills` for Claude Code.

After installing or updating a skill, check that it appears in T3 Chat for the selected provider. Restart the session if it does not appear.

### Quickest option: `npx skills`

The [`skills` CLI](https://www.skills.sh/docs/cli) recognizes the skills in this repository. Run it from the repository where you want project-scoped skills installed:

```sh
# Install one skill for T3 Chat in the current project.
npx skills add kdy1/kdy1-scripts --skill write-prd

# Install every skill for T3 Chat in the current project.
npx skills add kdy1/kdy1-scripts --skill '*'
```

Add `--global` to install for the current user instead of the current project:

```sh
npx skills add kdy1/kdy1-scripts --global --skill '*'
```

The CLI can list the available skills before installing anything:

```sh
npx skills add kdy1/kdy1-scripts --list
```

Select the agent used by your T3 Chat session when prompted. It also prompts for the installation method when necessary. Add `--copy` to use independent copies instead of symlinks.

When installing selected skills, include their skill dependencies. `create-pr` requires `write-ste`. `write-comment` requires `write-ste` for technical comments. `create-human-reviewed-pr`, `slop-fix-issue`, and `slop-fix-batch` require both `create-pr` and its `write-ste` dependency. Installing every skill includes these dependencies. The same rule applies when copying individual skill directories manually.

`slop-fix-batch` directly manages its published PRs and requires `repair-pr`, `manage-stacked-prs`, and `merge-pr` for repairs, alignment, and conditional merging. `repair-pr` uses `manage-stacked-prs` for stacked repairs; stack-edit workflows use the shared coordination helper bundled with `repair-pr`. Include both skills when installing either for stack work.

`slop-fix-batch` also requires subagent controls, isolated Git worktrees, authenticated `gh` access, and the [`github/gh-stack` extension](https://github.com/github/gh-stack). Install the extension separately with `gh extension install github/gh-stack`; the skill checks installed command support and does not silently install or upgrade tools. It uses subagents in the current coordinator conversation and does not create scheduled jobs or repair sidebar chats. T3 Chat uses the role settings returned by `worker-settings.mjs`; Claude Code uses Sonnet with role-specific effort.

`manage-stacked-prs` uses authenticated `gh` access and prefers the same `github/gh-stack` extension for existing-stack inspection and scoped restacking. It checks installed command behavior and uses scoped Git replay when the extension cannot preserve the required range or commit boundaries. It does not silently install or upgrade tools.

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

## Use Slop Fix Batch in Claude Code

`slop-fix-batch` supports current Claude Code alongside T3 Chat. Use the latest Claude Code with per-invocation subagent `effort`, resumable Agent/SendMessage controls, background execution and TaskStop. Older Claude Code fallbacks are not provided. See the [runtime requirements](skills/slop-fix-batch/references/runtimes.md).

Copy these six sibling skill directories from this checkout into `.claude/skills/` in the target repository, or into `~/.claude/skills/` for personal use:

```sh
# Run from the kdy1-scripts checkout; choose the intended destination.
skill_destination=/path/to/target-repository/.claude/skills
python3 skills/slop-fix-batch/scripts/prepare-claude-skills.py "$skill_destination"
```

The helper copies `slop-fix-batch`, `create-pr`, `write-ste`, `repair-pr`, `manage-stacked-prs`, and `merge-pr`, including their scripts and references. It refuses to overwrite any existing destination skill. It does not change Claude settings or install Node.js, authenticated `gh`, or the required `github/gh-stack` extension. Install those prerequisites separately. Claude's [skill locations](https://code.claude.com/docs/en/skills#choose-where-skills-load) support both project and personal scopes.

In Claude Code, explicitly invoke:

```text
/slop-fix-batch Fix all open issues labeled bug in the current repository.
```

The skill starts only on explicit invocation with selection conditions. It stays in the current conversation and uses Sonnet workers: `high` effort for investigation, implementation and repair; `medium` for preparation, stack execution, maintenance and publication; `low` for inventory. The coordinator's model is unchanged. Claude reports verified PR URLs and records T3 Chat PR linking as not applicable. All GitHub verification and conditional merge gates remain required.

## Verify and invoke a skill

In T3 Chat, select a skill from the composer or explicitly invoke it by name. For providers that use `$` invocation:

```text
$write-prd
```

Several skills in this repository require explicit invocation. Select or name the skill in T3 Chat to start its workflow; Claude Code uses `/skill-name` syntax.

`create-pr` applies automatically when an authorized task includes PR creation, and can also be invoked as `$create-pr`. Other skills must invoke it for their PR publishing step. `slop-fix-issue` passes its resolved issue and validation results; `create-human-reviewed-pr` passes its human-review disclosure and source-preservation constraint. The shared skill owns publishing, reuse, verification, and attachment. PR titles and bodies follow an explicit user language request first, then an explicit repository language requirement, and otherwise default to English. Conversation language and existing PR language do not change that default. Required fixed template text and unrelated existing PR content are preserved. It explicitly invokes `write-ste` with the selected language while preserving templates, disclosures, issue references, and validation status. It writes and verifies Conventional Commits PR titles that summarize the full change set, with optional scope and a `!` marker for breaking changes, and verifies the selected language for new or revised title and body prose. It requires standalone `Closes` lines in the PR body for fully resolved issues and `Refs` lines for partial or related work.

`create-pr` includes existing relevant actual screenshots from the task or handoff in the PR body, using GitHub CLI `--attach` when supported or an available authenticated browser's native GitHub attachment flow. It reuses verified attachment URLs, avoids duplicate images, and verifies the published attachments. It does not capture new screenshots, launch the app, or run validation solely to publish a PR, and generated design previews are not actual screenshots. Missing screenshots or failed uploads do not block publication; it preserves successful attachments and reports omitted images and their reasons.

`design-ui` applies when the authorized task requires new or changed product UI, including direct UI changes and preparing issues, feature specifications, or implementation plans. Apply it alongside explicitly invoked skills such as `$add-issue`. Proposal and implementation phases run in the current conversation without requiring Plan Mode or a mode switch. Complete the preview and obtain approval of both the specific preview and its text specification before implementation or finalizing a plan, specification, or issue. Read-only UI inspection, screenshots without a change request, and editing this skill do not start the workflow.

The skill grounds the proposal in requirements, available UI, and the design system, then generates an inline `$imagegen` preview. Existing screens are optional for a new UI. When the final UI language is known, use it for visible preview text and actual UI copy in the specification. Each final preview shows only the area being changed; wider screenshots remain context references. Keep approved previews in image-generation default storage and retain their actual paths, descriptions, and final prompts in the conversation. After design approval, continue authorized implementation and verification in the same conversation without another invocation. Proposal-only requests finish with the approved design record. Issue-only requests pass that record to the already authorized issue workflow for finalization, recording, and attachments; design approval does not authorize product implementation or GitHub writes.

`write-ste` allows automatic selection when drafting or revising PRs, issues, reviews, technical documentation, and code explanations, including technical chat replies. It applies practical ASD-STE100 clarity principles while preserving the text's language, meaning, templates, and technical literals. For Korean and other languages, it uses natural local grammar. Ordinary conversation and marketing copy are excluded. It does not check the official approved vocabulary or certify full standard compliance. Automatic selection does not guarantee invocation for every eligible task; invoke `$write-ste` explicitly when needed.

`add-issue` defaults to local investigation unless the human or an authorized handoff specifies another environment or revision. A direct invocation permits relevant log inspection and confirmed regenerable-state repair outside Plan Mode, while preserving project code and user data. Local investigation forbids temporary code instrumentation, including in isolated copies. Repair and verify state problems before finalizing the affected candidate; state-only resolution creates no issue and keeps the chat open. MainQA, Static Analysis, and Collect Review handoffs retain their existing scope and restrictions and do not authorize a new repair run. Features and Tasks require runtime evidence only when relevant.

When using `$add-issue` in Plan Mode, return a concrete `repair pending` plan for candidates that need local repair; do not finalize their recording payload until the repair is verified outside Plan Mode. For ready candidates, finish investigation and finalize the exact issue title, complete body or duplicate comment, metadata, attachments, and recording action in the final plan. After approval and leaving Plan Mode, it resumes directly at recording with that payload; it does not repeat investigation, classification, reproduction, or drafting. It performs only bounded pre-write checks and verifies the result. A new matching duplicate or changed required condition stops that candidate and is reported without automatically changing the target or content. A missing finalized payload is reported rather than reconstructed. Draft-only restrictions continue after a mode change, and the issue's proposed work is never implemented in the same invocation. A fresh invocation outside Plan Mode retains the full investigation workflow.

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

Without a checklist, MainQA discovers and tests the whole app; it does not ask for a checklist. Supply a checklist to restrict the run to only those items. Independent screens and workflows are divided among GPT-5.6 Luna subagents with `xhigh` reasoning. Up to ten subagents may run simultaneously across QA and nested issue investigation/recording, further limited by actual runtime capacity. Install `add-issue` alongside `main-qa`: reporting subagents explicitly invoke it for in-scope candidates as candidates are discovered and centrally reconciled, while independent QA continues. It applies its classification-specific evidence requirements, including confirmed root causes at the identified commit for bugs, before recording; a browser observation does not automatically become an issue. Local investigation defaults to the current HEAD unless another revision is specified, including a non-default branch or detached HEAD, without fetching or comparing the default branch. Reported runtime behavior still requires identifying its actual revision.

Coverage includes usability problems even when actions succeed: ambiguous controls or instructions, hard-to-find existing actions, unclear results, missing next steps or recovery guidance, and inconsistent interactions that make an existing flow hard to use. Usability candidates require a reproducible obstacle, exact screen/state and viewport, sanitized screenshot, and concrete user impact. Cosmetic polish without usability impact, new features, and broad redesigns are excluded. `$add-issue` distinguishes existing behavior defects (`Bug`) from bounded UI clarification or cleanup that preserves product behavior (`Task`); an unresolved bug cannot be relabeled as a task to bypass investigation.

MainQA uses T3 app-owned delegated tasks. It validates the exact Luna model and `xhigh` option against the live provider catalog with `scripts/select-target.py`, retains task IDs, and uses asynchronous completion notifications. Workers are delegated tasks, not top-level conversations or scheduled jobs. See the [T3 runtime contract](skills/main-qa/references/t3-runtime.md) for delegation, capacity accounting, and recovery.

MainQA honors a user-specified browser or tab. Otherwise it uses T3's collaborative browser, checking `preview_status` and opening a preview when needed. Each worker opens its own allocated tab and retains its `tabId`; human-controlled tabs are read through snapshots only. Browser fallback requires the conditions and recorded evidence in the runtime contract. This policy also applies to browser reproduction during issue investigation.

Request draft-only reporting to receive the issue handoff payloads in chat without writing to GitHub.

`repair-pr` includes read-only preflight, versioned repair sessions, current-head Actions log collection, one-shot ordinary-PR publication, and post-publication thread handling. Sessions record separate repair commits, validation revisions, and external-write outcomes outside tracked source. Interrupted writes are reconciled against GitHub before another operation; uncertain requests are not blindly retried. Stack replay/publication remains owned by `manage-stacked-prs`, using the existing shared token and pre-change boundaries. See [repair session commands](skills/repair-pr/references/repair-session.md) for CLI arguments, record formats, and recovery.

`repair-pr` reports routine repair progress and results in T3 Chat conversations without posting PR comments or reviews by default. Other comments require an explicit human request, preserved with its scope in the repair session or authorized coordinator record. Objectively incorrect bot findings are the exception: a concise English explanation with concrete evidence may be posted in the original inline thread. After a successful final push, or when no push is needed, those threads must be resolved even if the optional reply is omitted or fails. Uncertain findings remain unresolved, and reply or resolution failures are reported in chat. This policy applies to PR repairs; `review-full` publication and issue-comment workflows retain their own policies.

To fix matching issues through grouped stacked PRs, explicitly invoke:

```text
$slop-fix-batch
Conditions: label:bug
Concurrency: 6
```

Natural-language conditions and an explicit request for all open issues are also accepted. A bare invocation asks for selection conditions. The skill collects a complete fixed list once, investigates it with subagents, and groups issues that share a root cause or need one inseparable implementation. Independent groups run in separate worktrees; dependent groups start from integrated prerequisite fixes. T3 Chat workers use GPT-6 Sol for investigation, preparation, implementation, stack execution, and maintenance, and GPT-5.6 Luna for inventory and repair. The settings helper supplies role-specific effort: standard investigation and implementation use `high`, preparation, stack execution, and maintenance use `medium`, inventory uses `low`, and repair uses `high`. Simple investigation and implementation use `medium`. There is no default concurrency cap: investigation, preparation, implementation, nested workers, and maintenance repairs share explicit user limits and runtime capacity. The coordinator refills free slots as results arrive, continuing independent investigation and implementation while dependencies or CI/reviews are pending.

The coordinator closes already-resolved issues only after confirming target-branch evidence and posting a verified evidence comment. Existing fixing PRs are reported without duplicate implementation. Blocked groups and their dependents remain available while independent verified groups continue to publication. Each completed group becomes one non-draft PR through `create-pr` after its implementation-worker checks and any checks needed for integration changes pass. Unchanged integration reuses worker coverage at its original SHA; there is no cumulative-tip or final-tip validation stage. `gh stack` connects each verified published prefix while preserving construction commits and ancestry. The bottom PR targets the selected base, and later PRs target the preceding layer. Closing references on upper layers do not guarantee automatic issue closure.

`slop-fix-batch` owns construction, PR maintenance, and conditional merging in the same coordinator. A fully verified stack enters its internal maintenance procedure immediately, without waiting for unrelated stacks or implementation to end. The coordinator continues that procedure directly for the exact recorded PR set, including upper layers, without a heartbeat or background polling process. It uses the adaptive one/five-minute refresh cadence unless an explicit interval is supplied. Implementation ends after publication or accurately reported blockers; maintenance continues until implementation has ended, all recorded PRs are closed/merged, and no active, uncertain, or protected work remains.

Shared stack ownership lives outside tracked source under the repository’s Git common directory. A construction token protects every registered layer until all assigned groups complete implementation, worker checks and necessary integration-change checks, publication, attachment, and remote verification. Building/held prefixes permit status accounting only. A completed standalone PR may enable auto-merge after fresh review gates; complete multi-PR stacks require fresh whole-stack review/CI gates and prefer native whole-stack squash merging. Sequential squash merging is allowed only when native capability is verified unsupported, with descendant alignment and fresh gates after each merge. Ready stacks repair in parallel using the runtime-specific repair settings from `worker-settings.mjs`, with one reserved/running repair per stack and the same total worker budget as construction. A catalog token serializes gh-stack mutations. Direct `repair-pr` and `manage-stacked-prs` honor the same protection. The cooperative helper does not intercept arbitrary Git commands or synchronize separate clones/hosts. Interrupted ownership requires evidence-backed reconciliation; tokens never expire automatically. See [`stack-coordination.md`](skills/repair-pr/references/stack-coordination.md) and the internal [`batch-maintenance.md`](skills/slop-fix-batch/references/batch-maintenance.md). Editing these skills starts no batch or repair.

`manage-stacked-prs` applies automatically to edits and alignment repairs in existing stacks, and can also be invoked as `$manage-stacked-prs <PR_URL>`. Completion includes restacking and verifying affected upper PRs. Unrelated lower PRs remain unchanged; a confirmed lower-layer cause that blocks the task is fixed minimally in its own PR, then propagated upward. Explicit local-only or narrower scope instructions take precedence. It records original boundaries and remote SHAs, pushes only changed branches, and reports partial failures without claiming alignment is complete. Stack creation and merging remain separate workflows.

`collect-review` starts only on direct human invocation or an explicit request to run Collect Review. It defaults to all merged PRs in the target repository, excludes open or unmerged PRs, and skips findings already resolved at the recorded current head. It immediately hands candidates to `add-issue`, resolves handled threads after verified issue tracking, and creates or updates one summary comment per PR with verified issue links. Draft-only restrictions remain in force.

`static-analysis` analyzes all code in the requested scope, or the whole repository when scope is omitted. A direct invocation or explicit request to run Static Analysis authorizes immediate `add-issue` handoffs for confirmed bugs; ordinary code-review requests do not authorize GitHub recording. Install `add-issue` alongside both analysis skills.

`improve-skill-efficiency` analyzes the selected skill's local T3 Chat session history with its bundled helper and prices supported usage using current official API rates. It applies evidence-backed improvements while preserving functionality, quality, validation, models, reasoning settings, and authorization boundaries. Reports distinguish measured historical costs, estimated effects, and any measured savings, with explicit coverage limits.

## Notes

- `main-qa` starts only on a human's direct `$main-qa` invocation or explicit request to run MainQA. Generic QA requests, URLs alone, and skill editing do not start a run. It requires browser tools, subagent controls, and `gpt-5.6-luna` with `xhigh`; unavailable settings are reported without substitution. Missing server details are requested when needed. A human MainQA invocation authorizes only its scoped `$add-issue` handoffs, which retain the original request and delegation context; other skill handoffs do not gain this exception. All investigation and recording descendants share the concurrency limit and Luna settings. In Plan Mode it prepares a plan only. It reports blocked or incomplete coverage honestly, cleans up only its own server/test resources, and never fixes code, deploys, or starts a monitor.
- `create-pr` is the shared publishing dependency for PR-creating skills. Install `write-ste` alongside it for required PR title and body drafting. Automatic selection requires an already authorized PR-creation task; ordinary code changes or skill editing do not start publication. It defaults to non-draft, honors requested draft state, and verifies `Closes` for fully resolved issues and `Refs` for partial or related work. Existing references are preserved in later body edits, and changes without an associated issue get no invented reference. It publishes only intended changes and stops on blocking checks without rewriting source. Existing matching PRs are reused and uncertain writes are reconciled before retries.
- `create-human-reviewed-pr` starts only when the human directly invokes `$create-human-reviewed-pr`; invoking it declares that the current changes have been human-reviewed. It resolves the reviewer from an explicit username or the target GitHub host's authenticated account and includes execution details only when known. Install `create-pr` alongside it; it prepares the disclosure, then invokes `create-pr` for verified non-draft publication while preserving reviewed source. Missing publication dependencies are reported without a direct-publishing fallback.
- `slop-fix-issue` starts on a human's explicit invocation or an authorized issue handoff from another explicitly invoked skill. Authorized coordinators can assign an issue with only `$slop-fix-issue <issue_url>`; delegation history stays in the coordinator record. It generates AI slop to implement one issue while retaining required verification. It closes already-resolved issues as completed after posting and confirming an evidence comment, then stops without selecting another issue or creating a PR or automation. Otherwise it invokes `create-pr` to publish, verify, and link a non-draft PR, or a dependency-ordered `gh stack` for a large issue. Partial layers use `Refs`; the final layer uses `Closes` only when the full issue is resolved. It verifies every layer and remote stack membership before stopping. Install `create-pr` alongside it; unavailable publication dependencies block implementation of unresolved issues, but are not needed for evidence-backed closure. It uses authenticated `gh` and T3 Chat PR-linking tools; large issues also require installed `gh stack` support. PR-maintenance skills and heartbeat tools are not dependencies. Existing PRs are reconciled and reported without replacement or maintenance, and no CI, review, or merge loop follows publication.
- Do not place the repository itself directly inside `~/.agents/skills`: Each immediate child must be a skill directory containing `SKILL.md`. Clone the repository elsewhere and link or copy its individual directories from `skills/`.
- Avoid installing two different directories with the same skill `name`. Duplicate names may appear in the skill selector; do not rely on them being merged.
- Review a skill's `SKILL.md` and any included scripts before installing it, especially when it can run commands or access external services.
