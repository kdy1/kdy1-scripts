---
name: repair-pr
description: One-shot GitHub pull request repair workflow for the current or specified repository. Use when asked to resolve merge conflicts, handle unresolved feedback from chatgpt-codex-connector[bot] and the authenticated GitHub user (@me), fix failing CI, commit each distinct repair problem separately, perform final pushes under shared stack ownership, and resolve handled review threads. Post no PR comments by default, except optional English explanations of objectively incorrect bot findings.
---

# Repair PR

## Goal

Repair the current or specified GitHub PR once, then stop. Handle merge conflicts, unresolved review feedback from `chatgpt-codex-connector[bot]` and the authenticated GitHub user (`@me`), and CI failures in that order. Correct actionable findings, assess incorrect findings with concrete evidence, and resolve handled threads. Create a separate commit for each distinct repair problem that changes files, but publish only after all local changes are complete. Ordinary PRs push once; stacked PRs use the scoped final pushes owned by [$manage-stacked-prs](../manage-stacked-prs/SKILL.md).

## Comment policy

- By default, report repair results, progress, and supporting evidence in the Codex chat. Do not post top-level PR comments, repair summaries, new reviews, or inline replies to actionable findings.
- An objectively incorrect bot finding is the exception: a concise English explanation with concrete evidence may be posted in its original inline thread without a separate human request. This exception does not apply to findings authored by `@me`. This reply is optional; resolving the incorrect-finding thread is required under **Finish once**, even when the reply is omitted or fails.
- Other PR comments require an explicit human request. Preserve that request and its scope when supplied directly or through an authorized handoff. A repair or maintenance invocation alone is not a request to post comments.

## Workflow

1. Resolve the PR context.
   - Confirm the current directory belongs to a Git repository with a GitHub remote, `gh` and Node.js are installed, and `gh auth status` works.
   - Read the applicable `AGENTS.md` and any equivalent repository-local instructions before changing code. Follow their scope rules, required documentation updates, validation commands, and commit conventions.
   - If the user provided a PR number or URL, use it; otherwise use `gh pr view --json number,url,baseRefName,headRefName`.
   - Before checkout, ref changes, file edits, or review-thread writes, read [shared stack coordination](references/stack-coordination.md). Run its read-only `lookup` for both the exact PR URL and authenticated head repository/branch; defer on an active registry transaction, read errors, ambiguous membership, a building stack, or another active owner. Do not treat a lookup failure as no stack.
   - If the PR belongs to an existing stack, read `$manage-stacked-prs`. For an unregistered published stack, verify membership and register it under that skill's snapshot before acquiring ownership. Acquire a whole-stack repair token, or claim the coordinator reservation only after verifying this child's actual assignment in the recorded ledger. A matching PR URL alone is insufficient. Complete `$manage-stacked-prs`’s boundary snapshot while holding that token, before any merge or code change; final restacking must use the recorded pre-change inherited boundaries. Retain the coordination ID, root, owner/token, and snapshot path throughout the repair. Reuse that token in `$manage-stacked-prs`; do not acquire a second lock. A direct invocation cannot bypass a build or reservation.
   - A successful lookup with no registered membership does not prove that the PR is standalone: inspect authenticated PR base relationships and available gh-stack state. If stack membership cannot be resolved, report the blocker before mutation. For a verified ordinary PR, retain the ordinary workflow and existing PR/branch ownership checks.
   - Before making repair commits, confirm the worktree is clean with `git status --short`. If it is dirty, stop and ask how to handle the pre-existing changes.
   - If the user provided a PR number or URL, check out the PR branch with `gh pr checkout <pr>` before making commits. Otherwise, assert that the current branch matches the PR `headRefName`; if it does not, stop before changing files.
   - Resolve the bundled helper relative to this `SKILL.md`, not relative to the target repository. Run `node "<skill-directory>/scripts/repair-pr.mjs" status --pr <pr>` to collect merge state, unresolved review threads from `chatgpt-codex-connector[bot]` and `@me`, and failing checks.

2. Resolve merge conflicts first.
   - Treat `mergeStateStatus: DIRTY` or GitHub reporting conflicts as the conflict signal.
   - Fetch the PR base branch and merge it into the PR branch; do not rebase.
   - Identify the correct remote for the PR and merge its remote-tracking base ref. Do not assume the remote is named `origin`.
   - Resolve conflicts using the code, tests, and applicable repository contracts. Do not choose `--ours` or `--theirs` blindly.
   - Run focused verification for the resolved area, then `git add` the intended files and commit the merge or conflict repair before moving on.

3. Apply review feedback.
   - Consider only unresolved, non-outdated review threads with at least one comment authored by `chatgpt-codex-connector[bot]` or the authenticated GitHub user (`@me`). Resolve `@me` from `viewer.login` at runtime; if the account cannot be identified, stop and report the failure.
   - Ignore approvals, resolved threads, outdated threads, duplicates, non-actionable notes, full-review bodies, and threads with no comment from either eligible author.
   - Evaluate each finding against the current diff, applicable contracts, implementation behavior, and tests. Do not assume the review is correct because of its author.
   - Handle each distinct actionable finding independently. Do not combine findings merely because they affect the same behavior or file. If multiple threads are duplicate reports of the same root cause, treat them as one problem.
   - Implement the smallest correct fix for one problem, including any documentation or repository-instruction update required by that fix or its public-contract change.
   - Run focused tests for that problem, then commit it before starting the next problem. One commit may handle multiple review threads only when they are duplicate reports of the same root cause.
   - When a finding is objectively incorrect, do not change correct code to appease it. Record the thread id and report the review's incorrect assumption with concrete evidence in the Codex chat, such as the relevant behavior, invariant, or test. For an incorrect bot finding only, optionally prepare a concise English reply with that evidence for the same inline thread under **Comment policy**; do not merely state that the finding is wrong.
   - Record actionable fixed thread ids separately from incorrect thread ids. Do not resolve either kind until the final push succeeds, if a push is required.
   - Treat uncertain or ambiguous findings as blockers, not as incorrect findings. Leave their threads unresolved and report what evidence or decision is missing. Also leave a thread unresolved when applying its suggestion would cause a regression but the review's premise cannot be conclusively disproved.

