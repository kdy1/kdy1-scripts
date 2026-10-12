# Slop Fix Batch worker handoffs

Read the settings, rendering and shared-API sections once, then only the current role handoff. Use available subagent controls and [scoped delegation](delegation.md). The coordinator owns fixed-list selection, group/dependency/stack decisions, slot reservations, issue closure, direct management and stop/resume state. Ordinary workers return facts. A recorded stack executor submits its own permitted ledger events and owns integration/registration/gh-stack/$create-pr prefix publication; a maintenance actor submits its assigned ready-stack outcomes and owns fresh gates/conditional merges. Implementation and repair workers never merge. Inventory owns only one captured read pass. Legacy ledgers retain coordinator-only execution until explicit safe-boundary activation. All active/reserved/nested/uncertain roles share the human/runtime capacity. Stack executors use publication's adaptive measured ceiling starting at three, without a second publisher slot. Never retain an actor through implementation/CI/review waits when effects are known and its bounded job is complete. Building prefixes retain whole-stack protection. The coordinator may transfer build ownership for a verified published-member repair at an idle boundary; construction resumes after verified repair results restore build ownership. Merging still requires every assigned group verified ready.

Apply the parent skill's validation policy to every handoff: skip direct app launches, manual reproduction, validation in a real environment, and screenshot capture for validation, including when requested by an issue. Keep automated tests, builds, linters, code inspection during investigation and implementation, and Git/GitHub state checks. Automated tests may launch the app or exercise reproduction scenarios. The policy does not relax evidence requirements for direct closure of already-resolved issues.

## Worker settings and context

For new execution assignments use `batch-coordinator.mjs prepare`; it calls `worker-settings.mjs` and returns the required settings with the validated preparation message. For Plan Mode or existing assignments using the individual procedure, run `node /installed/slop-fix-batch/scripts/worker-settings.mjs <role> --runtime <runtime> --complexity <simple|standard>` before creation. Resolve the installed path, use the ledger's runtime (Codex when absent), and select investigation, preparation, implementation, stack-execution, maintenance, inventory or repair. The helper is the single source of creation settings. Pass its fields unchanged to the runtime's creation tool, with the task name and scoped message as described in [runtime tools](runtimes.md); writing settings in the message alone does not configure an agent. The handoff renderer uses the same ledger runtime and assignment complexity. Repair uses this helper with the maintenance reference's repair handoff, not a new renderer role.

All new workers start without parent history: Codex uses `fork_turns: "none"`; Claude uses non-fork `general-purpose` agents. In the first message include original authorization, assigned scope/acceptance, exact checkout/SHA, instruction/helper paths, ownership/grants and checks. Put full prior findings/check logs/observations in batch-state evidence files; pass their verified paths and brief summaries. Workers read the relevant referenced fields before acting, not every role's procedures. This also applies in Plan Mode and nested repairs.

Choose `simple` only for investigation or implementation when requirements are clear, one isolated change area is established, no dependencies/shared-state/schema changes are involved, and validation commands are known. Otherwise use `standard`, including unknown complexity. Simple investigation/implementation uses the same model with medium effort; other roles retain existing settings. Record `complexity` and `complexityReason` in the reserved assignment before creation and retain them through START/results. Omitted complexity in an old assignment means standard; do not change an active worker's settings.

Use the same agent for a job's prepare and START phases. Reuse an agent across roles only when all returned settings match and the previous job and effects are reconciled. Otherwise allocate a new agent under the existing slot/ownership rules and hand off previous results. Apply settings to new workers only; do not restart active workers. If the required model, effort or tool capability is unavailable or overridden, report the creation failure and reconcile its reservation; do not silently substitute settings. Coordinator settings, concurrency policy and START authorization remain unchanged.

## Render and verify assignments

