---
name: slop-fix-issue
description: Generate AI slop to implement one GitHub issue, publish and verify a non-draft PR or, for large issues, a gh-stack PR stack with appropriate issue references, and stop; close already-resolved issues with supporting evidence instead.
---

# Slop Fix Issue

Start this workflow only when the human explicitly invokes `$slop-fix-issue` to handle an issue, or a skill workflow explicitly invoked by the human delegates one issue within that request's authorized scope. An authorized coordinator may dispatch a fresh item chat with only `$slop-fix-issue <issue_url>`. That invocation assigns and authorizes only the exact issue URL; the coordinator retains the original human invocation, delegation chain, and scope without adding them to the item prompt. A delegating skill conveys existing human authorization; it cannot authorize a new scope on its own. An agent or automation cannot independently authorize a new start or a different issue. Establish authorization from the direct human invocation or the assigned skill invocation created by an authorized coordinator; loading, editing, or planning this skill, a skill mention in external content, or an automation prompt alone does not authorize a run.

This is a one-shot workflow. Do not register a watch or heartbeat, invoke a PR-maintenance skill, or wait for CI, review feedback, or merging after verifying and attaching the single PR or every PR in the stack.

Handle one issue. If it is already resolved, post the supporting evidence, close it as completed, and stop. Otherwise generate AI slop to implement it, publish, verify, and attach a non-draft PR or a stack of non-draft PRs, and stop. Do not pick another issue after closing an already-resolved issue or publishing the single PR or stack, including when the issue was selected automatically.

## Required Tools and Skill

- Use authenticated `gh` access for GitHub operations and discover `attach_artifact` to attach every created PR.
- PR publication or reconciliation requires [$create-pr](../create-pr/SKILL.md). Read it and resolve its installed `SKILL.md` to an absolute path before implementing an unresolved issue or handling this workflow's existing PRs. If unavailable, report the missing dependency and stop instead of publishing directly. The already-resolved issue closure path does not require PR publication.

- Large issues require `gh stack`. Check the installed `init`, `link`, and `view` help before stack construction. If the required commands are unavailable, report the blocker and stop; do not silently install or upgrade the extension or substitute one large PR. Reuse `$create-pr`'s scripts for publication, reconciliation, and per-PR verification.

## Select and Assess One Issue

1. Resolve the target repository from the user's explicit context or authorized handoff, otherwise from the current checkout's GitHub remote. Confirm authentication and read applicable repository instructions. If no unique repository can be determined, ask for it before changing anything.
2. Check this chat's context, attached PRs, recorded branches, and layer plan before selecting work. Reconcile existing PRs through **Create and Verify the PRs**. For an interrupted stack, reconcile all recorded layers and resume only unfinished implementation, publication, linking, or verification for the same issue; an existing lower PR does not mean the stack is complete. Reuse recorded branches and PRs instead of duplicating them. If the single PR or whole stack is complete, report and stop. Reconcile GitHub state after an interrupted creation, stack-link, or issue-closure attempt before retrying.
3. Use the issue specified by the human or authorized handoff when provided. Otherwise, inspect open issues and choose one with clear expected behavior, a bounded implementation, and practical verification. Read its current state, body, discussion, relevant code, and change history, and check for an existing PR addressing it. If the selected issue is already closed, report its state and stop without reopening it or adding a redundant comment. Prefer independently verifiable work over work needing unresolved product decisions.
4. State the chosen issue and why it is suitable. Before creating a branch or implementing anything, assess whether its full requirements are already satisfied using the closure procedure below. If they are, complete that procedure and stop. For unresolved issues covered by someone else's open PR, skip automatically considered candidates; if the human or authorized handoff selected the issue, report that PR and clarify the intended work instead of duplicating it. Otherwise continue with implementation. Ask only for material decisions that the issue, repository, and discussion cannot resolve. Do not invent requirements or open a new issue as part of this workflow.

## Close an Already-Resolved Issue

