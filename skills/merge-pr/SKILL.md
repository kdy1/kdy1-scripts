---
name: merge-pr
description: "Merge an authorized GitHub pull request with squash merge and the default commit subject. Use when a task includes an authorized PR merge request or a handoff within that scope."
---

# Merge PR

Merge the requested PR and verify the result. Automatic selection does not authorize a merge. Start only for a human merge request or a handoff that retains the original human authorization and target. Loading, editing, or planning this skill does not start a merge.

## Core Rules

- Always use `gh pr merge` with `--squash`. Do not substitute merge commits or rebase merges.
- Never specify `--subject` or its short form `-t`, including an empty value. Leave the commit subject to the default `gh` and GitHub behavior. Do not override it interactively or through another merge interface.

See the [GitHub CLI merge documentation](https://cli.github.com/manual/gh_pr_merge) for these options.

## Resolve and Merge

Use the requested PR URL or number with the repository context. If the target is omitted, resolve the current branch's PR with `gh pr view --json url`. Ask only when the target or authorized scope remains ambiguous.

Once the target is identified, attempt the merge immediately. Do not preflight authentication, CI, reviews, draft status, conflicts, squash support, merge queues, or head SHAs. Let GitHub enforce its merge requirements. Do not announce plans to check readiness.

```sh
gh pr merge <PR_URL> --squash
```

An explicit PR number can replace `<PR_URL>`. Omit `--auto`, `--admin`, and `--delete-branch` by default. Do not fix source, change PR metadata, submit approvals, or bypass rules to make the merge succeed. Additional actions require applicable human instructions. The two core rules still apply.

For multiple authorized PRs, attempt them sequentially in the requested order, or the supplied list order when no separate order is specified. Continue to the remaining PRs after an individual failure.

## Verify and Report

After each attempt, fetch the PR's URL, state, `mergedAt`, and `mergeCommit`. Report success only when GitHub confirms the PR is merged, and return its URL and merge commit SHA. Report an unavailable commit SHA or unreadable state as unverified.

If `gh` adds the PR to a merge queue or enables auto-merge under the repository's queue rules, report that result without claiming the PR has merged. Do not block the attempt because a queue applies or add `--admin` to bypass it.

If the command fails, report the GitHub or CLI error briefly along with any verified outcome. Do not retry automatically or start a merge-readiness investigation. Keep the final report concise.
