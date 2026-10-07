---
name: create-pr
description: "Publish intended changes as a GitHub pull request with verified Closes references for fully resolved issues and Refs for partial or related work, then attach the result. Use when an authorized task includes PR creation or another skill delegates its PR publishing step."
---

# Create PR

Own the shared PR publishing workflow. Other skills that create PRs must invoke this skill for publication instead of copying its steps or creating PRs directly.

Start for a human request to create a PR, or a publishing handoff within an already human-authorized task. Automatic selection does not authorize publishing from ordinary code changes. Loading, editing, or planning this skill does not start publication. A handoff carries the original human request, delegation context, and intended scope; it does not expand that scope.

Publish the intended changes only. Do not implement additional work or modify source to fix failed checks. End after publication and verification; do not merge, enable auto-merge, or start PR maintenance.

## Required Writing Skill

Read [$write-ste](../write-ste/SKILL.md) and resolve its installed `SKILL.md` to an absolute path. Use it for PR titles and bodies. If unavailable, report the missing dependency and stop before publishing instead of skipping it.

## Invocation and Handoff

Reuse reliable information from the current task. A calling skill supplies the following when known:

- GitHub host and repository, absolute checkout/worktree path, intended change set, head repository/remote/branch, and base branch.
- Exact issue URLs or qualified numbers, distinguishing fully resolved issues from partial or related work.
- Validation commands, actual results, and the revision or changes they covered.
- Existing actual screenshots relevant to the changes, with absolute file paths or verified GitHub attachment URLs, descriptions, and known captured states and revisions.
- Required body content and any disclosure section, requested draft state, and constraints such as preserving human-reviewed source.
- An existing PR URL and the original human authorization and delegation context when applicable.

Resolve missing facts through the checkout and authenticated GitHub reads. Ask only when the intended changes, target, issue identity, or another material decision remains ambiguous. Honor the user's instructions and the calling workflow's applicable constraints. Default to non-draft unless the user or caller requests draft.

## Prepare the Publication

1. Confirm authenticated `gh` access for the resolved GitHub host. Read applicable repository instructions, contribution guidance, and PR templates. Resolve the target from explicit task context, otherwise the checkout's remote. Inspect the intended diff and preserve unrelated changes.
2. Use the requested head and base when provided; otherwise use the current branch and its configured PR base, falling back to the repository's default branch. If a feature branch is needed, follow repository conventions, using `codex/` by default. Confirm the exact head repository, push remote, branch, and base. Do not silently fork or retarget the PR. If there is no intended change against the base, report that and stop.
3. Check an explicitly supplied or recorded PR and search for an open PR with the exact head repository and branch before publishing. Reuse a matching PR. If multiple candidates exist or its base differs from the intended base, clarify rather than duplicating or silently retargeting it. If this workflow's recorded PR is merged or closed, attach it, report its state, and stop without reopening it or creating a replacement.
4. Use only validation results already available from the current task or handoff. Do not run or rerun local tests, builds, linters, or other code validation for PR publication. Existing failures, missing results, or results from an earlier revision do not block publication. Preserve each result's actual status and covered revision; do not report earlier results as validation of changes they do not cover. If no results cover the intended changes, report local validation of those changes as not performed.
5. Commit intended uncommitted changes in coherent units, following repository instructions, and push any required head commits to the confirmed remote. Stage only the intended files. Skip already completed commits or pushes; do not create empty commits or publish unrelated changes.

## Existing Screenshots

- Include relevant actual screenshots already available from the current task or handoff in the PR body. If the handoff omits them, check the task record and known artifact locations. Do not capture new screenshots, launch the app, or run validation solely for PR publication. If no relevant screenshots are available, continue without a screenshot section.
- Inspect available screenshots before selecting them. Generated design previews and mockups are not actual screenshots. Describe the captured state and revision only when known; do not present an earlier or failing state as evidence of the final result. Write descriptions and alt text in the selected PR language.
- Reuse verified GitHub attachment URLs and preserve images already in an existing PR body. Add only missing screenshots; do not upload or embed the same image again. Keep local file paths out of published text. Do not commit screenshots to the repository or publish them to separate hosting just to attach them.
- Confirm that the relevant `gh pr create --help` or `gh pr edit --help` exposes `--attach`. When supported, combine `--body-file` with `--attach '<absolute-file-path>#<descriptive-alt-text>'`, repeating the flag for each missing screenshot. Let the CLI append the uploaded images instead of placing local-file placeholders in the body. If unsupported, use an available authenticated browser's native GitHub attachment flow for the same PR and include its returned Markdown in the body. Do not silently upgrade the CLI or use unofficial upload endpoints. See [GitHub's attachment documentation](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).
- Missing files or unavailable or failed attachment uploads do not block PR publication. Preserve successful attachments and report each omitted screenshot and reason. Follow the write-outcome checks below before retrying; retry only missing attachments when the actual state and failure cause establish a safe next action.

## Write the Title, Body, and Issue References

Use the language explicitly requested by the user for the PR title and body. If the user has not specified a language, follow an explicit repository language requirement; otherwise, use English. Do not infer a language request from the conversation language, existing PR language, or other repository prose.

