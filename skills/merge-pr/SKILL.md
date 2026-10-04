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

## Resolve and Check the PR

1. Read applicable repository instructions and confirm authenticated `gh` access for the target GitHub host. Resolve an explicit PR URL or number from the request and repository context. If the target is omitted, read the current branch's PR with `gh pr view`. Ask when the target or authorized scope remains ambiguous; do not choose an unrelated PR.
2. Read the resolved PR's URL, repository, base branch, head branch and SHA, state, draft state, mergeability, required checks, and required reviews. If it is already merged, report that state and its merge commit SHA, then stop. If it is closed without merging, report that state and stop.
3. Confirm that the repository allows squash merging and determine whether the PR requires or is already in a merge queue. Use authenticated GitHub reads; `gh pr view` alone does not expose queue status. The GraphQL PR fields `isMergeQueueEnabled` and `isInMergeQueue` provide this information. If a queue applies, report the requirement or queued state and stop before running the merge command. A queue can select the merge strategy and enable auto-merge even without `--auto`.
4. Confirm the current head meets the repository's merge requirements. Stop and report pending or failed required CI, missing required approvals, requested changes that block merging, draft status, conflicts, or other blocking rules. Distinguish required checks from optional checks. If readiness or squash support cannot be established, report the uncertainty and stop.

Check queue fields in the [GitHub GraphQL PR reference](https://docs.github.com/en/graphql/reference/pulls#pullrequest). Honor repository requirements without fixing source, changing PR metadata, submitting approvals, or bypassing rules as part of this skill.

## Merge and Verify

Use the resolved URL and the remote head SHA checked above:

```sh
gh pr merge <PR_URL> --squash --match-head-commit <SHA>
```

Omit `--auto`, `--admin`, and `--delete-branch` by default. A blocked immediate merge ends with a report; it does not trigger auto-merge or an administrator bypass. Additional actions require applicable human instructions. The two core rules still apply.

After execution, re-fetch the PR's state, `mergedAt`, and `mergeCommit`. Report success only when GitHub confirms the PR is merged. Return its URL and merge commit SHA. If the PR remains open or queued, report the actual state instead of claiming it merged. Report an unavailable commit SHA as unverified.

If the command fails or the outcome is uncertain, re-fetch the PR before considering a retry. Do not repeat a merge that already succeeded. If it remains open, continue only when its actual state and the failure cause establish a safe retry within the original authorization. Recheck the current head and merge requirements, and use the newly verified SHA; a head mismatch does not authorize blindly accepting a new revision. Otherwise, report the blocker or uncertainty and stop.
