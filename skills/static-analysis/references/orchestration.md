# Static Analysis orchestration

Apply this contract to the coordinator and every analysis worker. The coordinator owns the run ledger, coverage, evidence validation, and `$add-issue` handoffs. Workers only read code and report candidates.

## Discover capabilities and select a target

- Read `orchestrator_capabilities` for provider instances, models, model options, app-owned subagent support, and the active interaction mode. Do not infer support from a native tool's model list.
- Use native subagent tools when the child uses the coordinator's provider and model with no extra settings. Otherwise use `delegate_task` with an explicit `target` verified from the live catalog. Do not create top-level conversations with `create_threads` or `t3_thread_launch`.
- A human-specified model, reasoning level, or provider takes precedence. Verify the exact ID and option values from the catalog. If the requested target is unavailable, report the affected work as blocked; do not substitute silently.
- Record the target evidence for each worker. A matching model ID alone does not prove that a reasoning option was applied.

## Plan units

Run the planner before dispatch:

```sh
python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n> --format json
```

The output contains `scope`, `root`, `fileCount`, `lineCount`, and `units`. Each unit has a stable `id`, a `label`, file and line counts, and relative `paths`. The planner skips vendored, generated, binary, and lock files, splits oversized directories, and merges the smallest units to the budget. Keep the emitted IDs as coverage IDs.

Add units for cross-cutting work that a path partition cannot express: shared contracts and schemas, configuration and build files, public entry points, and callers outside the scope that establish in-scope behavior. Assign each added unit an ID that does not collide with the planner's IDs.

## Coverage ledger

Keep unit coverage in the persistent ledger. Keep candidates and evidence in the coordinating chat.

```sh
python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n> > <plan.json>
python3 <skill-dir>/scripts/ledger.py init --plan <plan.json> --revision <sha>
python3 <skill-dir>/scripts/ledger.py add --scope <scope> --id <id> --label <label> --path <path>...
python3 <skill-dir>/scripts/ledger.py mark --scope <scope> --unit <id> --status running --owner <taskId>
python3 <skill-dir>/scripts/ledger.py next --scope <scope>
python3 <skill-dir>/scripts/ledger.py new-pass --scope <scope>
```

The default ledger path is derived from the resolved scope under `$XDG_CACHE_HOME/static-analysis` or `~/.cache/static-analysis`; `--ledger` overrides it. `init` resumes a ledger with the same scope and revision and replaces one for a different revision. Statuses are `pending`, `running`, `complete`, and `blocked`. A unit is `complete` only when its assigned paths were analyzed and its findings or explicit no-finding result were reconciled. A worker's "no findings" is not proof of correctness. Mark a failed, partial, or idle worker's unit `blocked`, then reassign it.

## Passes and repeated invocations

The human runs this skill from a queue, so the same invocation can arrive many times, both while a run is active and after it finishes. Each arrival is authorization to continue scanning. Never answer it only with status, and never decline it as redundant, already running, or already complete.

- Pass 1 covers every assigned path. `next` returns `new-pass` only after every unit of the current pass is `complete`.
- On an invocation that arrives while `next` returns `dispatch`, `reassign`, or `continue`, advance the current pass: fill free slots with pending or blocked units, analyze units locally when no slot is free, and validate and hand off ready candidates.
- On an invocation that arrives after `next` returns `new-pass`, run `ledger.py new-pass` and analyze the whole scope again. Later passes rotate through foci such as cross-unit contracts, error and boundary paths, state and concurrency, differential checks against fixtures or reference implementations, and the least-productive units. Give each worker the pass number and focus, plus the candidates already handled for its unit so that it looks for new defects.
- A pass that finds no new defect does not justify refusing the next pass.

## Worker prompt

T3 children receive only the supplied prompt. Include every item below.

```text
You are a read-only static-analysis worker in a human-invoked $static-analysis run.

Authorization: <original human request and restrictions>
Run: <run ID>; coordinator thread: <thread ID>; unit: <unit ID>
Pass: <pass number>; focus: <pass focus>; already handled for this unit: <candidate summaries or none>
Repository: <absolute path>; revision: <commit SHA and branch>
Scope: <unit paths and any cross-cutting contracts>
Model target: <provider, model, and options evidence>

Rules:
- Read only. Do not edit, create, or delete files. Do not run autofix, formatters, or code generators.
- Do not create, comment on, or update GitHub issues. Do not spawn subagents.
- Analyze every assigned path. Follow data and control flow into callers, tests, and configuration as needed.
- Report only defects with causal code evidence. Separate confirmed defects from suspicions.

Report each candidate immediately to <channel> in the candidate format, then continue the unit.
Finish with: paths analyzed, checks performed, candidates reported, and remaining gaps.
```

## Candidate reports

Workers send each candidate as soon as it has causal code evidence. Do not wait for the unit to finish. Use `t3_thread_send` to the coordinator thread with `mode: "auto"` and a stable per-message `clientRequestId` when the runtime provides it. If messaging is unavailable, return the candidate immediately in the final response with completed and remaining coverage.

```text
candidate: <unit-id>-<n>
source: <path>:<line>
trigger: <preconditions and input>
expected: <behavior> (source: <contract, test, or doc>)
actual: <behavior>
cause: <causal chain>
evidence: <code references, tests, logs>
gaps: <unresolved evidence>
```

The coordinator reconciles reports centrally, assigns run-local candidate IDs, and merges reports that share a trigger and affected behavior. Keep aliases and evidence for merged reports. A report without causal evidence stays a suspicion and is not handed to `$add-issue`.

## Capacity and lifecycle

- Keep at most eight simultaneous subagents across the descendant tree, including `$add-issue` investigators and recorders. Reserve two slots for issue reporting and allocate analysis workers from the remaining budget. Also obey runtime capacity, which may include the coordinator and unrelated agents. Reduce parallelism when the scope is small; a ceiling is not a target.
- Launch each assignment with a unique `title`, a stable `clientRequestId`, and the unit ID. Retain `taskId`, `childThreadId`, and `childRunId` after acceptance.
- An uncertain spawn keeps its slot. Recover it with the same `clientRequestId` and inspect the recovered task; never create a second request ID to retry.
- Async completion wakes the coordinator. Continue reconciling reports and dispatching ready handoffs. Use `task_status` only when a result is needed mid-turn, and `task_cancel` for work you replace or no longer need.
- Verify terminal state and no pending child runs before releasing a slot. A completed turn with nested work still occupies the budget.
- Each continuation or reassignment is a new `delegate_task` with a new request ID, the original brief, completed evidence, and unresolved work. Do not send more work to a backing `childThreadId`.

## Failure and fallback

- A failed, partial, or idle worker is not completion. Reassign the unit or analyze it locally, and record the fallback.
- If subagent capability is absent or no usable worker can be obtained after current work completes, run the analysis locally and report the exact fallback. Do not claim parallel coverage that did not happen.
- In Plan Mode, read-only analysis workers may continue, but do not dispatch recording agents or write GitHub records. Prepare each candidate's payload through `$add-issue` and retain it for an authorized continuation.
