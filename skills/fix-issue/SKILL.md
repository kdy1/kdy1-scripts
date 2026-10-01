---
name: fix-issue
description: Handle one GitHub issue by commenting with evidence and closing it if already resolved, or implementing a fix, opening a non-draft PR with a Closes reference, and handing its maintenance to $maintain-pr.
---

# Fix Issue

Start this workflow only when the human user explicitly invokes `$fix-issue` to handle an issue. Another skill, agent, or automation cannot authorize a new start. The human's invocation also authorizes `$maintain-pr` to maintain this workflow's PR. A previously registered heartbeat may continue the same authorized PR; route legacy `$fix-issue` maintenance runs through the handoff below without starting a new issue workflow.

Handle one issue. If it is already resolved, post the supporting evidence, close it as completed, and stop. Otherwise implement it, open a non-draft pull request, and delegate its maintenance to `$maintain-pr`. Do not pick another issue after closing an already-resolved issue or after the PR finishes, including when the issue was selected automatically.

## Required Skill and Tools

- Use [$maintain-pr](../maintain-pr/SKILL.md) for all PR maintenance. Resolve its installed `SKILL.md` to an absolute path and read it at execution time. Do not duplicate its scheduling or repair procedures here.
- Use authenticated `gh` access for GitHub operations and discover `attach_artifact` to attach the created PR.
- Before implementation or a maintenance handoff, confirm `$maintain-pr` and the dependencies required by its preflight are available. Their absence must not block evidence-backed closure of an already-resolved issue that needs no PR. If unavailable, report the limitation and completed work.

## Select and Assess One Issue

1. Resolve the target repository from the user's explicit context, otherwise from the current checkout's GitHub remote. Confirm authentication and read applicable repository instructions. If no unique repository can be determined, ask for it before changing anything.
2. Check this chat's context, attached PRs, and existing automations before selecting work. If this workflow already has a PR, use the maintenance handoff below and stop issue selection instead of creating another issue, branch, PR, or automation. Reconcile GitHub state after an interrupted creation or issue-closure attempt before retrying.
3. Use the specified issue when provided. Otherwise, inspect open issues and choose one with clear expected behavior, a bounded implementation, and practical verification. Read its current state, body, discussion, relevant code, and change history, and check for an existing PR addressing it. If the selected issue is already closed, report its state and stop without reopening it or adding a redundant comment. Prefer independently verifiable work over work needing unresolved product decisions.
4. State the chosen issue and why it is suitable. Before creating a branch or implementing anything, assess whether its full requirements are already satisfied using the closure procedure below. If they are, complete that procedure and stop. For unresolved issues covered by someone else's open PR, skip automatically considered candidates; if the user explicitly selected the issue, report that PR and clarify the intended work instead of duplicating it. Otherwise continue with implementation. Ask only for material decisions that the issue, repository, and discussion cannot resolve. Do not invent requirements or open a new issue as part of this workflow.

## Close an Already-Resolved Issue

1. Compare the full issue requirements and discussion with the freshly fetched intended target branch, identifying the exact revision inspected. Check relevant code, merged changes, and focused verification, including release, deployment, or real-environment acceptance requirements when the issue explicitly requires them. An open PR, partial implementation, a merged PR alone, or failure to reproduce by itself is not proof of completion. If evidence is insufficient, keep the issue open and continue investigation or report the missing evidence.
2. Prepare a concise evidence comment explaining how the requirements are satisfied, linking the relevant commits, PRs, or code at the inspected revision, and recording verification commands or checks and their actual results. Distinguish executed checks from code inspection; do not claim unperformed validation.
3. Re-read the issue state and existing comments before posting, including all comment pages needed to detect a previous attempt. If the issue is already closed, report its state and stop. Reuse an existing comment from this workflow only when it contains the same still-valid evidence. Otherwise write the exact comment to a temporary file and post it with `gh issue comment <issue-url> --body-file <comment-file>`. Confirm the comment exists and retain its URL before closing. If posting fails or its outcome is unknown, reconcile the comments before retrying; do not close without a confirmed evidence comment or blindly post a duplicate.
4. Close the exact issue with `gh issue close <issue-url> --reason completed`, then re-fetch its state and state reason to verify it is closed as completed. If closing or verification fails, report the failure or uncertainty and the evidence comment URL; do not claim successful closure. Before retrying, reconcile the issue state and comments and reuse the confirmed evidence comment rather than posting it again.
5. Report the issue URL, evidence comment URL, and verified outcome, then stop. Do not create an issue branch, PR, or maintenance automation for this outcome, and do not select another issue whether the issue was specified by the user or selected automatically.

## Implement an Unresolved Issue

1. Inspect the working tree and attached worktrees. Reuse a suitable clean worktree or create an isolated managed worktree when needed, following the available worktree tools. Preserve pre-existing changes and keep the chosen checkout available throughout maintenance. Start an issue branch from the freshly fetched intended base, using repository conventions and the actual remote and base branch.
2. Implement the issue, perform the repository's required validation and relevant regression checks, and commit and push the verified change. Keep the change scoped to the selected issue. Follow repository contribution and commit conventions.

## Create and Verify the PR

1. Check again for a PR for this issue branch before creating one. Reuse this workflow's existing PR when present.
2. Create a **non-draft** PR against the intended base. Follow the repository's PR template and describe the problem, resulting behavior, and validation.
3. Put a standalone closing reference in the **PR body**: `Closes #123`, with the actual selected issue number. For an issue in another repository, use `Closes owner/repo#123`. A title reference, plain link, or `Refs #123` is not a substitute.
4. Re-fetch the PR and verify its repository, base, head, `isDraft: false`, and exact closing reference. Correct any mismatch introduced by this workflow before reporting the PR as created successfully. Preserve the closing reference in later body edits.
5. Attach the PR to the current chat with `attach_artifact`. Record the issue URL, PR URL, repository identity, branch, and absolute worktree path for subsequent maintenance.

## Hand Off PR Maintenance

After creating and verifying the PR, or when resuming this workflow's existing PR, explicitly invoke `[$maintain-pr](<absolute-maintain-pr-skill-path>)` with its exact URL. Pass the issue URL and closing reference, repository identity, head branch, absolute worktree path, and the chat's original human invocation as the authorization origin. Forward any user-specified interval; otherwise leave cadence selection to `$maintain-pr`.

For a resumed or legacy heartbeat, also pass its automation ID and recorded state so `$maintain-pr` can reuse it and update the saved prompt. Let that skill own registration, the first pass, later passes, termination, and notifications. If the handoff or registration fails, report the PR link and actual outcome without claiming maintenance is active. Do not resume issue selection after handing off or after a failed handoff.
