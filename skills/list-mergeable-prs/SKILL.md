---
name: list-mergeable-prs
description: List open pull requests in the current GitHub repository whose mergeStateStatus is exactly CLEAN. Use when the user asks which PRs are currently clean or mergeable; this skill only reports them and never changes repository state.
---

# List Mergeable PRs

Report the current repository's open pull requests whose GitHub `mergeStateStatus` is exactly `CLEAN`.

## Workflow

1. Confirm that `gh` is installed and authenticated, the current directory belongs to a Git repository, and `gh repo view --json nameWithOwner,url` resolves a GitHub repository.
2. Enumerate open PR numbers, then fetch each PR individually and filter the
   individual result. Do not request or filter `mergeStateStatus` from
   `gh pr list`: its aggregate results can disagree with a direct PR query.

   Run this read-only Bash query from the repository:

   ```bash
   set -euo pipefail

   open_pr_numbers="$(
     gh pr list --state open --limit 1000 --json number --jq '.[].number'
   )"

   if [[ -n "$open_pr_numbers" ]]; then
     while IFS= read -r pr_number; do
       gh pr view "$pr_number" \
         --json number,title,url,author,headRefName,baseRefName,mergeStateStatus,isDraft,updatedAt \
         --jq 'select(.mergeStateStatus == "CLEAN")'
     done <<< "$open_pr_numbers"
   fi
   ```

3. Treat the newline-delimited JSON objects emitted by the individual
   `gh pr view` calls as authoritative. Do not include other merge states or
   infer mergeability from another field.
4. Report the repository name and result count, followed by a Markdown table containing:
   - linked PR number and title
   - author login
   - base and head branches as `base ← head`
   - update time
5. If the array is empty, explicitly say that the repository has no open PRs whose `mergeStateStatus` is `CLEAN`.

## Failures

- If `gh` is missing, explain that GitHub CLI is required.
- If authentication fails, report it and suggest `gh auth login`.
- If the directory is not a Git repository, ask the user to run the skill from a repository or provide one explicitly.
- If no GitHub remote can be resolved, report that fact and suggest configuring the remote or specifying `--repo OWNER/REPO`.
- If the list query or any individual PR query fails, show the concise error
  and stop. Never present a failed or partial query as an empty or complete
  result.

This skill is read-only. Never merge, close, label, comment on, or otherwise modify a pull request or repository.
