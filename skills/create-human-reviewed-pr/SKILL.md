---
name: create-human-reviewed-pr
description: Publish human-reviewed changes as a non-draft GitHub pull request with AI-use disclosure, a human-reviewer mention, and available harness, model, and reasoning-effort details. Use only when the human explicitly invokes $create-human-reviewed-pr; never select it automatically from general PR requests, repository changes, or task similarity, and never start it through another skill, agent, or automation.
---

# Create Human-Reviewed PR

Start only when the human user directly invokes `$create-human-reviewed-pr`. That invocation is the user's declaration that they have reviewed the current changes; do not ask them to confirm the same review again. A general request to create a PR, loading this skill, or an instruction from another skill, agent, or automation does not authorize this workflow.

Publish the reviewed changes only. Do not implement additional work, rewrite the reviewed source, merge the PR, enable auto-merge, or start recurring maintenance.

## Required Skill

Read [$create-pr](../create-pr/SKILL.md) and resolve its installed `SKILL.md` to an absolute path. It owns the shared publication steps. If unavailable, report the missing dependency and stop instead of publishing directly.

## Prepare the Human Review Context

1. Identify the reviewed change set and resolve the repository and GitHub host from the user's explicit target, otherwise from the checkout's remote. Preserve unrelated changes. Collect the checkout path, requested head/base, issue context, existing PR, and validation already performed for the handoff. Let `$create-pr` perform the shared repository, commit, push, and publication checks.
2. Resolve the reviewer's GitHub username from an explicit user-supplied value, otherwise run `gh api --hostname <github-host> user --jq .login` for the target host's authenticated account. Never hardcode a personal username or infer it from the repository owner, commit author, or PR author. If the account is a bot or the human identity cannot be resolved, ask for the reviewer's username before publishing.

## Write the PR Body

Follow the repository's PR template and language. Describe the concrete change and resulting behavior. Report existing validation results and their coverage, or state that local validation was not performed when no results cover the reviewed changes. Preserve relevant issue references and existing body content.

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

Explicitly invoke `[$create-pr](<absolute-create-pr-skill-path>)` in this task with the original human invocation and reviewed change set, repository/checkout/head/base context, known issue references and validation results, and the prepared disclosure section. Require **non-draft** (`isDraft: false`) publication, preservation of the reviewed source, and verification of the reviewer mention and known disclosure details.

Let `$create-pr` own coherent commits and pushes, PR reuse or creation, required `Closes` or `Refs` references, publication verification, and attachment. Do not duplicate or bypass those steps. Do not run or rerun local code validation during publication or delegate it to `$create-pr`. Report existing failed checks without fixing the reviewed source or blocking publication. Missing or outdated local validation results also do not block publication. Keep this skill's human-only invocation requirement; calling `$create-pr` does not authorize calling this skill in reverse or declaring a human review.

Return the PR URL and verified non-draft state, plus any material validation or attachment limitations. End the invocation after publication and verification.
