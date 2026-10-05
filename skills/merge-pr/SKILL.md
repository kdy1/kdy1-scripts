---
name: merge-pr
description: "Squash-merge GitHub pull requests with the default commit subject when the user explicitly invokes this skill, requests a merge, or authorizes a handoff within that scope."
---

# Merge PR

Merge the requested PRs and verify each result.

## Authorization

An explicit user invocation of `$merge-pr` is a merge request and authorizes merging the targets identified by the user's request or conversation context. This includes PRs returned by a selection workflow requested in the same message. Do not request confirmation again because the targets came from tool results rather than manually supplied PR numbers.

Automatic skill selection alone does not authorize a merge. A request to edit, inspect, or discuss this skill authorizes that work only. A handoff must retain the original human merge authorization and target scope.

## Core Rules

- Always use `gh pr merge` with `--squash`. Do not substitute merge commits or rebase merges.
- Never specify `--subject` or its short form `-t`, including an empty value. Leave the commit subject to the default `gh` and GitHub behavior. Do not override it interactively or through another merge interface.

See the [GitHub CLI merge documentation](https://cli.github.com/manual/gh_pr_merge) for these options.

## Resolve and Merge

Use the requested PR URLs, numbers, or selection criteria with the repository context. Resolve targets from the request and conversation context, including the complete results of a requested selection workflow. Use those targets even when the checkout has a detached HEAD.

Only when the request and conversation context do not identify targets, resolve the current branch's PR with `gh pr view --json url`. Ask for a target only when neither source identifies the intended PRs or when the requested scope is genuinely ambiguous. Do not ask for merge authorization again after an explicit invocation.

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