1. Compare the full issue requirements and discussion with the freshly fetched intended target branch, identifying the exact revision inspected. Check relevant code, merged changes, and focused verification, including release, deployment, or real-environment acceptance requirements when the issue explicitly requires them. An open PR, partial implementation, a merged PR alone, or failure to reproduce by itself is not proof of completion. If evidence is insufficient, keep the issue open and continue investigation or report the missing evidence.
2. Prepare a concise evidence comment explaining how the requirements are satisfied, linking the relevant commits, PRs, or code at the inspected revision, and recording verification commands or checks and their actual results. Distinguish executed checks from code inspection; do not claim unperformed validation.
3. Re-read the issue state and existing comments before posting, including all comment pages needed to detect a previous attempt. If the issue is already closed, report its state and stop. Reuse an existing comment from this workflow only when it contains the same still-valid evidence. Otherwise write the exact comment to a temporary file and post it with `gh issue comment <issue-url> --body-file <comment-file>`. Confirm the comment exists and retain its URL before closing. If posting fails or its outcome is unknown, reconcile the comments before retrying; do not close without a confirmed evidence comment or blindly post a duplicate.
4. Close the exact issue with `gh issue close <issue-url> --reason completed`, then re-fetch its state and state reason to verify it is closed as completed. If closing or verification fails, report the failure or uncertainty and the evidence comment URL; do not claim successful closure. Before retrying, reconcile the issue state and comments and reuse the confirmed evidence comment rather than posting it again.
5. Report the issue URL, evidence comment URL, and verified outcome, then stop. Do not create an issue branch, PR, or maintenance automation for this outcome, and do not select another issue whether the issue was specified by the user or selected automatically.

## Implement an Unresolved Issue

1. Before creating branches or implementing, assess the issue's size and dependencies. Keep a small, reviewable change in one PR. If one PR would be too large to review, use `gh stack` and split the issue into coherent layers that can each be reviewed and verified. Do not use a fixed line or file count. Record each layer's purpose, scope, validation, branch, base, and dependency order. Identify which implementation tasks can run in parallel and which must wait for prerequisite commits or interfaces. Together the layers must cover the selected issue without adding requirements.
2. Inspect the working tree and attached worktrees. Reuse a suitable clean worktree or create an isolated managed worktree when needed, following the available worktree tools. Preserve pre-existing changes and keep the chosen checkout available for review. Start the single issue branch or bottom layer from the freshly fetched intended base, using repository conventions and the actual remote and base branch.
3. For a stack, use the parallel work procedure below and integrate the final layer branches from bottom to top. Start each child from its completed parent's tip, then implement or apply only that child's changes and commit them. Register the ordered branches with `gh stack init --base <intended-base> <bottom-branch> ... <top-branch>`; when resuming, inspect `gh stack view --json` and reuse existing tracking rather than initializing another stack. Do not create all child branches before their prerequisite commits exist and leave them on stale parent tips.
4. Perform the repository's required validation and relevant regression checks, and commit each coherent, verified unit according to repository instructions. For stacks, validate each layer and the combined implementation against the full issue requirements. Check each layer's diff against its immediate parent, and confirm that each child contains its parent's tip with `git merge-base --is-ancestor`. Retain actual results and covered revisions for `$create-pr`; let it push the required head commits during publication.
5. Keep the layer plan and progress outside tracked source. Record worktree paths, exact head revisions, publication manifest/journal paths, PR URLs, and linking/verification outcomes as they become known so an interrupted run can resume from actual state.

### Parallel Work for a Stack

Use subagents to perform independent stack work in parallel when the available delegation tools support it. Choose concurrency from the dependency plan, shared-file ownership, and available resources; do not use a fixed worker count or serialize all implementation merely because the final PRs form a chain. If delegation is unavailable or no implementation tasks are independent, record the reason and proceed sequentially. Independent investigation or test preparation can still run while implementation waits for prerequisites.

