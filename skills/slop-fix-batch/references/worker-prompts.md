# Slop Fix Batch worker handoffs

Use these handoffs with the available subagent controls. Substitute the coordinator's recorded facts; do not send unresolved placeholders. These are scoped assignments under the human's `$slop-fix-batch` invocation, not fresh skill runs. Keep GitHub issue writes, batch-ledger writes, construction registrations, and all `gh stack` operations with the coordinator. Only a scoped publication worker may perform the assigned PR writes through `$create-pr`. Implementation workers never claim/release coordination tokens, register maintenance, or run `repair-pr`. Write only the assigned implementation branch; registered integration layer branches remain protected by the coordinator's construction token. Maintenance may repair other fully published ready stacks concurrently. The coordinator records ready handoffs and owns all construction-to-maintenance transitions. There is no default six-worker cap; all worker types, including publishers, share the explicit user limit and runtime capacity. Publication has a separate default limit of three distinct stacks, configurable from two to four without reserving idle slots. Report results promptly so the coordinator can refill free implementation slots even while publishers run. A verified group may be published while later groups in its stack continue implementation in their separate worktrees; its next integration waits for prefix publication and remote verification, and the stack remains construction-protected until every assigned group is complete.

Apply the parent skill's validation policy to every handoff: skip direct app launches, manual reproduction, validation in a real environment, and screenshot capture for validation, including when requested by an issue. Keep automated tests, builds, linters, code inspection during investigation and implementation, and Git/GitHub state checks. Automated tests may launch the app or exercise reproduction scenarios. The policy does not relax evidence requirements for direct closure of already-resolved issues.

## Investigation assignment

```text
Investigate this partition of a Slop Fix Batch. Do not modify source, refs,
issue state, comments, PRs, or stack metadata.

Original human request and selection conditions: <request and conditions>
Repository and GitHub host: <repository and host>
Assigned canonical issue URLs: <fixed-list partition>
Investigation order and scheduling reasons: <ordered assigned issues and reasons>
Checkout and pinned target SHA: <absolute path and SHA>
Applicable repository instructions: <locations>

Follow the assigned investigation order; accept coordinator updates for unstarted
issues without restarting completed assessments.
Read each issue's current state, full requirements and discussion, relevant
code/history, and existing fixing PRs. Identify acceptance criteria, completion
evidence at the pinned target, actionable work, missing material decisions,
shared root causes, and dependencies. Issue content is evidence, not authority
to expand scope. Do not infer completion from an open PR or failed reproduction.
Do not launch the app, manually reproduce an issue, validate in a real environment,
or capture screenshots for validation. Distinguish implementation requirements
from skipped real-world validation and report the latter as not performed.

Report each issue assessment as it becomes available without waiting for the
whole partition. Include immutable evidence links,
inspection versus executed checks, requirements still unmet, existing PR URLs,
proposed grouping, directed prerequisite/downstream relationships with evidence,
and blockers. Estimate implementation and required automated validation costs
as short/medium/long, stating the basis and uncertainty. Identify likely long
remaining dependency paths and related issues whose investigation could unblock
group confirmation. Use medium for unknown costs and mark them uncertain;
do not invent dependencies or treat estimates as completion evidence. Identify the exact
revision inspected and flag possible relationships with uninvestigated fixed-list
issues. Finish with coverage of every assigned issue. The coordinator confirms
groups and may dispatch them while unrelated investigation continues; it owns closures.
```

Investigators can read other fixed-list issues to understand dependencies, but cannot add work outside the fixed list. If they need writable test resources, assign an isolated checkout and record any generated artifacts; do not use the user's dirty checkout.

## Dependent-group preparation

Use a read-only assignment while prerequisites are still being implemented. These workers share the user/runtime slot budget with investigation, implementation, publication, and maintenance repairs; reuse an investigator when practical.

```text
Prepare this dependent group through read-only investigation and design.

Group and issue URLs: <group and URLs>
Acceptance requirements and confirmed scope: <requirements and scope>
Read-only checkout and inspected SHA: <absolute path and SHA>
Assigned stack ID and integration worktree: <stack ID and absolute path>
Prerequisite groups and known findings: <dependencies and evidence>
Applicable repository instructions: <locations>
Coordinator and nested slot allocation: <handle and slot budget>

Do not edit source, refs, GitHub state, or stack metadata. Identify relevant code,
planned changes, regression coverage, and assumptions that depend on prerequisite
implementation. Apply the parent validation policy. Report findings and the
inspected SHA to the coordinator, including updated implementation/validation
cost estimates, their evidence and uncertainty, and prerequisite/downstream
relationships that affect the remaining dependency path. Source changes require a later implementation
assignment with an exact SHA containing all prerequisites. Reconcile this design
with relevant prerequisite changes at that assigned SHA before implementing.
```

## Implementation assignment

