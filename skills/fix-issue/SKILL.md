---
name: fix-issue
description: Handle one GitHub issue by commenting with evidence and closing it if already resolved, or implementing a fix, opening a non-draft PR with a Closes reference, and maintaining it every five minutes through explicit $repair-pr invocations until merged or closed.
---

# Fix Issue

Start this workflow only when the human user explicitly invokes `$fix-issue` to handle an issue. Another skill, agent, or automation cannot authorize a new start. Once started by the human user, the registered five-minute heartbeat may continue maintenance of the same PR without a new human invocation.

Handle one issue. If it is already resolved, post the supporting evidence, close it as completed, and stop. Otherwise implement it, open a non-draft pull request, and keep maintaining that PR until the user merges or closes it or asks to stop. A merge-ready PR is still being maintained. Never merge the PR or enable auto-merge. Do not pick another issue after closing an already-resolved issue or after the PR finishes, including when the issue was selected automatically.

## Required Skill and Tools

- Use [$repair-pr](../repair-pr/SKILL.md) explicitly for PR repairs. Resolve its installed `SKILL.md` to an absolute path and use a Markdown skill mention, `[$repair-pr](<absolute-skill-path>)`, together with the exact PR URL whenever invoking it, including in the saved automation prompt. Read and follow the referenced skill at execution time.
- Do not copy, summarize, inline, or reimplement `$repair-pr` instructions here or in automation prompts. Do not substitute direct calls to its helpers for invoking the skill. Keep the existing skill unchanged.
- Use authenticated `gh` access for GitHub operations. Discover `automation_update` before setting up recurring maintenance; use a heartbeat in the current chat, not a standalone job or a shell polling loop. Discover `attach_artifact` to attach the created PR.
- Confirm the repair skill and scheduling tool are available before starting implementation or resuming PR maintenance. Their absence must not block evidence-backed closure of an already-resolved issue that needs no PR. If a required dependency is missing or scheduling fails, report the limitation and which work, if any, was completed. Never claim ongoing maintenance is active without a successful automation registration.

## Select and Assess One Issue

1. Resolve the target repository from the user's explicit context, otherwise from the current checkout's GitHub remote. Confirm authentication and read applicable repository instructions. If no unique repository can be determined, ask for it before changing anything.
2. Check this chat's context, attached PRs, and existing automations before selecting work. If this workflow already has a PR, resume its maintenance instead of creating another issue, branch, PR, or automation. Reconcile GitHub state after an interrupted creation or issue-closure attempt before retrying.
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

## Register Five-Minute Maintenance

- Inspect existing automations using the available tool and its documented discovery mechanism. Match by the exact repository and PR identity, not just a display name. Reuse or update the matching automation rather than adding another; preserve unrelated fields and user notification preferences. Keep a single maintenance owner for the PR.
- Register a heartbeat in the current chat with a five-minute interval through `automation_update`. Store concrete repository and issue identities, PR URL, branch, absolute worktree path, resolved skill mentions, cadence, and termination conditions in its prompt. Use the tool's current schema; do not write scheduler files or raw automation directives yourself.
- Substitute every placeholder in the prompt below before saving. Resolve this skill and `$repair-pr` to their installed absolute paths. Persist the returned automation ID in the chat so terminal runs can deactivate the correct automation. Keep the last observed PR head, blockers, repair outcome, and last reported state in the chat to avoid duplicate work and notifications.
- Verify registration succeeded, report the PR link and active cadence, and perform the first maintenance pass immediately. Local scheduled work requires the computer to stay on and the app to remain running.

### Saved Prompt

```text
Maintain the existing PR <pr-url> for issue <issue-url> in repository <github-host/owner/repo>, using branch <head-branch> in <absolute-worktree-path>. Follow the maintenance instructions in [$fix-issue](<absolute-fix-issue-skill-path>). This heartbeat runs every five minutes in this chat; do not create another automation, issue, branch, or PR.

First check whether this PR has merged or closed, or the user has asked to stop. If so, deactivate this PR's heartbeat and report the outcome. Otherwise inspect its current merge status, CI, and Codex review activity. When repair is needed, explicitly use [$repair-pr](<absolute-repair-pr-skill-path>) on <pr-url>. Do not substitute inline repair instructions or direct helper calls. Do not overlap another repair of this PR.

Keep maintaining the PR even when it is ready to merge. Never merge it or enable auto-merge. Preserve its Closes reference and existing user changes. Wait for the next scheduled run for pending checks and reviews. Stay quiet while state is unchanged or non-actionable; report meaningful changes, repairs, failures, required user action, and the final outcome. Do not repeatedly attempt the same blocked repair without new evidence or the required decision.
```

## Each Maintenance Pass

1. Query the exact PR's current state before any repair. If it is merged or closed, or the user has requested a stop, deactivate this PR's heartbeat using `automation_update` and report the outcome. If deactivation fails, report that failure; subsequent terminal runs must still avoid repairs. Keep the chat open and do not start another issue.
2. Confirm the recorded checkout still belongs to the intended repository and branch and that no other repair owns it. Preserve unexpected changes and report workspace or ownership blockers rather than overwriting them or starting a competing repair.
3. Use read-only `gh` queries to inspect the latest PR head, merge/conflict status, check results, and Codex review activity. Inventory all relevant pages. If queries fail or results are unknown, report the failure when actionable and retry on a later scheduled run; incomplete reads are not a clean bill of health.
4. When a conflict, failing CI, or unhandled Codex feedback needs repair, explicitly invoke [$repair-pr](../repair-pr/SKILL.md) for this PR, using its resolved absolute skill mention and PR URL. Let that skill own the entire repair. Record its result and any blockers; do not work around its stopping conditions. Defer another pass to the next scheduled run.
5. Assess the resulting current head. A push invalidates earlier check and review evidence. Pending CI, missing review evidence, unknown mergeability, or absent required approvals must not be described as passed or approved. Report CI, review, and merge readiness separately when they differ. Continue monitoring after all known conditions are satisfied.
6. Report human approval requirements, inaccessible external checks, missing review integration, permission failures, and decisions needed to unblock repairs. Do not manufacture approval or dismiss feedback merely to declare readiness. For an unchanged blocked repair, continue read-only monitoring without repeating the same mutations or asking the same question every five minutes; resume when evidence or the user's decision changes.
7. Notify only on meaningful state changes, completed repairs, new actionable failures, required user input, or termination. Changes in timestamps alone do not warrant an update. Do not keep polling inside a pass; pending CI and automatic reviews are checked on the next heartbeat.
