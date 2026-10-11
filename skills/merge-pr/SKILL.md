---
name: merge-pr
description: "Squash-merge GitHub pull requests immediately or enable auto-merge with the default commit subject when the user explicitly invokes this skill, requests a merge, or authorizes a handoff within that scope."
---

# Merge PR

Merge the requested PRs immediately when possible, or enable auto-merge, and verify each result.

## Authorization

An explicit user invocation of `$merge-pr` is a merge request and authorizes merging the targets identified by the user's request or conversation context. This authorization includes enabling auto-merge for those targets when immediate merging is unavailable. The authorized targets include PRs returned by a selection workflow requested in the same message. Do not request confirmation again because the targets came from tool results rather than manually supplied PR numbers.

Automatic skill selection alone does not authorize merging or enabling auto-merge. A request to edit, inspect, or discuss this skill authorizes that work only. A handoff must retain the original human merge authorization and target scope.

## Core Rules

- Always use `gh pr merge` with `--squash`. Do not substitute merge commits or rebase merges.
- Never specify `--subject` or its short form `-t`, including an empty value. Leave the commit subject to the default `gh` and GitHub behavior. Do not override it interactively or through another merge interface.

See the [GitHub CLI merge documentation](https://cli.github.com/manual/gh_pr_merge) for these options.

## Resolve and Merge

Use the requested PR URLs, numbers, or selection criteria with the repository context. Resolve targets from the request and conversation context, including the complete results of a requested selection workflow. Use those targets even when the checkout has a detached HEAD.

Only when the request and conversation context do not identify targets, resolve the current branch's PR with the helper:

```sh
node <SKILL_DIR>/scripts/merge-pr.mjs resolve-current
```

Use the returned `url`. A lookup failure does not select another target. Ask for a target only when neither source identifies the intended PRs or when the requested scope is genuinely ambiguous. Do not ask for merge authorization again after an explicit invocation. Replace `<SKILL_DIR>` with this skill's absolute directory when running commands.

For an explicitly authorized workflow handoff with merge gates, honor its narrower constraints: let the caller own readiness checks, pass its verified head through `--match-head-commit SHA`, and pass `--no-auto` when auto-merge is forbidden. Either option restricts the helper to one target. Return after the single requested layer. The caller owns dependent-stack progression and stops on failure or any pending/unverified result instead of advancing to an upper PR. These constraints do not change the default direct-invocation behavior below.

Once the target is identified for a direct invocation, attempt the merge immediately. Do not preflight authentication, CI, reviews, draft status, conflicts, squash support, merge queues, or head SHAs. Let GitHub enforce its merge requirements. Do not announce plans to check readiness.

```sh
node <SKILL_DIR>/scripts/merge-pr.mjs merge <PR_URL> [<PR_URL>...]
```

An explicit PR number can replace `<PR_URL>`; use the repository checkout or pass `--repo [HOST/]OWNER/REPO`. The helper runs `gh pr merge` with `--squash --auto` by default, omits `--auto` with `--no-auto`, and never passes a subject, administrator bypass, or branch-deletion option. It accepts no arbitrary `gh` options. The head option requires a full 40-character SHA. Do not fix source, change PR metadata, submit approvals, or bypass rules to make the merge succeed. Additional actions require applicable human instructions. The two core rules still apply.

For multiple directly requested PRs without dependent-stack handoff constraints, pass them in the requested order, or the supplied list order when no separate order is specified. The helper attempts them sequentially and continues after an individual failure.

## Verify and Report

The helper fetches `url,state,mergedAt,mergeCommit,autoMergeRequest` after each attempt, even when the merge command fails. Its JSON `results` preserve the input `target`, URL, `outcome`, `mergeCommitSha`, PR state, merge command exit code and output, and verification output/error.

- `merged`: GitHub confirms merged state and a merge commit SHA. Report completion with its URL and SHA.
- `queued`: GitHub confirms open state and the CLI explicitly confirms queue registration. Report queued and pending.
- `auto_merge_pending`: GitHub confirms open state with non-null `autoMergeRequest`. Report auto-merge enabled and pending.
- `unverified`: State, commit SHA, or the outcome cannot be confirmed. Report the verification error and any known state.

Queue eligibility or a promise to add the PR when ready does not confirm registration. Unknown or suppressed CLI output does not establish a queued result. Pending outcomes are not completed merges. Do not block the attempt because a queue applies or add `--admin` to bypass it.

Exit code 1 means a merge command failed or a result is unverified; inspect every result even on that exit code. Exit code 0 can include pending outcomes. If the command fails, including when auto-merge is disabled or permissions are insufficient, report the GitHub or CLI error briefly along with any verified outcome. The helper does not retry; do not rerun it automatically or start a merge-readiness investigation. Keep the final report concise.
