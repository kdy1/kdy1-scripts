# Shared stack coordination

Read this reference before assigning or mutating a registered stack. Resolve the helper relative to this installed `repair-pr` skill:

```sh
node "<repair-pr-directory>/scripts/stack-coordination.mjs" status
node "<repair-pr-directory>/scripts/stack-coordination.mjs" lookup --pr <exact-pr-url>
node "<repair-pr-directory>/scripts/stack-coordination.mjs" lookup --branch <head-branch> --repository <head-host/owner/repo>
```

All commands emit JSON. The helper derives `git rev-parse --path-format=absolute --git-common-dir` from the current checkout and stores state under `codex-stack-coordination/` there. Linked worktrees must report the same absolute root. Separate clones and separate hosts do not share this lock; reconcile external owners and remote heads before writes, and do not dispatch managed repairs into a clone with a different root. The helper is a cooperative guard: it does not intercept arbitrary Git commands or other clients. Every participating workflow must follow it before mutations.

Use a unique owner identifier for each batch coordinator or repair attempt. Retain returned random tokens in the ledger. An owner name alone cannot release or resume a lock. There is no timeout, PID-based stealing, or automatic expiry. Exit code 75 means contention or uncertain ownership: defer changes and reconcile; never proceed unlocked. Other nonzero exits are errors, not evidence of an unregistered stack. A read-only lookup does not reserve anything.

## Register and finish construction

Before the first integration or `gh stack init`, write a JSON registration file outside tracked source:

```json
{
  "id": "batch-run-uuid/stack-1",
  "batch": "batch-run-uuid",
  "repository": "github.com/owner/repo",
  "ledger": "/absolute/path/to/batch-ledger.json",
  "layers": [
    {"branch": "kdy1/first-layer", "headRepository": "github.com/owner/repo", "pr": null}
  ]
}
```

`id` is the durable coordination ID; also record gh-stack's catalog ID when available. Layers are in actual bottom-to-top integration order. Register every new layer's branch before creating or integrating it, and update its verified PR URL immediately after publication. The first registration atomically sets phase `building` and acquires a `build` lock, so unpublished branches are protected. Workers may commit only in their separately assigned implementation branches, outside the registered integration layers.

```sh
node "<helper>" register --file <registration-json> --owner <coordinator-owner>
node "<helper>" register --file <updated-registration-json> --owner <coordinator-owner> --token <build-token>
node "<helper>" ready --stack <coordination-id> --owner <coordinator-owner> --token <build-token>
```

Existing layers cannot be removed, reordered, moved between stacks, or assigned replacement PRs. `ready` requires every participating layer's PR URL, changes phase and releases the build lock atomically. Run it only after all assigned groups are finished, final-tip checks passed, and remote publication/order/SHAs/attachments are verified. Before `ready`, confirm the integration worktree is clean and run `git switch --detach <verified-final-tip-sha>` while holding the build token. Keep the worktree available; detaching frees its layer branch for a dedicated repair checkout. Dirty or user-owned checkouts must be reconciled, not stashed or stolen. A failed, partial, interrupted, or held build stays `building` with its lock intact. Do not release that lock merely because some PRs are visible. Other ready stacks may be managed independently.

For an already published, unregistered stack, verify its full membership with authenticated GitHub and gh-stack reads, record a task snapshot, and use `register --file <json> --owner <task-owner> --published`. Use a unique task ID as `batch` outside a Slop batch. Do not use `--published` to bypass a build: the helper rejects overlapping branches or PRs. A registered stack cannot be re-registered as a new ready stack. Do not add unrelated standalone PRs to a batch.

## Reserve, claim, and release repairs

Before spawning a repair subagent, reserve its entire ready stack and record the attempt, PR, reservation token, and intended child in the coordinator ledger:

```sh
node "<helper>" acquire --stack <id> --owner <attempt-owner> --mode reserved --pr <url>
```

For maintenance subagents, the coordinator prepares a clean linked worktree and calls `collaboration.spawn_agent` with `model: "gpt-6-luna"`, `reasoning_effort: "xhigh"`, and `fork_turns: "none"`. The initial handoff supplies the absolute repair skill path, PR/worktree, human authorization, signals/recovery evidence, scoped comment/validation constraints, and reservation/ledger information, but permits only read-only preparation. Record the returned actual agent ID/canonical task name and assigned worktree before recording start authorization and sending the start message. If preparation has already ended, `collaboration.followup_task` delivers the start handoff and triggers the idle agent. Record delivery outcomes immediately. In repository mode, retain the full watch record in the coordinator chat and store the coordinator identity, authorization pointer, attempt/reservation, actual spawn result, and start-handoff state in the registered stack snapshot.

Only that assigned child may claim the reservation after the explicit start message: verify original delegation and actual agent identity/worktree against the recorded spawn result. The token alone is not assignment evidence. If identity or start authorization is not recorded, stop before mutation and let the coordinator reconcile. Never create a second child to bypass a preparing or uncertain spawn/start delivery. Existing legacy repair-chat reservations remain protected until their actual owners and effects are reconciled; no new sidebar chat is needed.

