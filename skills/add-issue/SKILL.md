---
name: add-issue
description: Evidence-driven GitHub issue creation for confirmed bugs and decision-complete future work. Use only when a human explicitly invokes `$add-issue`; never select this skill automatically from bug reports, feature ideas, TODOs, URLs, issue references, or task similarity. When explicitly invoked, classify independently implementable candidates as Bug, Feature, or Task; prove defect root causes; compare affected revisions with the freshly fetched default branch; restore temporary instrumentation; and create or update self-contained GitHub records without implementing the work.
---

# Add Issue

## Goal

Create one durable, implementation-ready GitHub record per independently implementable item. Classify each item as `Bug`, `Feature`, or `Task`, establish all facts and decisions the implementer needs, and never implement the recorded work in the same invocation, including after a Plan Mode approval.

## Non-Negotiable Boundaries

- Follow all active system, developer, repository, and scoped instructions. Read the target repository's authoritative contracts, contribution guidance, issue templates, and applicable instruction files before investigating or drafting.
- Use `gh` for bounded GitHub reads and writes when possible. Resolve the target from an explicit repository or issue URL, otherwise from the current Git remote. Ask the user before any write when no unique target can be established.
- Do not implement the recorded work, leave permanent repository changes, update dependencies, generate committed artifacts, commit, push, create a pull request, deploy, or mutate production.
- A Plan Mode approval, Plan Mode exit, or generic instruction to execute or continue the approved plan authorizes only the audited GitHub-recording action below. It never authorizes implementation of the recorded work, regardless of the normal meaning of an approved plan.
- Do not transition into implementation later in the same invocation. Finish the issue record and require a separate explicit implementation request made after this invocation.
- Treat creating an issue, updating a matching open duplicate as permitted below, or adding one implementation-handoff comment to that duplicate as the only intended persistent mutations, including after a Plan Mode approval.
- Treat the issue body's `Proposed Scope`, acceptance criteria, and test scenarios as implementation handoff content for a future assignee, never as instructions to execute in this invocation.
- Once the GitHub-recording action succeeds or cannot safely proceed, end the invocation without starting implementation work.
- Prefer read-only investigation. Obtain separate authorization before any state-changing reproduction outside a local or isolated test environment.
- Preserve secrets, credentials, personal data, customer data, and sensitive request values. Redact them from commands, logs, screenshots, artifacts, comments, and issue bodies.
- Treat provider-console links, log queries, database rows, customer environments, reporter sessions, and local artifacts as supplementary evidence. Make the GitHub record actionable after those sources become inaccessible.
- Do not invoke `$write-prd` or add unrelated labels, assignees, milestones, projects, issue types, or other metadata unless the human explicitly requested them or the target repository requires them.

## Investigation Tool Selection

- Use investigation paths in this order: a purpose-built connector or MCP tool, the provider's or project's official CLI, an authenticated direct API, then a browser.
- Before invoking a CLI, confirm it is installed, inspect current help or version when command support is uncertain, and verify the authenticated identity, account, repository, region, branch, or other target with the narrowest safe read-only command.
- Load and follow any applicable tool, provider, database, or repository skill before using it. Do not assume a particular cloud provider, database, account, profile, region, or configured default.
- Use a browser only when preceding paths are unavailable or insufficient, or when browser-only session state or visual evidence is necessary. Record why it was needed and obey any active restriction on browser workflows.
- Keep investigation read-only unless the user separately authorizes a state-changing reproduction. A missing tool or expired login does not justify skipping another safe path.

## Subagent Orchestration