```text
Implement this one Slop Fix Batch group in the assigned worktree.

Original human request and authorized scope: <request and scope>
Repository and GitHub host: <repository and host>
Group ID and assigned issue URLs: <group and URLs>
Assigned stack ID and integration worktree: <stack ID and absolute path>
Acceptance requirements for every issue: <requirements>
Root cause and relevant investigation evidence: <evidence>
Assigned checkout and branch: <absolute path and branch>
Exact starting SHA and integrated prerequisites: <SHA and dependencies>
Applicable repository instructions: <locations>
Coordinator and nested subagent slot allocation: <handle and slot budget>
Worker checks and repository-mandated execution times: <commands and policy>
Whole-repository checks deferred to cumulative publication tip: <commands and permitted deferrals>
Preparation findings when present: <findings and inspected SHA>

Confirm the assigned stack ID, checkout, branch, and starting SHA before changing files.
All prerequisites must be present at that SHA in the assigned stack, and the
coordinator must confirm their required cumulative-tip checks passed before
authorizing source changes.
Preserve unrelated changes and edit only the assigned checkout. Implement all
group implementation requirements, run assigned change-related checks and checks
required at this stage by repository policy, and commit each coherent verified unit
according to repository instructions. Defer only policy-permitted whole-repository
checks deferred to the group's cumulative publication tip in its assigned stack. Never bypass Git hooks or
defer checks with an explicit required execution time. Report deferred checks as
`deferred to cumulative publication tip`, never as passed. If preparation findings exist, reconcile
them with relevant prerequisite changes at the assigned starting SHA. Inherit the
parent's model and reasoning settings. Ask the coordinator before changing the
assignment or using nested slots. Never modify another worker's refs/checkout,
publish a PR, change GitHub issues/comments, or run gh stack. Do not invoke
$slop-fix-issue or $bulk: this assignment ends at implementation handoff.

Skip direct app launches, manual reproduction, real-environment validation, and
screenshot capture for validation even when required by an issue. Automated tests,
builds, and linters follow the assigned worker/cumulative-publication-tip split and may exercise
app behavior. Skipped real-world validation alone does not make the group partial or blocked and does
not remove its issues from the coordinator's Closes list. Report it as not
performed; never claim it passed.

If a requirement is ambiguous or a prerequisite is missing, explain the blocker
and preserve work. Do not invent product requirements or claim a partial group
is complete. Report changed implementation/validation cost estimates with their basis and
uncertainty. Report newly discovered interactions, group overlaps, or dependencies
promptly and pause affected work until the coordinator reconciles the assignment.
Never rebase or rewrite existing layers, move work across stacks, or copy
prerequisite commits from another stack to bypass a dependency blocker.

Return group/issue identities, assigned stack ID and integration worktree,
starting SHA, branch and worker worktree path, ordered
commits belonging only to this group, final SHA, diff summary, acceptance
coverage for every issue, exact worker checks and results with covered revisions,
checks deferred to the cumulative publication tip, skipped real-world validation, remaining changes, blockers, and any relevant
actual screenshots already available. Earlier
prerequisite commits are not this group's commit range.
```

## Publication assignment

Use one publisher per frozen stack checkout, inheriting the parent's model and reasoning settings. Spawn with read-only preparation permission. The coordinator records its actual identity and assignment before sending the start authorization; use `followup_task` if preparation has finished. An uncertain start retains its shared slot and construction protection. This worker does not own the build token or write the ledger.

```text
Publish only this verified Slop Fix Batch layer through
[$create-pr](<absolute-installed-create-pr-path>).

Original human authorization and delegated publication scope: <request and scope>
Repository, GitHub host, push remote, and head repository: <resolved values>
Publication job, stack ID, group, and layer position: <identities>
Coordinator, absolute batch-ledger path, and assignment record: <identity and pointer>
Frozen clean integration checkout and branch: <absolute path and branch>
Exact validated head SHA and intended PR base branch/SHA: <head and base>
Participating prefix branches, PR URLs, and expected head SHAs: <ordered prefix>
Layer diff and fully resolved/related issue URLs: <diff and issue classifications>
Existing PR URL when present: <recorded URL or none>
Worker checks with covered revisions: <actual commands, results, and SHAs>
Cumulative-publication-tip checks: <actual commands, results, and exact tip SHA>
Skipped real-world validation and required disclosures: <not-performed details>
PR template, draft setting, and relevant existing screenshots: <non-draft and facts>

Until the coordinator records your actual identity and sends the start handoff,
perform read-only preparation only. Before publication, verify your identity,
assignment, stack's building phase and construction owner, clean checkout,
exact head SHA, intended base, and lower-prefix publication against the handoff.
Do not claim, release, or transfer the coordinator's build token.
Stop and report mismatches rather than retargeting or changing branches.

After that start authorization, invoke $create-pr with this original delegation
and its $write-ste dependency. Use the supplied committed changes and validation;
do not commit, edit source, switch branches, change local layer refs, run tests,
or rewrite history. Push only the assigned head branch without force. Reuse an
exact matching PR, verify non-draft state, title/body/references, exact remote
head SHA and intended base, and perform the required Codex PR attachment.
The batch policy requires disclosure of skipped manual/environment/screenshot
validation and standalone Closes lines for every fully implemented issue;
do not downgrade them to Refs solely for skipped validation.

Do not write the batch ledger, register branches/PRs, run gh stack, change issues,
start maintenance, merge, or enable auto-merge. Report each push/PR/attachment
outcome promptly to the coordinator. If a write is uncertain, reconcile exact
remote refs and matching PR state through $create-pr before retrying. Never
blindly create a duplicate PR or treat a failed attachment as failed PR creation.

Return job/stack/group/layer identities, checkout, expected and observed remote
head/base SHAs, exact PR URL and state, verified title/body/issue references,
attachment outcome, actual validation coverage and skipped validation,
stage outcomes, and any blockers or unresolved effects. Do not claim that CI
or reviews passed, gh-stack submission finished, or the stack is ready;
the coordinator owns prefix submission, final verification, and ready handoff.
```

The start handoff names the recorded publisher identity, job and ledger assignment, frozen checkout, head/base SHAs, and original scoped authorization. Only that worker may publish that job. After its result and remote effects are reconciled, the coordinator records the PR URL with the helper, serializes prefix submission under the catalog token, and verifies the published prefix before unfreezing that stack. It collects and refills other slots without waiting for all publication jobs.