```sh
node "<helper>" claim --stack <id> --token <reservation-token> --pr <url> --owner <child-attempt-owner>
node "<helper>" release --stack <id> --owner <child-attempt-owner> --token <claimed-token>
```

Claim consumes the reservation token and creates a fresh repair token. A direct authorized repair or stack edit with no reservation uses `acquire --mode repair` or `acquire --mode edit`, with `--stack`, `--owner`, and the member `--pr`. A `build` lock blocks every direct repair/edit, regardless of which PR was requested. An unregistered ordinary PR retains its ordinary workflow after a successful read-only lookup and ownership checks.

Hold the stack token from before checkout/ref changes through code changes, validation, all required upper-layer replay and pushes, remote verification, and review-thread handling. `manage-stacked-prs` invoked inside that repair reuses the same owner/token; it must not acquire or release a second stack lock. If results or alignment are uncertain, retain ownership for reconciliation. A known no-op can release after verification. A coordinator may release an unclaimed reservation only after creation is definitively rejected or the assigned child is confirmed stopped without uncertain effects. Record every release before the next assignment.

## Shared catalog

Hold a stack token first. Acquire the short catalog token around each gh-stack metadata/ref operation (`init`, `add`, `submit`, scoped `rebase`, and recovery), verify the selected stack, then release it. Never hold it while waiting for tests, CI, review, or a child agent. Git replay in another stack can proceed without it when it does not mutate catalog state. Keep the affected stack's workers idle during its stack operations; do not suspend unrelated implementation workers merely because a different stack owns the catalog.

```sh
node "<helper>" catalog-acquire --stack <id> --owner <stack-owner> --token <stack-token>
node "<helper>" catalog-release --owner <stack-owner> --token <catalog-token>
```

If a command is interrupted or its outcome is uncertain, keep its catalog token until its owning Git/gh-stack recovery state is reconciled. The helper forbids releasing a stack while it owns the catalog.

## Reconcile interrupted ownership

First inspect the ledger, actual agent/legacy-chat/process ownership, worktree status and pending Git/gh-stack operations, and authenticated remote outcomes. Stop all prior owners before transfer. Recovery never proves these facts itself. An unavailable agent handle on a later heartbeat is not proof that the owner stopped. Require positive stopped-owner evidence and reconcile worktree/Git operations and remote effects before recovery; otherwise retain the lock and defer replacement work. Save the evidence outside tracked source:

```json
{
  "ledger": "/absolute/path/to/batch-ledger.json",
  "ownerStopped": true,
  "gitOperationsClear": true,
  "remoteReconciled": true,
  "summary": "Concrete owner, worktree, operation recovery, and remote SHA evidence."
}
```

```sh
node "<helper>" recover --stack <id> --token <expected-old-token> --owner <new-owner> --evidence-file <json>
node "<helper>" recover --stack <id> --token <expected-catalog-token> --owner <new-owner> --catalog --evidence-file <json>
```

Recover and release an abandoned catalog token before transferring its stack token. Recovery replaces ownership/token and retains the old mode, PR, and build phase; it does not mark an incomplete build ready. Resume construction under the new token, or release a reconciled ready-stack repair. Preserve the recovery history.

The helper serializes its own short state writes through an atomic `transaction` directory and atomic state-file replacement. Normally this directory is removed before the command exits. `status` exposes its token and PID when a process was interrupted. A missing owner marker reports token `incomplete`; it is also a blocker. Confirm every old helper process and competing recovery is stopped before running the following recovery, then re-read state. Never delete state or locks by hand or infer abandonment from age.

```sh
node "<helper>" recover-transaction --token <expected-transaction-token-or-incomplete> --evidence-file <json>
```

## Batch scheduling snapshot

For a complete authenticated inventory of the batch's recorded PRs, prepare the following JSON outside tracked source. `repairSignal` means a verified current conflict, current-head failing check, or relevant unresolved bot finding under the maintenance skill's signal rules. Set `readComplete` only after all required reads, including current head/base and review/check pagination, succeeded. A healthy PR uses `repairSignal: false`.

```json
{
  "implementationEnded": false,
  "activeStackIds": [],
  "prs": [
    {"url": "https://github.com/owner/repo/pull/123", "state": "OPEN", "headSha": "verified-head", "baseSha": "verified-base", "repairSignal": true, "readComplete": true}
  ]
}
```

```sh
node "<helper>" plan --batch <batch-id> --file <inventory-json>
```

The helper rejects unrelated/duplicate PRs and chooses at most one repair per free ready stack, in bottom-to-top order. It includes upper PRs without an author or default-base filter. Missing required PR data yields `complete: false` and no assignments. An active stack includes queued/preparing/running/uncertain creations not yet represented by a claimed lock. Re-run planning with refreshed remote signals after a lower repair; an old snapshot does not authorize the next layer. Reserve each candidate before dispatch because a plan snapshot is not a lock. `stop: true` requires implementation ended, complete terminal PR states, and no active/locked/incomplete stacks. This is a scheduling aid, not GitHub inventory, automation registration, or proof of authorization.
