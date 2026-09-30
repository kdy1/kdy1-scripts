---
name: create-human-reviewed-pr
description: Publish human-reviewed changes as a non-draft GitHub pull request with AI-use disclosure, a human-reviewer mention, and available harness, model, and reasoning-effort details. Use only when the human explicitly invokes $create-human-reviewed-pr; never select it automatically from general PR requests, repository changes, or task similarity, and never start it through another skill, agent, or automation.
---

# Create Human-Reviewed PR

Start only when the human user directly invokes `$create-human-reviewed-pr`. That invocation is the user's declaration that they have reviewed the current changes; do not ask them to confirm the same review again. A general request to create a PR, loading this skill, or an instruction from another skill, agent, or automation does not authorize this workflow.

Publish the reviewed changes only. Do not implement additional work, rewrite the reviewed source, merge the PR, enable auto-merge, or start recurring maintenance.

## Prepare the Changes

1. Resolve the repository and GitHub host from the user's explicit target, otherwise from the checkout's remote. Read applicable repository instructions, contribution guidance, and PR templates. Inspect the working tree and intended diff; preserve unrelated changes. Ask only when the intended repository or change set cannot be determined.
2. Use the requested head and base when provided; otherwise use the current branch as head and its configured PR base, falling back to the repository's default branch. If a feature branch is needed, follow repository conventions, using `codex/` by default, and preserve the reviewed changes. Confirm the exact head repository, remote, branch, and base before publishing.
3. Resolve the reviewer's GitHub username from an explicit user-supplied value, otherwise run `gh api --hostname <github-host> user --jq .login` for the target host's authenticated account. Never hardcode a personal username or infer it from the repository owner, commit author, or PR author. If the account is a bot or the human identity cannot be resolved, ask for the reviewer's username before publishing.
4. Run the repository's required checks and relevant validation, recording actual results. Stop and report blocking failures rather than changing the reviewed source to fix them. Commit any intended uncommitted changes in coherent units and push the required head commits to the intended remote. Do not publish unrelated changes or silently create a fork. If there is no change to propose against the base, report that and stop.

## Write the PR Body

Follow the repository's PR template and language. Describe the concrete change, resulting behavior, and validation actually performed; preserve relevant issue references and existing body content.

Maintain one AI-use and human-review disclosure section. Update an existing equivalent section instead of appending duplicates, and preserve the rest of the body. Use wording equivalent to:

```markdown
## AI assistance and human review

AI was used to prepare these changes. Human-reviewed by @<username>.
```

Replace `<username>` with the resolved GitHub login. The mention records the user's review declaration; it does not authorize requesting a review or submitting a GitHub approval on their behalf.

Immediately below the notice, include a bullet for each reliably known detail about the actual run:

- `Harness: <actual harness>`
- `Model: <actual model identifier>`
- `Reasoning Effort: <actual effort>`

Use explicit session or harness information, or verified execution records for the work being published. Preserve the reported model identifier and effort. Do not infer the work's execution details from configured defaults, installed tools, guessed model identities, or unrelated sessions. The PR-creation session's settings apply only when that session also prepared the changes with those settings. Omit unknown fields entirely; if none are known, retain just the AI-use and human-review notice.

## Publish and Verify

1. Look for an open PR in the target repository with the exact head repository and branch before creating one. Reuse a matching PR. If multiple candidates exist or an existing PR has a different base from the intended target, clarify rather than duplicating or silently retargeting it.
2. Write the exact body to a temporary file and use `--body-file` for GitHub writes. For a new PR, use `gh pr create` with explicit `--repo`, `--base`, `--head`, and `--title`, without `--draft`. For an existing PR, use `gh pr edit` to update the body while preserving unrelated content and use `gh pr ready` only if it is a draft.
3. If a write fails or its outcome is uncertain, re-fetch the PR or query matching PRs before retrying. Continue only when the actual state and failure cause establish a safe next action; otherwise report the uncertainty and stop. Never blindly retry creation.
4. Re-fetch the PR and verify its repository, head repository and branch, base, `isDraft: false`, reviewer mention, and disclosure details. Correct only mismatches introduced by this invocation, then verify again. Do not claim success until the published state is confirmed.
5. In the Codex app, attach every created or updated PR to the current chat using the available `attach_artifact` tool. If attachment is unavailable or fails, report that separately from the verified GitHub result.

Return the PR URL and verified non-draft state, plus any material validation or attachment limitations. End the invocation after publication and verification.