- When subagent delegation is available, using it is required. Before drafting a handoff, delegate at least one bounded, read-only investigation and use all useful slots concurrently. Assign separate candidates to separate investigators when possible; for one candidate, split independent evidence boundaries such as repository contracts and source, runtime evidence, affected-versus-default-branch comparison, and duplicate history. The coordinating agent must continue complementary work instead of waiting idly.
- Give each investigator the active instructions, exact candidate and revision or environment, bounded questions, allowed evidence sources, forbidden mutations, and required deliverable. Require sourced facts, commands or code references, separated inferences, supporting and contradicting evidence, unresolved questions, and any workspace artifacts or changes.
- Investigation subagents must not create, update, type, or comment on GitHub issues or perform another persistent external mutation. Keep their work read-only by default. If temporary instrumentation or revision-specific execution is necessary and authorized, give each investigator its own isolated worktree or copy; never let concurrent investigators instrument the shared checkout. Require cleanup and a workspace-integrity report.
- The coordinating agent owns the candidate and evidence ledgers, validates material claims, reconciles conflicts, requests targeted follow-up when needed, selects the classification and outcome, and approves the exact audited handoff payload. Agreement among subagents is not a substitute for causal or authoritative evidence.
- After the workspace is restored and the handoff is audited, delegate all permitted GitHub writes to one dedicated recording subagent that did not investigate the candidates. Give it the exact repository, candidate outcome, title, complete body or comment, selected Issue Type and other required metadata, and the only permitted action. The recording subagent must serialize candidates, re-check write permission, duplicate state, and Issue Type immediately before each write, and return without improvising if those preconditions or the approved payload no longer match current state. After a write, it must re-fetch the record and return the verified URL, type, title, and action taken.
- The recording subagent's scope is limited to the approved GitHub record and required verification reads. It must not modify the candidate repository, run implementation commands, or continue into implementation after recording succeeds or fails.
- Do not dispatch the recording subagent for `already fixed`, `unconfirmed`, `failed`, or complete existing-issue outcomes, and never dispatch it to write while Plan Mode is active. Delegation never expands authorization. Temporary slot occupancy is not a fallback condition: finish or wait for current investigators, then obtain a distinct recording subagent. Only when subagent capability is absent or no usable subagent can be obtained after current delegated work completes may the coordinating agent perform a required phase locally, and it must report the exact fallback in the final outcome.

## Classification and Partitioning

Classify by the requested behavior, not by the user's preferred type name:

- Select `Bug` for unexpected current behavior, a regression, a failure, or a violated existing invariant. Confirm the root cause, identify the affected deployed or reported revision, and compare it with the freshly fetched authoritative default branch before recording it. If the cause remains unconfirmed or the default branch already fixes it, do not create or comment on an issue for that candidate.
- Select `Feature` for new user-visible functionality or a material expansion of existing product behavior.
- Select `Task` for maintenance, refactoring, documentation, testing, security hardening, operations, cleanup, migrations, or other work that adds no new product behavior and does not correct a confirmed defect.
- Ask the user before any GitHub write when classification or intended behavior remains ambiguous after repository investigation.

Maintain one candidate ledger across all three classifications. Split candidates when they can be implemented and verified independently. Keep them together only when the same intended outcome, change boundary, and verification require one implementation.

Classification does not require GitHub Issue Types. If the target supports and enables the exact `Bug`, `Feature`, or `Task` type, set and verify it. If Issue Types are unavailable, create the issue without a type unless the repository contract requires one; if a required type cannot be set, perform no write.

## Decision-Complete Handoff Standard

- Assume the implementer can read the complete issue thread and check out the identified repository revision but cannot access the original database, cloud logs, provider console, external account, customer environment, reporter session, or temporary investigation files.
- Pin facts to repository and environment evidence. Convert inaccessible source-dependent facts into a minimal sanitized fixture, test vector, generator, excerpt, or exact local setup whose causal or behavioral equivalence is explained.
- Identify the responsible code, contracts, configuration, data, or operational boundaries and cite authoritative evidence for every material behavioral decision.
- Resolve the selected smallest change, affected and deliberately unaffected behavior, compatibility and migration consequences, failure behavior, rollout needs, and exact regression coverage before writing.
- Define each test with concrete setup, input or fixture, action, and assertion.
- Do not leave the implementer to recover inaccessible evidence, investigate the cause, choose between material alternatives, or obtain product, architecture, scope, rollout, or verification decisions.
- Ask the user only for decisions that repository, runtime, issue history, or supplied evidence cannot determine. If a required fact or decision remains unresolved, mark that candidate `failed` and perform no GitHub write for it.

For `Feature` candidates, resolve the relevant product outcome, actors, UX and errors, interfaces, data and ownership, authorization and privacy, integrations, compatibility, operations, observability, documentation, and rollout decisions. Resolve a feature-flag contract whenever an applicable repository contract requires one; do not invent flag names, targeting, timing, or removal criteria.

For `Task` candidates, resolve the current state, intended maintenance outcome, exact implementation boundary, preserved behavior, dependencies, compatibility or migration handling, operational impact, and verification. Do not turn an unresolved bug hypothesis into a `Task` merely to bypass the root-cause standard.

