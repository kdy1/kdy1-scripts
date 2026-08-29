---
name: list-mergeable-prs
description: List open pull requests in the current GitHub repository whose mergeStateStatus is exactly CLEAN. Use when the user asks which PRs are currently clean or mergeable; this skill only reports them and never changes repository state.
---

# List Mergeable PRs

Report the current repository's open pull requests whose GitHub `mergeStateStatus` is exactly `CLEAN`.

## Workflow

1. Confirm that `gh` is installed and authenticated, the current directory belongs to a Git repository, and `gh repo view --json nameWithOwner,url` resolves a GitHub repository.
2. Run this read-only query from the repository:

   ```bash
   gh pr list --state open --limit 1000 \
     --json number,title,url,author,headRefName,baseRefName,mergeStateStatus,isDraft,updatedAt \
     --jq 'map(select(.mergeStateStatus == "CLEAN"))'
   ```

3. Treat the returned JSON array as authoritative. Do not include other merge states or infer mergeability from another field.
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
- If the query fails, show the concise error and stop. Never present a failed query as an empty result.

This skill is read-only. Never merge, close, label, comment on, or otherwise modify a pull request or repository.
