---
name: repair-pr
description: One-shot GitHub pull request repair workflow for the current or specified repository. Use when asked to repair a PR by resolving merge conflicts, handling unresolved review feedback from chatgpt-codex-connector[bot], explaining incorrect feedback in English, fixing failing CI, pushing once, and resolving handled bot review threads.
---

# Repair PR

## Goal

Repair the current or specified GitHub PR once, then stop. Handle merge conflicts, unresolved review feedback from `chatgpt-codex-connector[bot]`, and CI failures in that order. Correct actionable findings, explain objectively incorrect findings in English in their inline threads, and resolve handled threads. Commit after each coherent repair phase, but push only once after all local changes are complete.

## Workflow

1. Resolve the PR context.
   - Confirm the current directory belongs to a Git repository with a GitHub remote, `gh` and Node.js are installed, and `gh auth status` works.
   - Read the applicable `AGENTS.md` and any equivalent repository-local instructions before changing code. Follow their scope rules, required documentation updates, validation commands, and commit conventions.
   - If the user provided a PR number or URL, use it; otherwise use `gh pr view --json number,url,baseRefName,headRefName`.
   - Before making repair commits, confirm the worktree is clean with `git status --short`. If it is dirty, stop and ask how to handle the pre-existing changes.
   - If the user provided a PR number or URL, check out the PR branch with `gh pr checkout <pr>` before making commits. Otherwise, assert that the current branch matches the PR `headRefName`; if it does not, stop before changing files.
   - Resolve the bundled helper relative to this `SKILL.md`, not relative to the target repository. Run `node "<skill-directory>/scripts/repair-pr.mjs" status --pr <pr>` to collect merge state, unresolved `chatgpt-codex-connector[bot]` review threads, and failing checks.

2. Resolve merge conflicts first.
   - Treat `mergeStateStatus: DIRTY` or GitHub reporting conflicts as the conflict signal.
   - Fetch the PR base branch and merge it into the PR branch; do not rebase.
   - Identify the correct remote for the PR and merge its remote-tracking base ref. Do not assume the remote is named `origin`.
   - Resolve conflicts using the code, tests, and applicable repository contracts. Do not choose `--ours` or `--theirs` blindly.
   - Run focused verification for the resolved area, then `git add` the intended files and commit the merge or conflict repair before moving on.

3. Apply bot review feedback.
   - Consider only unresolved, non-outdated review threads with at least one comment authored by `chatgpt-codex-connector[bot]`.
   - Ignore approvals, resolved threads, outdated threads, duplicates, non-actionable notes, and review threads that do not include `chatgpt-codex-connector[bot]` feedback.
   - Evaluate each finding against the current diff, applicable contracts, implementation behavior, and tests. Do not assume the review is correct merely because the bot authored it.
   - Group related actionable threads by behavior or file, implement the smallest correct fix, and update documentation or repository instructions when the repository requires it or the public contract changed.
   - Run focused tests for each repair group.
   - Commit each coherent review-fix group.
   - When a finding is objectively incorrect, do not change correct code to appease it. Record the thread id and prepare a concise English reply for that same inline thread. Explain the review's incorrect assumption and cite concrete evidence such as the relevant behavior, invariant, or test; do not merely state that the finding is wrong.
   - Record actionable fixed thread ids separately from incorrect thread ids. Do not resolve either kind until the final push succeeds, if a push is required.
   - Treat uncertain or ambiguous findings as blockers, not as incorrect findings. Leave their threads unresolved and report what evidence or decision is missing. Also leave a thread unresolved when applying its suggestion would cause a regression but the review's premise cannot be conclusively disproved.

4. Fix CI failures.
   - Use `gh pr checks <pr> --json name,state,bucket,link,workflow` to identify failing checks.
   - For GitHub Actions failures, inspect logs with `gh run view <run-id> --log` or job logs from `gh api` when needed.
   - Treat external checks as report-only unless their logs are available through `gh`.
   - Fix the observed root cause, run focused local verification, and commit the CI fix.

5. Finish once.
   - Run the validation required by the repository instructions plus the closest relevant checks for every touched area. Derive commands from the target project instead of assuming a language, package manager, or directory layout.
   - Re-run the bundled helper's `status --pr <pr>` command once for a final summary.
   - If any commits were created, push once with `git push` for the current branch. Because this workflow merges instead of rebasing, do not force-push.
   - After the final push succeeds, or immediately when no push is needed, post each prepared incorrect-finding explanation to its original inline thread with the bundled helper's `reply-thread <thread-id> --body <english-explanation>` command. Use `--body-file <path>` instead of `--body` when the explanation contains multiline or shell-sensitive text.
   - Resolve an incorrect-finding thread with `resolve-thread <thread-id>` only after its inline reply succeeds. If the reply fails, leave the thread unresolved and report the failure.
   - Resolve each actionable fixed thread with `resolve-thread <thread-id>` after the final push succeeds, or immediately when no push is needed. Do not resolve ambiguous, blocked, or otherwise unhandled threads.
   - Do not start a monitoring loop or keep polling checks after the final status check.

## Helper

Resolve `<skill-directory>` as the directory containing this `SKILL.md`. The target repository does not need its own copy of the helper.

```bash
node "<skill-directory>/scripts/repair-pr.mjs" status
node "<skill-directory>/scripts/repair-pr.mjs" status --pr 123 --json
node "<skill-directory>/scripts/repair-pr.mjs" reply-thread PRRT_kwDO... --body "The review assumes ..., but ..."
node "<skill-directory>/scripts/repair-pr.mjs" reply-thread PRRT_kwDO... --body-file /path/to/reply.md
node "<skill-directory>/scripts/repair-pr.mjs" resolve-thread PRRT_kwDO...
```

The helper is an inventory and review-thread mutation aid. It does not implement code fixes, stage changes, commit, push, or decide whether a review comment is correct.

## Commit And Push Rules

- Commit after each coherent phase that changes files: merge-conflict repair, review repair group, CI repair group.
- Stage only files that belong to the current repair.
- Push exactly once at the end if at least one commit was created.
- If no local changes were needed, do not create an empty commit and do not push.
