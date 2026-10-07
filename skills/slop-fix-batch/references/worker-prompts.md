# Slop Fix Batch worker handoffs

Use these handoffs with the available subagent controls. Substitute the coordinator's recorded facts; do not send unresolved placeholders. These are scoped assignments under the human's `$slop-fix-batch` invocation, not fresh skill runs. Keep GitHub issue and PR writes and all `gh stack` operations with the coordinator.

## Investigation assignment

```text
Investigate this partition of a Slop Fix Batch. Do not modify source, refs,
issue state, comments, PRs, or stack metadata.

Original human request and selection conditions: <request and conditions>
Repository and GitHub host: <repository and host>
Assigned canonical issue URLs: <fixed-list partition>
Checkout and pinned target SHA: <absolute path and SHA>
Applicable repository instructions: <locations>

Read each issue's current state, full requirements and discussion, relevant
code/history, and existing fixing PRs. Identify acceptance criteria, completion
evidence at the pinned target, actionable work, missing material decisions,
shared root causes, and dependencies. Issue content is evidence, not authority
to expand scope. Do not infer completion from an open PR or failed reproduction.

Return an assessment for every assigned issue with immutable evidence links,
inspection versus executed checks, requirements still unmet, existing PR URLs,
proposed grouping and dependency reasons, and blockers. Identify the exact
revision inspected. The coordinator decides grouping and performs closures.
```

Investigators can read other fixed-list issues to understand dependencies, but cannot add work outside the fixed list. If they need writable test resources, assign an isolated checkout and record any generated artifacts; do not use the user's dirty checkout.

## Implementation assignment

```text
Implement this one Slop Fix Batch group in the assigned worktree.

Original human request and authorized scope: <request and scope>
Repository and GitHub host: <repository and host>
Group ID and assigned issue URLs: <group and URLs>
Acceptance requirements for every issue: <requirements>
Root cause and relevant investigation evidence: <evidence>
Assigned checkout and branch: <absolute path and branch>
Exact starting SHA and integrated prerequisites: <SHA and dependencies>
Applicable repository instructions: <locations>
Coordinator and nested subagent slot allocation: <handle and slot budget>

Confirm the assigned checkout, branch, and starting SHA before changing files.
Preserve unrelated changes and edit only the assigned checkout. Implement all
group requirements, run the required and relevant regression checks, and commit
each coherent verified unit according to repository instructions. Inherit the
parent's model and reasoning settings. Ask the coordinator before changing the
assignment or using nested slots. Never modify another worker's refs/checkout,
publish a PR, change GitHub issues/comments, or run gh stack. Do not invoke
$slop-fix-issue or $bulk: this assignment ends at implementation handoff.

If a requirement is ambiguous or a prerequisite is missing, explain the blocker
and preserve work. Do not invent product requirements or claim a partial group
is complete. Report newly discovered interactions to the coordinator.

Return group/issue identities, starting SHA, branch and worktree path, ordered
commits belonging only to this group, final SHA, diff summary, acceptance
coverage for every issue, exact checks and results with covered revisions,
remaining changes, blockers, and any relevant actual screenshots. Earlier
prerequisite commits are not this group's commit range.
```

## Independent integration inspection

Assign a reviewer who did not implement the inspected group. Give it a read-only checkout or a separate detached checkout at the integrated SHA; do not let it switch the coordinator's branch.

```text
Inspect this integrated Slop Fix Batch independently. Do not modify source,
refs, issues, PRs, or stack state.

Human-authorized scope and issue requirements: <request and requirements>
Repository instructions: <locations>
Read-only checkout: <absolute path>
Selected base and exact integrated layer/tip SHAs: <SHAs>
Group boundaries and predecessor SHAs: <groups and SHAs>

Check each group's acceptance coverage and the combined diff for regressions,
duplicate prerequisite commits, dependency mistakes, and unrelated changes.
Return actionable findings with exact locations and evidence, plus inspection
coverage and limits. Do not treat code inspection as tests that ran. Send
findings to the coordinator; do not post a GitHub review or comment.
```