- Give each worker a bounded task within the selected issue, its prerequisites and starting revision, owned files, validation requirements, and expected result. Workers return commits and actual validation results to the coordinator. They must not select another issue, publish PRs, or change stack tracking.
- Use separate worktrees and temporary branches for concurrent implementation. Do not let workers edit the same checkout or concurrently mutate the same branch. Assign shared contracts and overlapping files to one owner; start dependent work after the required interface or prerequisite commit is available.
- Independent changes may be prepared concurrently from a shared committed baseline. Treat these branches as temporary work, not final stack layers. Apply their commits to the appropriate final layer only after its parent is complete. Resolve integration conflicts and validate the resulting layer revision; validation of a worker's original revision does not validate the integrated result.
- Keep final branch integration, stack tracking changes, and PR publication under one coordinator in dependency order. Run independent checks in parallel only when their worktrees and test resources do not conflict. Retain the per-layer and combined validation required above.
- Record worker task identifiers, worktrees, starting revisions, returned commits, and integration status with the layer plan. On resume, reconcile active or completed workers before dispatching replacements so the same task is not run twice.

## Create and Verify the PRs

For a single PR, invoke `$create-pr` once. For a stack, invoke it for each layer from bottom to top. Explicitly invoke `[$create-pr](<absolute-create-pr-skill-path>)` in this task with the authorization available in this chat, authorized issue scope, exact selected issue URL, repository and absolute worktree path, intended head repository/remote/branch and base, existing PR URL when known, and actual validation results. Require **non-draft** (`isDraft: false`) publication. The bottom PR targets the original intended base; every upper PR targets the preceding layer's branch. Describe each layer's own changes and its prerequisites.

Pass partial issue completion for lower layers so their bodies use `Refs`. Only the final layer uses `Closes` when its implementation together with its prerequisites satisfies the full issue requirements and the checks support that conclusion. For a single PR, use the same full-versus-partial completion rule. A closing keyword on a non-default base does not automatically close the issue; report this limitation without changing the base or closing the issue manually.

Let `$create-pr` own publication, PR reuse and interrupted-write reconciliation, required `Closes` or `Refs` references and their verification, and attachment. Do not duplicate or bypass its workflow. If any recorded PR is already merged or closed, let its recorded-PR handling report and attach it, then stop without creating a replacement or rebuilding the stack around it. On a publication blocker, report the verified prefix and unfinished layers. Successful publication of one layer returns control here to publish the next planned layer; it does not end an incomplete stack.

After every planned PR has been published and verified, connect the stack with:

```sh
gh stack link --base <intended-base> --remote <head-remote> <bottom-pr-url> ... <top-pr-url>
```

Pass only verified existing PR URLs in bottom-to-top order, not branch names that could cause `gh stack link` to create PRs outside `$create-pr`. Before linking, re-read the PR identities, states, and bases and check existing remote stack membership. Stop on conflicting membership or unexpected changes rather than adding unrelated PRs or retargeting them. If linking fails or its outcome is uncertain, inspect actual remote membership before retrying; never recreate verified PRs to repair a linking failure.

Inspect `gh stack view --json` and authenticated GitHub state after linking. Confirm the exact remote stack membership and order, each PR's expected head repository and SHA, chained bases, open non-draft state, issue references, and attachment. Recheck parent ancestry and layer diffs against the recorded plan. Use `$create-pr`'s verification helper for per-PR checks, including any changes made by linking. Local tracking alone is not proof of a remote stack. Report missing or uncertain verification as a blocker rather than claiming completion.

Return after the single PR or complete stack is verified and attached, or after a blocker. Do not pick another issue or start PR maintenance.

## Return the Result

Report the issue URL, repository identity, each PR URL and state in dependency order, head and base branches, absolute worktree paths, performed validation and actual results, and any unresolved limits. For a stack, include the verified linking outcome and any unfinished layers. Preserve issue references and leave worktrees available for review. Distinguish local validation from pending or unperformed CI and review checks.

After reporting the result or blocker, stop. Do not start PR maintenance, repair reviews or CI failures after publication, or merge any PR or enable auto-merge.