## Bug Root-Cause and Default-Branch Standard

- Distinguish the user-visible symptom, trigger, propagation path, and underlying root cause.
- Require causal evidence, not a plausible hypothesis or timing correlation. Confirm the cause through a minimal reproduction, controlled counterfactual, or deterministic code, configuration, or runtime trace corroborated by logs or tests.
- Test material competing explanations and record why they were excluded.
- Maintain a separate evidence-ledger entry for every candidate defect, including its causal chain, selected correction, supporting and contradicting evidence, and outcome.
- For deployed behavior, identify the exact environment and deployed version, release tag, image digest, task definition, build identifier, or equivalent artifact, and trace it to the exact repository commit. For non-deployed reports, identify the exact observed revision. Never assume the current checkout is the affected revision.
- Resolve the authoritative default branch from repository metadata, freshly fetch it, and record its name, commit, remote, and fetch time. Do not assume a branch name or rely on a stale remote-tracking ref.
- Establish the root cause against the affected revision, then evaluate the same trigger and causal boundary on the fetched default branch in an isolated worktree or other workspace-safe checkout.
- Treat a defect as fixed on the default branch only when causal evidence shows the root-cause condition is absent and expected behavior holds. A changed file, merged pull request, or plausible patch alone is insufficient.
- When the default branch already fixes the defect, classify the outcome as `already fixed` and perform no GitHub write. Report the affected revision, fetched default-branch revision, fixing change when traceable, verification on both revisions, and any deployment lag.
- If the affected revision cannot be established, the default branch cannot be fetched, or the comparison cannot prove whether the cause remains, mark the candidate `failed` and perform no GitHub write.

## Workspace Integrity

1. Capture the starting branch or detached commit, `git status --porcelain=v1 --untracked-files=all`, staged diff, unstaged diff, and relevant untracked-file inventory before instrumenting anything.
2. Preserve every pre-existing user change. Use an isolated temporary worktree or copy when ownership overlaps or cannot be distinguished safely.
3. Inspect source, tests, and logs first. Add bounded temporary instrumentation only when needed to establish causality, follow repository logging rules, record every temporary patch or file, and never stage it.
4. Remove only agent-created instrumentation and temporary files. Never use a broad reset or overwrite concurrent user edits.
5. Before any GitHub write, prove the workspace matches its baseline except for independently made user changes. If cleanup cannot be proven, perform no GitHub write and report the discrepancy.

## Workflow

1. Ground and classify each candidate.
   - Identify the target repository, affected area, intended or expected behavior, current state, impact, environment, evidence, and requested outcome.
   - Read applicable repository instructions, authoritative docs, nearby source, tests, configuration, templates, and relevant issue history before asking discoverable questions.
   - Select `Bug`, `Feature`, or `Task` and partition independently implementable candidates.
   - Build the subagent investigation map, dispatch the bounded research assignments, and record their sourced results in the candidate and evidence ledgers.

2. Establish readiness.
   - For a `Bug`, reproduce and isolate the failure on the affected revision, inspect relevant authorized read-only runtime evidence, exclude competing explanations, and evaluate the confirmed cause on the freshly fetched default branch.
   - For a `Feature` or `Task`, establish current state and authoritative constraints, evaluate material alternatives, ask for undiscoverable intent, and resolve implementation, compatibility, rollout, operational, and verification decisions that apply.
   - Reduce inaccessible evidence to a portable sanitized representation and prepare exact test setups, actions, and assertions.
   - Reconcile the subagent findings, independently verify every material claim used in the outcome, and resolve or explicitly fail any contradiction that could change classification, scope, or verification.

3. Build and audit each handoff.
   - Draft one complete new issue or duplicate comment per ready candidate using only facts that can remain in the issue thread and repository.
   - Audit the draft from the perspective of an engineer with no other context.
   - Treat the draft solely as a GitHub handoff. Its proposed implementation and tests must not become work for this invocation, even if the Plan Mode result is approved.
   - Mark unconfirmed bugs as `unconfirmed`, verified default-branch fixes as `already fixed`, and decision-incomplete planned work as `failed`; perform no GitHub write for them.

4. Restore the workspace and check duplicates.
   - Remove temporary instrumentation and compare the workspace with the captured baseline.
   - Search open issues for the same root cause or intended outcome and implementation boundary. Similar symptoms or themes alone are not duplicates.
   - Treat closed issues as history. Link relevant closed records, but create a new issue for current work.

