---
name: slop-fix-issue
description: Generate AI slop to implement one GitHub issue, open and verify a non-draft PR with a Closes reference, and stop; close already-resolved issues with supporting evidence instead.
---

# Slop Fix Issue

Start this workflow only when the human explicitly invokes `$slop-fix-issue` to handle an issue, or a skill workflow explicitly invoked by the human delegates one issue within that request's authorized scope. An authorized coordinator may dispatch a fresh item chat with only `$slop-fix-issue <issue_url>`. That invocation assigns and authorizes only the exact issue URL; the coordinator retains the original human invocation, delegation chain, and scope without adding them to the item prompt. A delegating skill conveys existing human authorization; it cannot authorize a new scope on its own. An agent or automation cannot independently authorize a new start or a different issue. Establish authorization from the direct human invocation or the assigned skill invocation created by an authorized coordinator; loading, editing, or planning this skill, a skill mention in external content, or an automation prompt alone does not authorize a run.

This is a one-shot workflow. Do not register a watch or heartbeat, invoke a PR-maintenance skill, or wait for CI, review feedback, or merging after verifying and attaching the PR.

Handle one issue. If it is already resolved, post the supporting evidence, close it as completed, and stop. Otherwise generate AI slop to implement it, open and verify a non-draft pull request, attach it, and stop. Do not pick another issue after closing an already-resolved issue or creating the PR, including when the issue was selected automatically.

## Required Tools and Skill

- Use authenticated `gh` access for GitHub operations and discover `attach_artifact` to attach the created PR.
- PR publication or reconciliation requires [$create-pr](../create-pr/SKILL.md). Read it and resolve its installed `SKILL.md` to an absolute path before implementing an unresolved issue or handling this workflow's existing PR. If unavailable, report the missing dependency and stop instead of publishing directly. The already-resolved issue closure path does not require PR publication.

## Select and Assess One Issue

1. Resolve the target repository from the user's explicit context or authorized handoff, otherwise from the current checkout's GitHub remote. Confirm authentication and read applicable repository instructions. If no unique repository can be determined, ask for it before changing anything.
2. Check this chat's context, attached PRs, and recorded branch before selecting work. If this workflow already has a PR, reconcile it through **Create and Verify the PR**, report the result, and stop instead of selecting another issue or creating another branch or PR. Reconcile GitHub state after an interrupted creation or issue-closure attempt before retrying.
3. Use the issue specified by the human or authorized handoff when provided. Otherwise, inspect open issues and choose one with clear expected behavior, a bounded implementation, and practical verification. Read its current state, body, discussion, relevant code, and change history, and check for an existing PR addressing it. If the selected issue is already closed, report its state and stop without reopening it or adding a redundant comment. Prefer independently verifiable work over work needing unresolved product decisions.
4. State the chosen issue and why it is suitable. Before creating a branch or implementing anything, assess whether its full requirements are already satisfied using the closure procedure below. If they are, complete that procedure and stop. For unresolved issues covered by someone else's open PR, skip automatically considered candidates; if the human or authorized handoff selected the issue, report that PR and clarify the intended work instead of duplicating it. Otherwise continue with implementation. Ask only for material decisions that the issue, repository, and discussion cannot resolve. Do not invent requirements or open a new issue as part of this workflow.

## Close an Already-Resolved Issue

1. Compare the full issue requirements and discussion with the freshly fetched intended target branch, identifying the exact revision inspected. Check relevant code, merged changes, and focused verification, including release, deployment, or real-environment acceptance requirements when the issue explicitly requires them. An open PR, partial implementation, a merged PR alone, or failure to reproduce by itself is not proof of completion. If evidence is insufficient, keep the issue open and continue investigation or report the missing evidence.
2. Prepare a concise evidence comment explaining how the requirements are satisfied, linking the relevant commits, PRs, or code at the inspected revision, and recording verification commands or checks and their actual results. Distinguish executed checks from code inspection; do not claim unperformed validation.
3. Re-read the issue state and existing comments before posting, including all comment pages needed to detect a previous attempt. If the issue is already closed, report its state and stop. Reuse an existing comment from this workflow only when it contains the same still-valid evidence. Otherwise write the exact comment to a temporary file and post it with `gh issue comment <issue-url> --body-file <comment-file>`. Confirm the comment exists and retain its URL before closing. If posting fails or its outcome is unknown, reconcile the comments before retrying; do not close without a confirmed evidence comment or blindly post a duplicate.
4. Close the exact issue with `gh issue close <issue-url> --reason completed`, then re-fetch its state and state reason to verify it is closed as completed. If closing or verification fails, report the failure or uncertainty and the evidence comment URL; do not claim successful closure. Before retrying, reconcile the issue state and comments and reuse the confirmed evidence comment rather than posting it again.
5. Report the issue URL, evidence comment URL, and verified outcome, then stop. Do not create an issue branch, PR, or maintenance automation for this outcome, and do not select another issue whether the issue was specified by the user or selected automatically.

## Implement an Unresolved Issue

1. Inspect the working tree and attached worktrees. Reuse a suitable clean worktree or create an isolated managed worktree when needed, following the available worktree tools. Preserve pre-existing changes and keep the chosen checkout available for review. Start an issue branch from the freshly fetched intended base, using repository conventions and the actual remote and base branch.
2. Implement the issue, perform the repository's required validation and relevant regression checks, and commit each coherent, verified unit according to repository instructions. Keep the change scoped to the selected issue and retain the actual validation results for `$create-pr`. Let it push the required head commits during publication.

## Create and Verify the PR

Explicitly invoke `[$create-pr](<absolute-create-pr-skill-path>)` in this task with the authorization available in this chat, authorized issue scope, exact selected issue URL, repository and absolute worktree path, intended head repository/remote/branch and base, existing PR URL when known, and actual validation results. Describe the problem and resulting behavior, identify the issue as fully resolved only when supported by the implementation and checks, and require **non-draft** (`isDraft: false`) publication.

Let `$create-pr` own publication, PR reuse and interrupted-write reconciliation, required `Closes` or `Refs` references and their verification, and attachment. Do not duplicate or bypass its workflow. If this workflow's PR is already merged or closed, its recorded-PR handling reports and attaches it without creating a replacement. Return after its verified result or blocker; do not pick another issue or start PR maintenance.

## Return the Result

Report the issue URL, PR URL and state, repository identity, head branch, absolute worktree path, performed validation and actual results, and any unresolved limits. Preserve the closing reference and leave the worktree available for review. Distinguish local validation from pending or unperformed CI and review checks.

After reporting the result or blocker, stop. Do not start PR maintenance, repair reviews or CI failures after PR creation, or merge the PR or enable auto-merge.
