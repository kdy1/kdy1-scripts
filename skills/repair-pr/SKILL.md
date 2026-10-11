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
   - Resolve the bundled helper relative to this `SKILL.md`. Read [repair session commands](references/repair-session.md) and run `node "<skill-directory>/scripts/repair-pr.mjs" preflight --pr <pr> --json` (omit `--pr` for the current branch). This read-only command checks Git/gh/auth, PR identity, remotes, worktrees, pending operations, and stack membership. Reconcile its blockers before mutation; it does not acquire ownership or authorize a checkout.
   - Read the applicable `AGENTS.md` and any equivalent repository-local instructions before changing code. Follow their scope rules, required documentation updates, validation commands, and commit conventions.
   - If the user provided a PR number or URL, use it; otherwise use `gh pr view --json number,url,baseRefName,headRefName`.
   - Before checkout, ref changes, file edits, or review-thread writes, read [shared stack coordination](references/stack-coordination.md). Run its read-only `lookup` for both the exact PR URL and authenticated head repository/branch; defer on an active registry transaction, read errors, ambiguous membership, a building stack, or another active owner. Do not treat a lookup failure as no stack.
   - If the PR belongs to an existing stack, read `$manage-stacked-prs`. For an unregistered published stack, verify membership and register it under that skill's snapshot before acquiring ownership. Acquire a whole-stack repair token, or claim the coordinator reservation only after verifying this child's actual assignment in the recorded ledger. A matching PR URL alone is insufficient. Complete `$manage-stacked-prs`’s boundary snapshot while holding that token, before any merge or code change; final restacking must use the recorded pre-change inherited boundaries. Retain the coordination ID, root, owner/token, and snapshot path throughout the repair. Reuse that token in `$manage-stacked-prs`; do not acquire a second lock. A direct invocation cannot bypass a build or reservation.
   - A successful lookup with no registered membership does not prove that the PR is standalone: inspect authenticated PR base relationships and available gh-stack state. If stack membership cannot be resolved, report the blocker before mutation. For a verified ordinary PR, retain the ordinary workflow and existing PR/branch ownership checks.
   - Preflight requires a clean worktree. If it is dirty, stop and ask how to handle the pre-existing changes. Preserve user-owned worktrees and pending Git operations.
   - If the user provided a PR number or URL, check out the PR branch with `gh pr checkout <pr>` before making commits. Otherwise, assert that the current branch matches the PR `headRefName`; if it does not, stop before changing files.
   - After checkout and, for stacks, token acquisition and the pre-change boundary snapshot, initialize a session outside source with `session init --file <session> --pr <pr>`. Supply `--stack-file <ownership-json>` for a stack; reuse its held owner/token and snapshot. Initialization repeats preflight and rejects pre-existing ahead commits. Run `status --pr <pr>` to collect merge state, relevant unresolved review threads, and failing checks. Preserve incomplete reads as blockers rather than treating them as healthy.

2. Resolve merge conflicts first.
   - Treat `mergeStateStatus: DIRTY` or GitHub reporting conflicts as the conflict signal.
   - Fetch the PR base branch and merge it into the PR branch; do not rebase.
   - Identify the correct remote for the PR and merge its remote-tracking base ref. Do not assume the remote is named `origin`.
   - Resolve conflicts using the code, tests, and applicable repository contracts. Do not choose `--ours` or `--theirs` blindly.
   - Run focused verification for the resolved area, then `git add` the intended files and commit the merge or conflict repair before moving on. Record that problem and its commit/validation with `session record --file <session> --input <record-json>`.

3. Apply review feedback.
   - Consider only unresolved, non-outdated review threads with at least one comment authored by `chatgpt-codex-connector[bot]` or the authenticated GitHub user (`@me`). Resolve `@me` from `viewer.login` at runtime; if the account cannot be identified, stop and report the failure.
   - Ignore approvals, resolved threads, outdated threads, duplicates, non-actionable notes, full-review bodies, and threads with no comment from either eligible author.
   - Evaluate each finding against the current diff, applicable contracts, implementation behavior, and tests. Do not assume the review is correct because of its author.
   - Handle each distinct actionable finding independently. Do not combine findings merely because they affect the same behavior or file. If multiple threads are duplicate reports of the same root cause, treat them as one problem.
   - Implement the smallest correct fix for one problem, including any documentation or repository-instruction update required by that fix or its public-contract change.
   - Run focused tests for that problem, then commit and record it before starting the next problem. Record its commit, validation, evidence, and `fixed` thread IDs with `session record`. One commit may handle multiple review threads only when they are duplicate reports of the same root cause.
   - When a finding is objectively incorrect, do not change correct code to appease it. Record the thread id and report the review's incorrect assumption with concrete evidence in the Codex chat, such as the relevant behavior, invariant, or test. For an incorrect bot finding only, optionally prepare a concise English reply with that evidence for the same inline thread under **Comment policy**; do not merely state that the finding is wrong.
   - Record `fixed`, `incorrect`, and `blocked` dispositions with concrete evidence in the session. An optional incorrect-bot explanation uses `replyBodyFile` containing the English explanation. Do not resolve handled threads until publication is verified, if a push is required.
   - Treat uncertain or ambiguous findings as blockers, not as incorrect findings. Leave their threads unresolved and report what evidence or decision is missing. Also leave a thread unresolved when applying its suggestion would cause a regression but the review's premise cannot be conclusively disproved.