5. Record every ready candidate.
   - In Plan Mode, perform no GitHub write. Return the exact repository, classification, optional supported Issue Type, title, complete body or duplicate comment, and the later `gh` action.
   - After Plan Mode approval or outside Plan Mode, dispatch the dedicated recording subagent with the approved payload. Approval permits this recording action only; it does not relax any prohibition on implementing the recorded work.
   - The recording subagent must verify authenticated write permission and discover the target repository's required metadata and available Issue Types before writing.
   - For an open duplicate, the recording subagent must update its type only when supported and required, then add one self-contained comment only when the new report supplies missing evidence or decisions. If the existing thread is complete, it must perform no write and return it.
   - Without a duplicate, the recording subagent must create the issue with the supported metadata required by the repository. When an Issue Type is available and selected, it must include it in the creation request and re-fetch it; otherwise it must create without a type.
   - If one record fails, retain its failure details and continue with other independently audited candidates when safe. After every candidate reaches an outcome, end the invocation; do not begin implementation.

6. Report every outcome.
   - Report `new issue`, `duplicate comment`, `existing issue`, `already fixed`, `unconfirmed`, or `failed` for each candidate.
   - Include the issue or comment URL, classification, applied Issue Type when any, title, target repository, strongest evidence, and root cause for a `Bug`.
   - State clearly when no successful GitHub write occurred and report the shared workspace cleanup result once. End after this report without starting, staging, or proposing implementation work.

## Fallback GitHub Issue Contract

Follow the target repository's title, body, template, and metadata contracts when present. Otherwise use a concise title, preferring `<area>: <description>` when a stable area is evident, and use these sections in order:

```markdown
## Summary
State the requested outcome, affected users or systems, impact, and confirmed root cause for a Bug.

## Evidence
- Affected environment and repository revision:
- Affected and fetched default-branch revisions and comparison result for a Bug:
- Source provenance and implementer access assumptions:
- Current and expected behavior:
- Portable reproduction, fixture, test vector, or repository evidence:
- Responsible code, configuration, data, or contract boundaries:
- Decision provenance and resolved alternatives:
- Supporting commands, logs, tests, or code references:
- Duplicate search:

## Current Gap
Identify the violated invariant, missing capability, or maintenance gap and its exact boundary.

## Proposed Scope
Specify the selected implementation, affected contracts, preserved behavior, compatibility or migration handling, and applicable rollout, operations, observability, documentation, and support work.

## Acceptance Criteria
- Define exact observable results and boundary invariants.
- Define preserved behavior and compatibility or migration results.
- Define regression evidence that proves the outcome.

## Test Scenarios
- Give concrete setup, fixture or input, action, and assertion for the primary path.
- Cover relevant failure, permission, boundary, migration, rollout, or counterfactual behavior.
- Cover the nearest preserved or non-failing path.

## Out of Scope
- List adjacent work, redesigns, or behavior deliberately excluded.
```

Replace every prompt with candidate-specific content. Use a justified `Not applicable` only when omission cannot shift work or decisions to the implementer. Append `## Additional Notes` only when useful. If required evidence cannot be represented safely and self-sufficiently, do not write the issue or comment.

## Useful Commands

```bash
gh repo view --json nameWithOwner,url,defaultBranchRef
gh repo view "$OWNER_REPO" --json viewerPermission,defaultBranchRef
DEFAULT_BRANCH="$(gh repo view "$OWNER_REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
git fetch --no-tags "$REMOTE" "$DEFAULT_BRANCH"
git rev-parse "refs/remotes/$REMOTE/$DEFAULT_BRANCH"
gh issue list --repo "$OWNER_REPO" --state open --search "$SEARCH_TERMS"
gh label list --repo "$OWNER_REPO"
gh issue create --repo "$OWNER_REPO" --title "$TITLE" --body-file "$BODY_FILE"
gh api --method POST "repos/$OWNER_REPO/issues" -f "title=$TITLE" -F "body=@$BODY_FILE" -f "type=$ISSUE_TYPE"
gh issue comment "$ISSUE" --repo "$OWNER_REPO" --body-file "$COMMENT_FILE"
```

Use safely quoted variables and temporary files for multiline Markdown.