Use `batch-coordinator.mjs prepare/start` for new execution assignments; these call [`render-handoff.mjs`](../scripts/render-handoff.mjs) and its pack operation. Use the renderer directly for Plan Mode and existing assignments. Follow the [helper contract](helpers.md#coordinator-observations-and-dispatch). The templates below define investigation and implementation requirements; include resolved scope/acceptance/identity/check commands inline and long evidence through `evidenceRefs` in the structured assignment. The combined helper packs long evidence automatically; direct renderer callers use `pack` to avoid rebuilding serialization/hash commands. The renderer validates referenced JSON fields and their SHA-256 before rendering, including START; see the [evidence contract](helpers.md#worker-assignments-and-final-report). Never truncate facts or send unresolved placeholders. The combined helper persists the reservation, accepted worker identity, checkout and exact starting SHA through existing ledger validation before returning START. Direct callers retain the individual ledger/render sequence. Preparation and START remain separate phases. Use the installed `github-request.mjs` as the shared request entry point; direct gh/extension calls retain documented coverage gaps and report observed limits. Ordinary workers return facts; granted actors submit only permitted scoped events through batch-ledger submit. Do not bypass a renderer failure by sending an unchecked assignment.

## Shared API policy for every handoff

Supply the batch's absolute request-queue/cache/cooldown path, request entry point, and reusable coordinator observation paths with their read times and completeness. Pass the scheduler helper and timing-state paths as context; workers report stage timestamps and wait reasons to the coordinator and do not write them. All workers use this entry point for remote requests and honor its shared cooldown. Reuse applicable complete observations instead of duplicate polling; refresh exact assignment identities and affected remote state when required. Authenticated REST reads use page-specific conditional revalidation. Cache TTL hits are scheduling evidence only, never fresh merge authorization. Do not retry rate-limited or uncertain mutations independently, change authentication to bypass the limit, or claim incomplete reviews/CI passed. Send newly observed limits and unknown effects to the coordinator. Queue contention and cooldown responses are incomplete evidence, not empty successful results. Invalidate affected read observations and REST representations after any authorized write attempt, even when it fails or its result is unknown; cache eviction never permits a retry. Report direct `gh` or extension-internal requests that the shared entry point cannot intercept, and retain their observed limit/ownership state. Adopt the entry point at a safe boundary without restarting a loaded worker or interrupting an active Git/PR operation. Git/stack ownership and existing authorization boundaries still apply.

## Investigation assignment

Pass the current mode explicitly. In Plan Mode, use only investigation handoffs and follow the parent skill's **Plan Mode investigation and handoff** rules; construction and publication instructions in this reference apply only in execution mode.

```text
Investigate this partition of a Slop Fix Batch. Do not modify source, refs,
issue state, comments, PRs, or stack metadata.

Current mode: <Plan Mode or execution mode>
Original human request and selection conditions: <request and conditions>
Repository and GitHub host: <repository and host>
Assigned canonical issue URLs: <fixed-list partition>
Shared change areas and related fixed-list issues: <overlap map and inspected boundaries>
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

Save full assessments in batch-state files. Report each assessment as available
with new facts, decisions or blockers and its evidence file path; do not repeat
previous reports or wait for the whole partition. Include immutable evidence links,
inspection versus executed checks, requirements still unmet, existing PR URLs,
proposed grouping, affected functions/state/schemas/contracts and consumers,
classification as inseparable, ordered shared implementation, or independent,
and directed prerequisite/downstream relationships with evidence,
and blockers. Estimate implementation and required automated validation costs
as short/medium/long, stating the basis and uncertainty. Identify likely long
remaining dependency paths and related issues whose investigation could unblock
group confirmation. Use medium for unknown costs and mark them uncertain;
do not invent dependencies or treat estimates as completion evidence. Identify the exact
revision inspected and flag possible relationships with uninvestigated fixed-list
issues. Include proposed changes and concrete worker automated validation
commands for actionable work, with acceptance coverage and missing evidence.
Estimate external-stage latency only with supporting observations; otherwise
use the scheduler's uncertain medium default without inventing stage estimates.
Finish with complete coverage in the result file and a brief coverage/blocker summary. In Plan Mode, the coordinator collects
all investigation results and reconciles the entire fixed list before finalizing
the plan; neither workers nor the coordinator implement or close issues. Report
incomplete reads and unresolved decisions as blockers, not completed investigation.
In execution mode, the coordinator confirms groups and may dispatch implementation
while unrelated investigation continues; it owns closures.
```

Investigators can read other fixed-list issues to understand dependencies, but cannot add work outside the fixed list. If they need writable test resources, assign an isolated checkout and record any generated artifacts; do not use the user's dirty checkout.

## Dependent-group preparation

Use a read-only assignment while prerequisites are still being implemented. These workers share the user/runtime slot budget with investigation, implementation, stack execution, and maintenance repairs; carry forward investigation findings; changing from investigation to preparation requires a new agent only if the resolved creation settings differ; otherwise reuse the reconciled agent under the existing reservation/START rules.

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
Shared change boundaries and dependency/order decision: <evidence and related groups>
Assigned checkout and branch: <absolute path and branch>
Original investigation SHA and stack-specific freshly fetched target SHA: <SHAs and revalidation evidence>
Exact starting SHA and integrated prerequisites: <SHA and dependencies>
Applicable repository instructions: <locations>
Coordinator and nested subagent slot allocation: <handle and slot budget>
Worker checks and repository-mandated execution times: <commands and policy>
Required whole-repository checks to run in this worker: <commands>
Scheduling helper/timing state paths and estimate evidence: <absolute paths and evidence>
Preparation findings when present: <findings and inspected SHA>

Confirm the assigned stack ID, checkout, branch, and starting SHA before changing files.
For a new independent stack, use the coordinator's freshly fetched and revalidated
stack base shared with its integration worktree. For an existing dependent stack,
use its exact integration SHA containing the checked prerequisites. Never independently update the base,
restart active work after another PR merges, or rewrite protected stack ancestry.
All prerequisites must be present at that SHA in the assigned stack, and the
coordinator must confirm passing prerequisite worker checks and any checks for
integration changes before authorizing source changes; no cumulative-tip checks are required.
Preserve unrelated changes and edit only the assigned checkout. Implement all
group implementation requirements, run assigned change-related checks and checks
required at this stage by repository policy, and commit each coherent verified unit
according to repository instructions. Run required whole-repository checks in this
worker before handoff. Never bypass Git hooks or defer checks to integration
or a final tip. Preserve required execution times. If preparation findings exist, reconcile
them with relevant prerequisite changes at the assigned starting SHA. Use the implementation role’s explicit worker settings. Ask the coordinator before changing the
assignment or using nested slots. Never modify another worker's refs/checkout,
publish a PR, change GitHub issues/comments, or run gh stack. Do not invoke
$slop-fix-issue or $bulk: this assignment ends at implementation handoff.

Skip direct app launches, manual reproduction, real-environment validation, and
screenshot capture for validation even when required by an issue. Automated tests,
builds, and linters run in this worker and may exercise
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

Save the complete result in a batch-state file: group/issue identities, assigned stack ID and integration worktree,
starting SHA, branch and worker worktree path, ordered
commits belonging only to this group, final SHA, diff summary, acceptance
coverage for every issue, exact worker checks and results with covered revisions,
stage timing, wait reasons and estimate evidence, skipped real-world validation, remaining changes, blockers, and any relevant
actual screenshots already available. Earlier
prerequisite commits are not this group's commit range. Send its path, completion
identities and new changes/blockers; do not resend investigation or check logs.
```

## Stack execution assignment

Use render-handoff role `stack-execution` with prepare/start, not a nested publication child. The coordinator reserves one publication-lane job for a checked group, records actual worker/checkout/startSha and the root-confirmed implementation handoff, then grants the exact stack/group and generation before START. Include all [delegation assignment fields](delegation.md#activate-allocate-and-start), original authorization, group issue URLs/acceptance, prerequisite checks, diff/template/disclosures and helper/state paths. The actor may execute the entire integration-to-verified-prefix tail under that grant. It uses batch-stack steps, invokes $create-pr and $write-ste directly, attaches each PR, submits only scoped events and returns blockers/known effects promptly. Source adaptation is limited to in-scope conflict resolution with affected checks. It cannot change group/stack membership, allocate children, close issues, merge or register maintenance.

On final group completion, include exact clean detached tip and actual registry ready proof, then submit ready and own completion atomically. On an earlier prefix, retain build protection and return the slot. Unknown Git/PR/catalog effects retain the actor assignment until reconciliation. No separate cumulative-tip validation occurs.

## Delegated maintenance and inventory assignments

Use role `maintenance` for exactly one ready stack and role `inventory` for one captured batch read pass. Both START handoffs require actual recorded identity, checkout/startSha, active assignment and matching grant/generation. Pass the original conditional authorization, absolute maintenance/reference/coordination paths, current captured membership, state/capacity and fresh signal/candidate hints. The maintenance actor must freshly gate under whole-stack ownership; hints/unchanged SHAs do not authorize merge. For a confirmed middle-layer conflict in a fully published ready stack, follow maintenance’s **Merge below a confirmed conflict**: merge the contiguous passing lower prefix first, reconcile outcomes, then align only affected open descendants. Building prefixes remain ineligible for merging. It may record and spawn only repair children already reserved by the coordinator and added to its grant. Resolve repair settings through worker-settings.mjs and preserve two-phase START. With no child slot, return the verified signal and finish so the coordinator can dispatch repair directly.

Inventory START captures assigned URLs, read scope and full/targeted intention. Only its grant starts/finishes that pass. New arrivals remain pending. Complete read coverage is separate from final targeted whole-stack merge gates. It may not mutate GitHub or finish another pass. Finish its pass before returning its slot.
