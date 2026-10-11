# Batch procedure helpers

Use these helpers for a human-authorized batch. Loading or testing them does not invoke the batch. All paths supplied to a helper refer to batch state outside tracked source. Resolve `scripts/` against the installed `slop-fix-batch` directory, not the implementation checkout. Require Node.js with built-in `fetch` and `AbortSignal.timeout` (Node 20 or later); do not silently install a runtime.

## Commands and result contract

Each input document uses `version: 1`. JSON commands print one result. Handoff/report commands print Markdown. Exit 0 means the local operation completed, 1 means invalid input or a failed local invariant, and 2 means incomplete, blocked, busy, cooldown or uncertain evidence. Never treat either nonzero exit as a successful empty inventory. A complete request response does not prove publication, closure or merging. No helper spawns agents, registers automations or merges on its own. The grant-bound batch-stack helper runs explicit construction Git/gh-stack steps; it never chooses work or merge authority.

```sh
node /installed/slop-fix-batch/scripts/worker-settings.mjs investigation
node /installed/slop-fix-batch/scripts/collect-issues.mjs /batch/selection-input.json
node /installed/slop-fix-batch/scripts/batch-ledger.mjs init /batch/ledger.json /batch/init.json
node /installed/slop-fix-batch/scripts/batch-ledger.mjs apply /batch/ledger.json /batch/event.json coordinator-id
node /installed/slop-fix-batch/scripts/batch-ledger.mjs submit /batch/ledger.json /batch/submission.json
node /installed/slop-fix-batch/scripts/batch-stack.mjs run /batch/step.json
node /installed/slop-fix-batch/scripts/batch-stack.mjs reconcile /batch/step-reconciliation.json
node /installed/slop-fix-batch/scripts/batch-ledger.mjs snapshot /batch/ledger.json
node /installed/slop-fix-batch/scripts/batch-scheduler.mjs plan /batch/scheduling.json
node /installed/slop-fix-batch/scripts/verify-publication.mjs /batch/publication-input.json
node /installed/slop-fix-batch/scripts/batch-checkpoints.mjs plan /batch/ledger.json
node /installed/slop-fix-batch/scripts/render-handoff.mjs handoff /batch/handoff-input.json
node /installed/slop-fix-batch/scripts/render-handoff.mjs report /batch/ledger.json
node /installed/slop-fix-batch/scripts/batch-ledger.mjs resume /batch/ledger.json
```

