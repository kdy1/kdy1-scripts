# Batch scheduling and timing helper

Read this reference before the first execution allocation and reuse it in batch maintenance. Plan Mode may use `plan` with a planning snapshot; do not record execution events or create execution ownership in that mode. Skill editing does not start a batch.

Use `scripts/batch-scheduler.mjs` with Node.js. The coordinator supplies normalized facts, calls the helper at safe boundaries, and persists its output in the external batch ledger before dispatch. The helper has no GitHub, Git, agent or automation access. Its queue order and timing state never authorize mutations, prove passing gates, or replace `stack-coordination.mjs` locks. Keep fresh identity, scope, validation, whole-stack ownership and merge gates in their existing workflows. Workers return facts to the coordinator; they do not write the timing state or ledger.

## Ledger connection

Use the [procedure helper contract](helpers.md). Persist normalized scheduling observations with a coordinator `scheduler` ledger event, then run `batch-ledger.mjs snapshot` and pass its JSON to this helper's unchanged `plan` command. Snapshot generation accounts for ledger-recorded active/reserved/uncertain workers and nested slots, including assignments absent from the graph. Record only non-ledger occupancy in the stored `otherOccupiedSlots` field. Persist plan results, policy windows, displaced counters and reasons before dispatch; neither helper output replaces ownership or fresh gate observations.

## Estimate the path to the last merge

Optimize the time until every intended PR is verified merged. Record blocked or closed-unmerged PRs honestly; do not count them as merged to meet the objective. Model remaining investigation, implementation with worker checks, integration/publication, external CI/review, verified repair/alignment when needed, and merge/result verification as separate graph tasks. There is no cumulative-tip validation stage. Use confirmed edges only. Preserve group dependencies and the requirement that all assigned groups finish before a stack's ready handoff. A stack merge/result task must depend on all necessary publications and external gates. Do not add a repair task without an observed repair signal; an uncertain repair allowance belongs in estimate evidence, not an invented dependency.

CI/review for an early PR can overlap later implementation. Represent parallel stages as branches joining at the ready/merge barrier, rather than adding every stage duration serially. A dependent implementation needs its prerequisite integrated with passing worker checks; it need not wait for that prerequisite's publication or CI. Runtime eligibility still requires its assigned exact prerequisite SHA. Do not preassign a total integration order to make a scheduling graph; add actual integration/publication ordering as it becomes known.

Use observed remaining milliseconds when supported by similar completed tasks or current run timing; record the source and uncertainty. Otherwise use short/medium/long estimates. The helper maps these to 1/3/9 minute heuristic weights and defaults unknown estimates to medium. These are ranking weights, not promised completion times. An active/waiting task's estimate is its remaining time, not elapsed plus full original duration. Completed stages cost zero. The helper takes the longest downstream path and counts each unfinished downstream stage once; it does not sum parallel branches. Blocked/external stages contribute latency estimates without becoming dispatchable or reserving slots.

Within a lane, honor explicit human priority, then longer remaining path to merge, more unfinished downstream stages, lower own cost, completion-report order when applicable, and canonical issue order. Publication keeps whole-stack completion priority after explicit human priority; repair keeps complete-stack unblocking and lowest-layer priority. Merge candidates are drained before slot allocation. Preserve repair → publication → implementation/investigation/preparation allocation and the one-slot progress exception after two consecutive repair-displaced boundaries. Only maintenance dispatches returned repair suggestions. Human-specific allocations are applied before the snapshot: account reserved capacity in `otherOccupiedSlots` and exclude jobs outside the allowed allocations. Never interrupt active work to follow a new plan.

## Adaptive publication ceiling

An explicit positive human limit is fixed; it is no longer restricted to two through four. Without one, start at three and persist the measured ceiling. Increase by one at an allocation boundary only after at least three successful verified publications since the last adjustment, a larger independent-stack backlog, spare runtime capacity, and a healthy observation window. Healthy means no shared API limit/unknown publication outcome, and no increase in publication service or catalog-wait time relative to a comparable earlier window. Do not mark a window healthy without timing and API evidence. Wait time includes the publisher's catalog/submission and verification tail even when the coordinator performs that work.

On observed API pressure or increasing catalog/service time, halve the ceiling, with a minimum of one. Consume each pressure observation only once and reset the completed-publication window after an adjustment; do not repeatedly shrink or grow from the same evidence. A shared cooldown pauses new publication dispatch, including under a human limit, and keeps its previous ceiling. All remote workflows still honor the shared API budget. Unknown outcomes retain their slot and same-stack exclusion until reconciled. Lower ceilings never stop active publishers. Repair allocations, actual shared capacity and one-publication-per-stack remain binding. Fewer available jobs reduce actual dispatch without creating idle reservations.