Explicitly invoke `[$write-ste](<absolute-write-ste-skill-path>)` when drafting or revising the PR title and body. Pass the selected PR language as an explicit instruction to `$write-ste`. Apply it only to the intended PR prose. Preserve the selected language, repository template, required disclosures, exact `Closes` and `Refs` lines, technical literals, factual meaning, uncertainty, and actual validation status.

Write new and revised PR titles in [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) header format: `type(scope)!: description`. The scope is optional. Include `!` immediately before the colon only for a compatibility-breaking change. Choose the type from the primary purpose of the full PR: `feat` for a new feature, `fix` for a bug fix, or an appropriate type such as `docs`, `refactor`, or `chore` for other changes. Follow the repository's allowed types and scope conventions.

Summarize the full intended change set against the PR base in the title. Use existing commit subjects as supporting context; select wording that covers the PR as a whole, including when it contains multiple commits. Keep the description concise and in the selected language. When applying `$write-ste`, preserve the type, optional scope, breaking-change marker, and colon-space separator.

Follow the repository's template and preserve its required fixed text. Write new or revised body prose in the selected language. Lead with the concrete problem and resulting behavior. Report existing validation results and their coverage, or state that local validation was not performed when no results cover the intended changes. Incorporate the caller's required body content. For an existing PR, preserve unrelated content and update equivalent sections rather than duplicating them. Preserve supplied disclosures and known execution details without inventing missing facts.

Determine issue identity and completion from the human request, authorized handoff, task history, issue requirements, and intended changes. Verify the referenced GitHub issues and their repositories; do not guess an issue number from a branch name or invent an issue for unrelated work. If the task fixes or relates to an issue but its identity cannot be determined, resolve it before publishing.

For **every fully resolved issue**, put a standalone closing line in the **PR body**, outside code fences:

```markdown
Closes #123
Closes #456
Closes owner/other-repo#789
```

Use `Closes #123` for an issue in the PR's repository and `Closes owner/repo#123` for another repository. Repeat the full syntax on a separate line for each issue. A title reference, plain link, comment, commit message, `Refs`, `Fixes`, or `Resolves` is not a substitute for the required `Closes` line. Do not duplicate an existing correct line.

For **every issue partially addressed or otherwise related to the changes**, use a standalone non-closing reference in the PR body instead:

```markdown
Refs #234
Refs owner/other-repo#567
```

Use the same repository qualification rules as for `Closes`, with a separate line for each issue. Choose `Closes` when fully resolved and `Refs` otherwise; do not retain both standalone kinds for the same issue. A PR may contain both kinds for different issues. Do not add references when no associated issue exists.

Preserve existing issue references in body edits and avoid duplicate lines. When an issue's verified completion changes, replace its existing standalone line with the appropriate `Closes` or `Refs` line, preserving other references and unrelated content. Correct a confirmed closing reference that would incorrectly close a partially resolved issue; if its scope or completion is unclear, resolve that ambiguity before publishing.

Closing keywords are interpreted by GitHub only when the PR targets the repository's default branch; `Refs` does not close issues. Honor an explicitly requested base and report that automatic closure will not occur for a different base; do not silently change it. See [GitHub's closing-reference documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

## Publish, Verify, and Return

1. Recheck for a matching PR immediately before creation. Write the exact body to a temporary file and use `--body-file`. Create with `gh pr create` and explicit `--repo`, `--base`, `--head`, and `--title`, adding `--draft` only when requested. For a matching existing PR, use `gh pr edit` with explicit `--title` and `--body-file`; when its draft state differs from the requested state, use `gh pr ready` for non-draft or `gh pr ready --undo` for draft instead of creating another PR. Include missing screenshots using the procedure above.
2. If a write fails or its outcome is uncertain, re-fetch the PR or query matching PRs before retrying. Attachment uploads can partially fail while the PR is still created or updated and the CLI returns a non-zero exit. Verify the PR body and successful attachments before any further write; preserve their URLs in subsequent body edits. Continue only when the actual state and failure cause establish a safe next action; otherwise report the uncertainty and stop. Never blindly retry creation.
3. Re-fetch the published PR and verify its repository, exact head repository and branch, base, draft state, exact prepared title and its Conventional Commits format, the selected language for new or revised title and body prose, required body content, and every required standalone `Closes` or `Refs` line with the correct completion classification. Verify that included screenshots use actual GitHub attachment URLs with the intended descriptions, without local-file references or duplicate images. Account for every selected screenshot as attached or omitted with a reported reason. For human-reviewed publication, also verify the caller's reviewer mention and disclosure details. Correct omissions or mismatches introduced by this invocation, preserve unrelated content, existing attachments, and issue references, and verify again before reporting success. Optional screenshot failures retain the text-only publication outcome described above.
4. In the Codex app, attach each created or updated PR to this chat with `attach_artifact`. Report an unavailable or failed attachment separately from the verified GitHub result; do not create another PR to compensate.
5. Return the PR URL and verified state, issue references, checkout path and head branch, and any material limitations, including omitted screenshots and their reasons. Report existing local validation results and their coverage, or state that local validation was not performed. Distinguish local validation from pending or unperformed CI and review. Leave the checkout available for review and return control to the calling skill.