4. Fix CI failures.
   - Use `gh pr checks <pr> --json name,state,bucket,link,workflow` to identify failing checks.
   - For GitHub Actions failures, inspect logs with `gh run view <run-id> --log` or job logs from `gh api` when needed.
   - Treat external checks as report-only unless their logs are available through `gh`.
   - Identify each independent root cause. Multiple failing checks caused by the same root cause are one problem; unrelated root causes are separate problems.
   - Fix one root cause, run focused local verification, and commit that fix before starting the next root cause.

5. Finish once.
   - Run the validation required by the repository instructions plus the closest relevant checks for every touched area. Derive commands from the target project instead of assuming a language, package manager, or directory layout.
   - Re-run the bundled helper's `status --pr <pr>` command once for a final summary.
   - For an ordinary PR, if any commits were created, push once with `git push` for the current branch after every repair commit is ready. Do not push intermediate commits or force-push.
   - For a stacked PR, complete `$manage-stacked-prs` before review-thread handling: snapshot inherited boundaries before changes, align affected upper layers, run required final checks, push each changed branch only after all local repair/replay work is ready, and verify remote heads and base chains. Repair commits append without rebasing merely to update trunk. Only upper layers replayed from the lowest changed layer may use explicit expected-SHA leases; if a confirmed necessary lower-layer fix makes the original target part of that upper cascade, preserve its repair commits during replay. This stack-specific rule replaces the ordinary single-branch push count. No repeated target push or whole-stack publication shortcut. If alignment or any required push is incomplete or uncertain, retain the stack token and do not resolve handled findings as completed.
   - Keep the whole-stack token through permitted replies and thread resolution. Acquire/release the short shared catalog token around gh-stack mutations under the coordination reference.
   - After the final push succeeds, or immediately when no push is needed, post only replies permitted by **Comment policy**. For an optional incorrect-bot-finding explanation, use the bundled helper's `reply-thread <thread-id> --body <english-explanation>` command in its original inline thread. Use `--body-file <path>` instead of `--body` when the explanation contains multiline or shell-sensitive text.
   - Resolve every objectively incorrect-finding thread with `resolve-thread <thread-id>` after the final push succeeds, or immediately when no push is needed, regardless of whether an optional reply was omitted, succeeded, or failed. Report a failed or uncertain reply separately without blindly retrying it or skipping resolution.
   - Resolve each actionable fixed thread with `resolve-thread <thread-id>` after the final push succeeds, or immediately when no push is needed. Do not resolve ambiguous, blocked, or otherwise unhandled threads.
   - If a thread resolution fails or its outcome is uncertain, report the thread id and failure or uncertainty in the Codex chat; do not claim that the thread was resolved.
   - Release the stack token only after remote alignment and thread-handling outcomes are reconciled. Report a known thread-write failure accurately without claiming resolution; interrupted or uncertain effects require reconciliation before release.
   - Do not start a monitoring loop or keep polling checks after the final status check.

## Helper

Resolve `<skill-directory>` as the directory containing this `SKILL.md`. The target repository does not need its own copy of the helper.

```bash
node "<skill-directory>/scripts/repair-pr.mjs" status
node "<skill-directory>/scripts/repair-pr.mjs" status --pr 123 --json
node "<skill-directory>/scripts/repair-pr.mjs" resolve-thread PRRT_kwDO...
```

Use `reply-thread` only under **Comment policy**, including optional explanations of objectively incorrect bot findings:

```bash
node "<skill-directory>/scripts/repair-pr.mjs" reply-thread PRRT_kwDO... --body "The review assumes ..., but ..."
node "<skill-directory>/scripts/repair-pr.mjs" reply-thread PRRT_kwDO... --body-file /path/to/reply.md
```

The helper resolves `@me` to the authenticated GitHub account. Status JSON includes both logins in `reviewAuthors`; the legacy `reviewAuthor` field retains the bot login.

The helper is an inventory and review-thread mutation aid. It does not implement code fixes, stage changes, commit, push, or decide whether a review comment is correct.

The separate [stack coordination helper](references/stack-coordination.md) manages local stack ownership and batch scheduling. It does not perform repairs, inventory GitHub, or grant authorization. For stacks, install `manage-stacked-prs` alongside this skill. Reading or editing either helper or skill does not repair PRs or register maintenance.

## Commit And Push Rules

- Create one commit for the merge-conflict repair and one separate commit for every distinct actionable review problem and independent CI root cause that changes files.
- Never combine independent problems in one commit. Duplicate reports of the same root cause are one problem and may share one commit.
- Stage only files that belong to the current problem.
- For an ordinary PR, push exactly once at the end if at least one commit was created. For a stacked PR, defer publication to `$manage-stacked-prs` and push each changed branch once after all local work is ready, using explicit SHA leases only for replayed upper layers.
- If neither repair commits nor required stack-alignment changes were needed, do not create an empty commit and do not push. A target no-op does not waive necessary affected-stack alignment.