## Scheduling snapshot

Store the snapshot outside tracked source and pass its absolute path:

```sh
node /absolute/skill/path/scripts/batch-scheduler.mjs plan /absolute/batch/scheduling.json
```

The schema is version 1:

```json
{
  "version": 1,
  "capacity": 8,
  "otherOccupiedSlots": 1,
  "boundary": 12,
  "publicationPolicy": {
    "previousCeiling": 3,
    "completedSinceAdjustment": 3,
    "healthy": true,
    "pressure": false,
    "cooldown": false
  },
  "displaced": {},
  "tasks": [
    {"id":"a:publish","stack":"a","lane":"publication","status":"pending","eligible":true,"requires":[],"estimate":"short","finishesStack":true,"canonicalOrder":0},
    {"id":"a:ci","stack":"a","lane":"external","status":"waiting","eligible":false,"requires":["a:publish"],"estimate":"long"},
    {"id":"a:merge","stack":"a","lane":"merge","status":"pending","eligible":false,"requires":["a:ci"],"estimate":"short"}
  ]
}
```

- Every task needs a unique `id`, `stack`, `lane`, `status`, explicit Boolean `eligible`, and `requires` array. Lanes are merge, repair, publication, implementation, investigation, preparation, external. Statuses are pending, waiting, active, reserved, uncertain, done, blocked. Missing dependencies or cycles reject the snapshot; do not repair them by dropping jobs.
- `eligible` is a coordinator observation, never a helper gate decision. Only pending tasks with all prerequisite tasks done can be selected. External tasks are never eligible. Active/reserved/uncertain workers need `slots`, including nested reservations. Pending CI/review and asynchronous merge requests use external/merge tasks, never worker slots. Each proposed new assignment consumes one slot; reconcile any nested requirement before starting it. `otherOccupiedSlots` covers workers/reservations absent from this graph, counted once.
- Optional ranking fields are `remainingMs` with nonempty `estimateEvidence`, `estimate`, numeric `priority` (larger first), `completionOrder`, `canonicalOrder`, `finishesStack`, `unblocksMerge`, and `layer`. Encode only the currently eligible lowest signaled repair per stack. Active/reserved/uncertain repair/publication entries protect their entire stack from another such assignment. Real coordination ownership can exclude more work.
- Carry forward returned `displaced`, advance `boundary` only at a real allocation boundary, and persist the returned `publicationPolicy.ceiling` as `previousCeiling`. If `resetSamples` is true, reset the observation window/counters and record the evidence consumed. Count successful prefix-verified publication completion, not merely a PR creation response. Persist ranked paths, estimates and reasons, queue sizes, accounting, unused reasons and explicit human overrides. Helper failure blocks new allocations from that snapshot, not independent known merge recovery.
- Returned `mergeCandidates` are hints only. Maintenance still performs fresh whole-stack gates under its edit token. Never dispatch a repair from construction or merge based on this file alone.

## Durable timing transitions

Record investigation, implementation/checks, publication, repair/alignment, CI/review wait, catalog wait, merge request and merge verification timing. Use separate attempt IDs on retries. Keep task/stack/PR/head identity and estimate evidence in the ledger. Record verified milestones and remaining blockers; a submitted merge is not completion.

```sh
node /absolute/skill/path/scripts/batch-scheduler.mjs record /absolute/batch/event.json /absolute/batch/timing.json
```

An event has `id` (idempotency key), `attempt`, `type`, and ISO timestamp `at`. A `started` event also needs `task` and `lane`. Later types are `waiting` with a concrete `reason`, `resumed`, `uncertain`, or `finished` with verified `outcome` succeeded/failed/cancelled. To leave uncertain state, supply `reconciled: true` and `evidence` identifying the actual reconciliation. Identical event retries are idempotent; conflicting duplicates, backward time, missing attempts and post-terminal transitions fail. Unknown effects cannot be marked finished merely because a worker disappeared.

`record` serializes local timing-state transitions with a directory lock and atomic file replacement. Busy/interrupted locks fail closed; inspect their owner and reconcile before retrying, never steal them automatically. This timing lock is separate from Git/stack and ledger ownership. It is released before network operations. Copy the successful timing milestone into the ledger; recover a timing-write/ledger-write interruption by its event ID before dispatch. Use measured elapsed and reasoned wait durations to revise later estimates and publication windows. Report the longest observed path and dominant waits at batch completion. Testing this helper is local scheduling validation, not live GitHub validation.
