---
name: manage-stacked-prs
description: "Modify existing GitHub stacked PRs and restack and verify affected upper layers with gh stack. Apply when editing a PR in an existing stack or repairing its alignment. Preserve unrelated lower PRs; fix a lower layer only when its confirmed defect blocks the requested work. Stack creation and merging remain separate workflows."
---

# Manage Stacked PRs

Complete the requested change and leave its affected stack aligned on GitHub. A local edit or target-only push is not completion when upper layers still need restacking.

Apply alongside the workflow that owns the requested code change. This skill owns stack scope, history alignment, scoped push, and verification. It does not start stack creation, merging, unrelated repairs, comments, reviews, or monitoring. Reading or editing this skill does not authorize changes to a live stack. Honor explicit local-only, read-only, and narrower scope instructions; report any resulting alignment work as unfinished.

## Establish the stack and boundaries

1. Read repository instructions. Resolve the target PR from the human request or task context, otherwise the current branch's PR. Use authenticated GitHub reads and `gh stack view --json` to confirm the host, repository, exact head repository, push remote, ordered membership, PR states, and base relationships. Resolve ambiguous identities or membership before changing history; do not infer order from PR numbers or branch names.
2. Before checkout/ref changes or code edits, read [$repair-pr's shared stack coordination](../repair-pr/references/stack-coordination.md) and resolve its installed helper. Look up the exact PR and head repository/branch. Defer on lookup errors, an active registry transaction, a building stack, uncertain membership, or another owner. For a verified published but unregistered stack, register its full ordered membership with `--published` using this task's snapshot path as the ledger. Acquire the whole-stack edit token, or reuse the enclosing repair or merge coordinator's owner/token after verifying it against current registry state. A nested invocation must not release its caller's token. The helper requires `repair-pr` to be installed; do not proceed unlocked when unavailable.
   Inspect Git status, `git worktree list --porcelain`, and pending Git or gh-stack operations. Preserve pre-existing changes and use clean appropriate worktrees. Do not steal another checkout's branch or automatically stash its changes. Keep affected worktrees idle during history changes: gh-stack metadata is shared, and its locks do not coordinate arbitrary Git writes.
3. Before edits, record the task and a snapshot outside tracked source. For delegated post-merge alignment, preserve the caller's pre-merge inherited boundaries instead of deriving them from already changed parent refs. Include every layer's PR URL, head repository/branch, local and remote head SHAs, base name, and body, plus the trunk and immediate parent SHAs. Record each child's verified inherited old parent boundary using stack metadata and Git ancestry. A stale child's boundary can differ from its parent's current tip; do not substitute that tip blindly. Retain the snapshot path and update progress, commits, scope expansions, and push outcomes for continuation.
4. Compare the target against its immediate parent, not the default branch. Separate its own changes from inherited work. Record existing alignment problems without adopting unrelated repairs.

On continuation or re-invocation of the same task, reconcile the existing snapshot and actual local/remote state before new edits. Preserve original inherited boundaries, skip already completed work, and update expected SHAs only after accounting for previous writes and concurrent changes.

Keep two distinct sets:

- **Code-change scope:** the requested PRs, initially the target PR only.
- **Restack scope:** those layers and upper descendants whose parent history changes or whose alignment is part of the request. Upper layers receive only history replay and necessary conflict resolution unless also in code-change scope.

The lowest changed layer anchors the cascade. Its unchanged parent and unrelated lower layers stay outside mutation scope. Preserve out-of-scope local/remote tips and PR bases and bodies. A PR's base SHA can advance naturally when its parent changes; this alone does not require metadata edits.

## Make the requested change

- Implement and validate under repository requirements. Stage intended files only and commit coherent changes. Keep target changes in the target layer.
- Ignore lower-layer findings that do not block the requested behavior or required validation. Do not clean up lower PRs, repair unrelated CI, or update them to the latest trunk for restacking.
- If evidence confirms a lower-layer defect blocks this task, record the causal evidence and add that PR to code-change scope. Fix the cause minimally in its own layer; do not duplicate the fix in the target. Do not request confirmation again solely because the necessary fix is lower in the stack. Explicit human scope restrictions still apply. Propagate the fix through intervening layers before continuing target work; anchor the final cascade at the lowest layer actually changed.
- Do not improve upper-layer features during replay. Resolve conflicts when contracts, tests, and intended changes establish the result. If a new product decision is required, pause and report the conflict, affected PR, and missing decision.

## Restack before finishing

Hold the whole-stack token throughout edits, replay, pushes, and remote verification. Acquire the short shared catalog token before any gh-stack mutation or recovery; verify the selected stack and release it after the operation has a known outcome. Do not hold the catalog token across tests or remote CI waits. Different stacks may repair concurrently; catalog mutations remain serialized. Keep an interrupted catalog operation protected until reconciled.

Inspect installed `gh stack rebase --help` and relevant command behavior. Prefer gh-stack when it supports the exact scope and verified inherited boundaries. Consult the [official gh-stack documentation](https://github.com/github/gh-stack) for version-specific details; do not silently install or upgrade it.

```sh
gh stack rebase <lowest-changed-branch> --upstack --no-trunk
```

Use this only when its selected range matches the affected layers and preserves their intended commits. Do not drop either scope flag: `--no-trunk` prevents incidental trunk updates. When no replay is needed, proceed to verification.

If the installed command cannot preserve the required range or commit boundaries, use Git on affected branches only, from lower to upper in their clean owning worktrees:

```sh
git rebase --onto <new-parent-sha> <old-inherited-parent-sha> <child-branch>
```

Replay each child's own commits using the snapshot's old inherited boundary, not a parent ref that has already moved. Preserve intentional merge topology. If the boundary is uncertain, stop before replaying rather than duplicate or drop prerequisites. Keep gh-stack tracking consistent through supported commands; do not manually edit its catalog or recovery journals.

For alignment explicitly delegated after a parent squash merge, reuse the enclosing merge coordinator's stack owner/token. Verify that the selected repository base contains the recorded squash commit, retarget the lowest remaining open layer to that base, and use the pre-merge inherited boundary to exclude the already-squashed parent commits. Replay higher descendants onto their new immediate parents. This delegation authorizes alignment only; the coordinator owns further merges and review/CI gates. Return remote alignment and validation results without releasing the caller's token.

After a conflict or interruption, inspect the owning worktree and recovery state. Resume or abort through the matching Git or gh-stack recovery flow before another operation. Confirm what an abort restores; do not reset away completed task commits. Do not rewrite merged or queued PRs; report a blocker if their state prevents the planned cascade.

Do not use whole-stack `rebase`, `gh stack sync`, `gh stack push`, or `gh stack submit` as default completion shortcuts, including when suggested by CLI output. They can act beyond scope, update trunk, or change publication state.

## Push only changed branches

1. Verify local alignment and per-layer diffs before pushing. Run required checks and focused validation for code changes and conflict resolutions; tie results to covered revisions.
2. Re-read remote heads and PR identities before writes. If a head differs from its recorded expected SHA, inspect and reconcile the concurrent change without discarding anyone's work. Never refresh a lease merely to make a rejected push succeed.
3. Push only branches whose intended local heads differ from verified remote heads. Use explicit refspecs and the confirmed head repository's remote. For rewritten history use an explicit SHA lease:

   ```sh
   git push <remote> --force-with-lease=refs/heads/<branch>:<expected-remote-sha> <new-head-sha>:refs/heads/<branch>
   ```

   Use a normal explicit push for a verified fast-forward. Push from lower to upper. Do not use bare `--force`, wildcard refspecs, `--all`, or include unrelated locally ahead branches.
4. After a failed or uncertain push, re-read remote state. Record branches already updated and resume only outstanding writes when the failure cause establishes a safe next step. Do not replay completed rebases or blindly retry the whole range.

Preserve existing PR bases and bodies when the chain is correct. If an affected PR's base must change to restore the requested chain, change only that base and verify it. An out-of-scope mismatch is a reported limitation, not permission to retarget the entire stack. Restacking alone does not require body edits or new PRs.

## Verify and report

Re-fetch GitHub state and inspect `gh stack view --json`. Confirm:

- Each pushed PR has the expected exact remote head SHA and head repository; affected PR bases form the intended chain.
- Each affected open child contains its updated parent's tip (`git merge-base --is-ancestor`). Its diff against that parent retains only intended layer changes. Compare old and new commit ranges as appropriate to detect dropped, duplicated, or accidentally moved work.
- Out-of-scope local/remote tips, PR base names, and bodies match the initial snapshot. Distinguish concurrent changes by others from this run's effects; do not undo their work to satisfy the snapshot.
- Required validation covers final changes. Report pending or unperformed CI accurately without starting a monitoring loop.

When invoked by `$repair-pr`, finish all local work before scoped final pushes. Append repair commits without incidental trunk rebases; replay and explicit SHA leases apply only to upper layers relative to the lowest changed layer, including the original target when a confirmed necessary lower-layer fix requires that cascade. Return alignment and push results to `$repair-pr` without releasing the shared stack token; it owns subsequent review-thread handling. When this is a standalone stack-edit task without an enclosing repair or merge owner, release your own token after verification and result reconciliation. Keep uncertain or interrupted operations locked for the documented recovery flow.

Report PRs with code changes separately from those only restacked. Explain necessary lower-layer fixes and give verified alignment/push outcomes, validation coverage, and remaining blockers. Do not claim completion when an affected layer is stale, a push failed, or remote verification is unavailable. Retain enough state to continue from the actual outcome.