`worker-settings.mjs <role>` takes a role name rather than a versioned input document and returns the three spawn settings as JSON. Unknown roles or extra arguments exit 1. Use these fields as actual spawn arguments under the [worker settings procedure](worker-prompts.md#worker-settings-and-context); the helper does not create an agent.

Capture the snapshot command's JSON outside source before passing it to the unchanged scheduler CLI. Record its allocation output, policy window and displacement counters in the next coordinator `scheduler` event before dispatch. The ledger reconciles active/reserved/uncertain assignments into the snapshot; `otherOccupiedSlots` in the stored scheduling observations covers only workers outside the ledger, avoiding double counting.

In Plan Mode, issue collection and read-only verification are allowed. Keep the planning observations in chat or permitted scratch state; do not initialize an execution ledger, record execution events, acquire construction ownership, send execution START, or perform remote writes. A planning handoff may use an in-memory ledger-shaped planning document without persisting execution records.

## Shared authenticated requests

```json
{
  "version": 1,
  "statePath": "/batch/github.json",
  "host": "github.com",
  "endpoint": "/repos/owner/repository/issues",
  "method": "GET",
  "parameters": {"per_page": 100},
  "paginate": true,
  "resource": "core"
}
```

Invoke `github-request.mjs request input.json`. Supported methods are GET, POST, PUT, PATCH and DELETE. The endpoint is an API path, not a URL. The host determines the authenticated API origin, including enterprise REST and GraphQL prefixes. An optional `apiVersion` sets the API-version header and partitions cached representations. Pagination follows next links only on the same origin and endpoint; repeated links, unsafe links and page ceilings fail closed. `maxPages` defaults to 10000. Results retain individual pages and their revalidation status.

For GraphQL reads, use POST `/graphql`, `operation: "graphql-read"` and `body: {"query": "query ...", "variables": {}}`. Explicit query operations are required; mutation operations are rejected in read mode. GraphQL errors make the result incomplete. GraphQL cursor pagination remains caller-driven: call through the shared helper for each cursor, retain every page and mark the observation complete only after `hasNextPage` is false. GraphQL POST reads do not use REST representation caching. Other POST requests, including GraphQL mutations, follow write-attempt rules.

Authentication uses GH_TOKEN/GITHUB_TOKEN for github.com, GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN for other hosts, or `gh auth token --hostname HOST`. Only a SHA-256 token namespace is stored; tokens and Authorization headers are never persisted or printed. This proves partitioning by the selected token, not the login behind that token. Required exact authenticated identity checks remain mandatory. Switching token namespace clears representations; no fallback namespace claims to identify a stored gh account.

GET reads always make a fresh network request, with If-None-Match or If-Modified-Since when an exact stored representation exists. A 304 reuses its exact text and page links. Missing representations reject 304. Cache keys contain host, token namespace, API version and canonical URL including parameters. There is no TTL shortcut for merge gates.

Requests acquire a batch-local queue lock for the entire bounded network operation. Busy/interrupted locks return incomplete without waiting. The queue lock is separate from ledger and stack locks. Resource cooldowns apply to primary limits; secondary limits pause the entire queue using Retry-After or a conservative bounded backoff. No helper sleeps through cooldowns or retries remote calls automatically.

Writes require a unique `attempt` and optional JSON `body`. Before sending, persist an uncertain attempt and evict all REST representations. Evict again after a response, including failures. Transport errors, 5xx responses and invalid response representations remain uncertain. A fresh response is marked `mutationResponseOnly`; it is not verified remote completion. An unknown prior write on the host blocks new writes until explicit reconciliation. Even a reconciled attempt ID cannot be resubmitted; a corrective retry uses a new ID after evidence and authorization checks.

Use `github-request.mjs control input.json` for:

- `action: "invalidate"`: clear REST representations, preserving attempts, cooldowns and ownership.
- `action: "observe-cli"`, `entryPoint`, optional `limited: true`: record direct CLI coverage gaps. A reported limit without headers pauses all resources conservatively; exact request count remains unknown.
- `action: "reconcile-write"`, `attempt`, `evidence`: retain the original result and add explicit reconciliation evidence. This does not retry the write or authorize a new one.

Direct gh/create-pr calls and gh-stack internal requests are not intercepted. Before such calls, run `github-request.mjs status input.json` to consult shared cooldown state and evict cache entries through `control invalidate`; invalidate again after every attempt and return missing-header limits to the helper. Unknown CLI outcomes also remain in the ledger under their assignment/operation owner. Adopting this helper does not replace existing skill authorization, stack locks or current-identity checks.

## Fixed issue collection

`collect-issues.mjs` takes `version`, `statePath`, `host`, `repository` (owner/name) and the exact `query`. The coordinator resolves natural language and confirms the mandatory repository/type/open qualifiers before calling it. The helper never rewrites Boolean grouping or narrows scope.

It uses authenticated `/search/issues`, every next page and a 100-result page size. A changing total, missing fields/pages, `incomplete_results`, more than 1000 results, or count mismatch blocks collection. It removes PR entries and deduplicates issues by host/repository/number while preserving first occurrence. Its `issues` array includes `key`, `number`, `url` and `canonicalOrder`; pass the complete result directly into ledger initialization as `selection`. A complete empty list ends the batch before initialization or dispatch.

## Ledger and recovery

Initialize with `version`, `batchId`, `coordinator`, exact `query`, complete `selection`, `repository` (host/owner/name), `baseBranch`, `remote`, `authorization` (original human request), and 40-character `inspectedSha`. The coordinator may retain original conditions, resolved author, concurrency, installed helper/state paths and capabilities in `context`. Preserve these facts in every subsequent handoff.

The ledger stores fixed issues, issue assessments, confirmed groups, pinned stacks/layers, original worker and integration-change check coverage, assignments/slots, publication records, checkpoint state, scheduling observations, maintenance registration and event history. It does not own actual Git or stack locks. An execution event has `id`, `expectedRevision`, ISO `at`, `type` and the following payload:

| Type | Payload and gate |
| --- | --- |
| `delegation-enable` / `delegation-grant` / `delegation-children` / `delegation-revoke` | Coordinator-only activation, exact actor/scope grants, pre-reserved repair child allocation and evidence-backed revocation; see delegation.md |
| `operation` | Scoped id/kind/owner/headSha with uncertain before effects; progress retains token/command boundary; verified/rejected needs explicit reconciliation evidence |
| `assessment` | `issueKey`, `value` with classification (`already-closed`, `already-resolved`, `existing-pr`, `actionable`, `blocked`) and evidence; include acceptance, fix, estimates and blockers |
| `groups` | Complete initial `groups` array before construction; each group has id, issues (fixed keys), requires, confirmed=true, acceptance and dependencyEvidence |
| `group` | Add/update one confirmed `value` before that group belongs to a stack; preserve constructed group scopes |
| `stack` | `value` with id, phase=building, groups, empty layers, baseSha, worktree, fetchedAt, revalidationEvidence; retain pinned anchor and build-owner facts |
| `layer` | `stackId`, `value` with groupId, headSha, workerSha, requirementsSatisfied=true, checks, integrationChanged, integrationChecks when needed, realWorldValidation=not-performed; only append or adapt an unpublished top layer |
| `publication-attempt` | `stackId`, `value` with operation id/status and worker details; preserve active/uncertain protection until verified or reconciled |
| `publication` | `stackId`, complete `verification` input described below; must match current integration prefix and all group issue references |
| `coordination` | `stackId`, `value` with freshly verified phase and evidence plus owner/token facts when applicable; records the existing coordination helper outcome |
| `ready` | `stackId`, detachedSha and evidence of clean checkout/detach; requires every assigned group/layer verified and coordination phase ready |
| `assignment` | `value` with id, taskId, lane, status, slots, and actual worker/worktree/startSha before active/START; finished requires zero slots, verified outcome=succeeded/failed/cancelled and evidence |
| `scheduler` | `value` using scheduling.md's version-1 snapshot, refreshed observations, policy/displacement state and recorded output |
| `checkpoint` | `value` containing one action described below |
| `maintenance` | `value` with mode `batch`, `management: direct`, state `active`/`stopped`/`completed`, authorization and attempt records; no automationId is required |
| `stack-observation` | Ready stack's `stackId`, `value` with fresh evidence, outstandingEffects, alignmentPending, ownershipActive booleans and per-PR review/CI/merge/queue results; remote effect clearance requires reconciliation |
| `hold` / `resume-stack` | `stackId` and evidence; preserve construction work/protection, resume only after reconciliation |
| `closure` | `issueKey`, `value` with exact targetSha, verified state=CLOSED, stateReason=COMPLETED, commentUrl and requirement evidence |
| `implementation-ended` | No active/uncertain construction assignment or building stack may remain; records final checkpoint |

Checks are `{command, status: "passed", sha}`. Original worker checks cover `workerSha`; changed integration checks cover `headSha`. Publication SHA does not extend worker coverage. Original exact starting SHA, commits/range, timing, skipped validation and mandatory command duration remain in the assigned records. Group dependency cycles, missing prerequisites, cross-stack edges and duplicated group/issue membership reject events.

Repeated identical event IDs are idempotent; conflicting IDs, stale revisions and backward timestamps reject. Legacy apply remains coordinator-only. An explicitly enabled delegation grants role/stack-bound submit access; see [delegation](delegation.md). The helper serializes all writes, validates scoped event sequences and retains idempotent receipts. Coordinator-only events include activation/grants/child allocation/revocation, assessments/groups/stacks, scheduler, closures, maintenance control state and implementation-ended. Unknown assignments cannot release slots without `reconciled: true` and `evidence`. A vanished worker is not reconciliation. Actual operation owner tokens remain in the coordination store, never fabricated by a ledger event.

Use `validate` before resume and `resume` for unresolved assignments, checkpoints, protected stacks and maintenance. `import ledger.json legacy.json` accepts only an explicitly validated version-1 ledger with complete mandatory fields/history; missing records return a recovery blocker without creating the destination. Convert legacy facts explicitly before import; never invent evidence. Existing ledgers are not overwritten. Busy or interrupted local locks must be inspected and reconciled after proving their owner stopped; helpers never steal locks automatically. Network I/O never runs under the ledger lock.

## Publication verification

Input has `version`, `expected` and `observed`. `expected` contains `stackId`, selected `baseBranch` and the currently integrated `layers`. Each layer contains groupId, url, headRepository (host/owner/name), headBranch, headSha, baseBranch, baseSha, title, exact body and `closes` issue URLs. Bottom base must be the selected target; each later base branch/SHA must match the preceding layer.

`observed` contains the same stackId, ordered layers from authenticated PR/stack reads, `complete: true`, `attachmentComplete: true`, and actual attached PR URLs in `attachments`. Every observed layer includes identity/content fields plus state=OPEN and isDraft=false. Capture the actual catalog-selected stack under its catalog token. For a single layer, supply the locally scoped stack identity and authenticated single-PR observation; do not claim native multi-PR membership. For multiple layers, include complete remote membership/order evidence.

Verification requires exact prefix length/order, identity and SHAs, exact recorded content, separate Closes lines for every expected issue and independently observed attachments. The ledger verifies that the prefix and closes list match its groups. Future groups have no participating layers. Verification failure blocks this stack; it never repairs content, runs integration tests or authorizes merging. Feed successful input into a ledger publication event after prefix submission and complete remote verification.

## Checkpoints and inventory

Store checkpoint/candidate state in the ledger using `checkpoint` events. The helper CLI's `plan` is read-only.

- `enqueue`: unique checkpoint id, reason, optional stackId and numeric epoch-ms at; marks the affected stack due immediately.
- `start`: passId, numeric at and exact captured `prs` URL array; consumes only then-pending events. One pass can be active.
- `finish`: matching passId, numeric at, `inventory` with complete and per-PR url/readComplete/state/headSha/baseSha/readAt (numeric epoch-ms within the pass), optional full=true with nextFullAt, and stack-to-epoch-ms `refresh` map. Full completeness requires exact captured membership; events received during the pass stay pending and their stacks remain immediately due.
- `invalidate`: stackId; marks inventory incomplete and existing candidates stale.
- `candidate`: queue=repair/merge, stackId, inspected prs, evidence/source and observation fields; candidates are hints only.

Run `plan` at safe boundaries to select full versus due targeted reads. Full inventory and targeted refreshes have separate deadlines. The direct coordinator consumes due work at safe boundaries; the helper does not schedule wakeups. A complete captured inventory still cannot establish coverage of newly published PRs; termination checks the current ledger set. Termination additionally requires implementation ended, all recorded PRs terminal, no pending checkpoints/pass, active/reserved/uncertain workers, protected construction, uncertain effects, outstanding ownership or unfinished alignment. Fresh whole-stack gates and ownership remain required for repairs and merges regardless of a plan result.

## Worker assignments and final report

`render-handoff.mjs handoff` takes version, explicit mode (`plan` or `execution`), role, phase (`prepare` or `start`), ledger and assignment. It renders recorded JSON facts alongside role constraints. Do not execute read-only preparation as permission to implement or publish.

All assignments require scope, repositoryInstructions, concurrency, estimateEvidence, and absolute requestHelper/requestState/schedulerHelper/timingState/ledgerPath. Investigation/preparation/implementation/publication/stack-execution require checkout, inspectedSha and fixed-list issueKeys. Inventory and delegated maintenance also carry their recorded checkout/startSha for START identity checks. Group roles require stackId, groupId, acceptance, integrationWorktree and dependencyEvidence.

Implementation additionally requires startSha, branch, prerequisiteChecks, checkCommands, explicit repositoryCheckCommands (empty only when none are required), and requiredExecutionTimes (or explicit none). Publication additionally requires headSha/baseSha/headBranch/baseBranch, absolute createPrSkill, original passing checks, all group issue URLs as closes, integrationChanged and any passing integrationChecks, and realWorldValidation=not-performed. Retain diff, remote, recorded PR, layer position and frozen ownership in the assignment. Maintenance requires absolute batchSkill (the installed slop-fix-batch SKILL.md), batchReference (its internal references/batch-maintenance.md), coordinationRoot, and capacityAccounting; include scheduler allocations, checkpoint state and original conditional merge authorization from the ledger.

Child execution START requires assignmentId and actual worker matching the persisted reserved/active ledger assignment. Non-maintenance checkout and implementation starting SHA must match. Legacy coordinator-owned maintenance START requires worker equal to the ledger coordinator and an existing verified ready handoff; it allocates no child slot. Delegated stack-execution/maintenance/inventory START instead requires an active matching grant, generation, assignment, actual worker, checkout and starting SHA. Those actors each occupy a real slot. Publishers use the integration checkout; implementation workers must use a separate checkout. Include assigned issue evidence, prerequisite integration coverage and preparation findings. Stack-execution additionally requires the resolved coordination/build owner, exact returned commits/original worker checks, integration-change commands and installed stack/create-pr paths; see delegation.md. Missing mandatory fields, ambiguous SHAs/paths and unresolved placeholders reject rendering. Plan Mode renders only read-only investigation/preparation. The coordinator retains grouping, global allocation and product judgment. Assigned stack actors judge in-scope conflict adaptation/evidence and record outcomes without stage-by-stage coordinator approval.

`report` prints every fixed issue, group, stack/layer, actual publication/verified closure/recorded merge outcome, original check commands and covered SHAs, integration-change coverage, blockers, bottom-to-top PR order, pinned base, integration tip and worktree. It retains maintenance registration/outcomes without treating opened or queued PRs as merged. Include the actual ledger path from context and any additional repository-specific evidence in the final response. Local fixture results are not live GitHub validation.