4. Fix CI failures.
   - Use `gh pr checks <pr> --json name,state,bucket,link,workflow` to identify failing checks.
   - Run `ci-logs --session <session> --output-dir <outside-source-directory>` to collect failing current-head Actions logs with repository/head/attempt checks and duplicate log removal. Inspect its per-check results; unavailable logs are not a successful CI result. Use job logs from `gh api` when additional evidence is needed.
   - Treat external checks as report-only unless their logs are available through `gh`.
   - Identify each independent root cause. Multiple failing checks caused by the same root cause are one problem; unrelated root causes are separate problems.
   - Fix one root cause, run focused local verification, then commit and record that fix before starting the next root cause.

5. Finish once.
   - Run the validation required by the repository instructions plus the closest relevant checks for every touched area. Derive commands from the target project instead of assuming a language, package manager, or directory layout.
   - Re-run the bundled helper's `status --pr <pr>` command once for a final summary.
   - Record every required final validation at the final local head, then run `session verify --file <session>`. For an ordinary PR, run `publish --session <session>` after every repair commit is ready. It verifies the recorded commits and destination, performs one normal final push when needed, and rereads the remote head. Do not push intermediate commits or force-push. A verified no-op does not push.
   - For a stacked PR, complete `$manage-stacked-prs` before review-thread handling: snapshot inherited boundaries before changes, align affected upper layers, run required final checks, push each changed branch only after all local repair/replay work is ready, and verify remote heads and base chains. Repair commits append without rebasing merely to update trunk. Only upper layers replayed from the lowest changed layer may use explicit expected-SHA leases; if a confirmed necessary lower-layer fix makes the original target part of that upper cascade, preserve its repair commits during replay. This stack-specific rule replaces the ordinary single-branch push count. No repeated target push or whole-stack publication shortcut. If alignment or any required push is incomplete or uncertain, retain the stack token and do not resolve handled findings as completed.
   - Keep the whole-stack token through permitted replies and thread resolution. Acquire/release the short shared catalog token around gh-stack mutations under the coordination reference.
   - For a stack, record complete per-layer publication results and any replayed repair SHA mapping through `session record`, then record final target validation. Keep the original inherited boundaries and the shared stack token; the helper does not restack or release ownership.
   - Run `finish-threads --session <session>` after publication verification, or immediately for a validated no-op. It rereads PR membership, publication, eligible authors, and, for stacks, remote heads/base chains and ownership. It sends only optional incorrect-bot replies recorded under **Comment policy**, then resolves every `fixed` and `incorrect` thread. It leaves `blocked` findings unresolved. An optional reply failure does not skip resolution.
   - Report each reply/resolution outcome accurately from the command's JSON. A failed or uncertain write is not completion. Reexecution reconciles actual remote state and skips completed writes; it does not blindly retry uncertain writes. Preserve session evidence and follow the reference's interrupted-operation procedure.
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

Use [repair session commands](references/repair-session.md) for preflight, problem/validation records, CI logs, ordinary final publication, and post-publication thread handling. The legacy commands above remain available for scoped manual use; do not use them to bypass publication or ownership gates.

The helper does not implement code fixes, stage changes, commit, decide whether a finding is correct, or group root causes. Its `publish` command handles only verified ordinary PR sessions; stack replay and publication remain owned by `$manage-stacked-prs`. Reading or editing these resources does not authorize a live repair.

The separate [stack coordination helper](references/stack-coordination.md) manages local stack ownership and batch scheduling. It does not perform repairs, inventory GitHub, or grant authorization. For stacks, install `manage-stacked-prs` alongside this skill. Reading or editing either helper or skill does not repair PRs or register maintenance.

## Commit And Push Rules

- Create one commit for the merge-conflict repair and one separate commit for every distinct actionable review problem and independent CI root cause that changes files.
- Never combine independent problems in one commit. Duplicate reports of the same root cause are one problem and may share one commit.
- Stage only files that belong to the current problem.
- For an ordinary PR, push exactly once at the end if at least one commit was created. For a stacked PR, defer publication to `$manage-stacked-prs` and push each changed branch once after all local work is ready, using explicit SHA leases only for replayed upper layers.
- If neither repair commits nor required stack-alignment changes were needed, do not create an empty commit and do not push. A target no-op does not waive necessary affected-stack alignment.
