# Static Analysis orchestration

Apply this contract to the coordinator and every analysis worker. The coordinator owns the run ledger, coverage, evidence validation, and `$add-issue` handoffs. Workers only read code and report candidates.

## Discover capabilities and select a target

- Read `orchestrator_capabilities` for provider instances, models, model options, app-owned subagent support, and the active interaction mode. Do not infer support from a native tool's model list.

### Model rule

Apply this rule to every subagent of the run: analysis workers, reassignments, continuations, and `$add-issue` investigators and recorders.

1. If the human specified a model or provider for subagents, use exactly that model. Verify the exact ID from the catalog.
2. Otherwise, use the coordinator's session model: the provider and model that the human selected when the session started (`inheritedProviderInstanceId` and `inheritedModel`).
3. Run every subagent with high reasoning effort: `effort: high` on Claude and `reasoningEffort: high` on Codex. If the human specified a reasoning level for subagents, use that level instead. Do not inherit the coordinator's own reasoning level or other session options, and do not add other options that the human did not request.
4. Do not select any other model. A connected provider, an available catalog entry, a model-pinned native agent type (for example a proxy-routed `ocx-*` agent), a configured default subagent model, a skill default, cost, speed, or diversity is not a reason to use a different model.
5. If the selected target is unavailable, does not accept the reasoning level, or the session model cannot be established, report the affected work as blocked and analyze it locally. Do not substitute another model or drop the reasoning option.

### Validate the target

Save the raw `orchestrator_capabilities` response, or the MCP response with `structuredContent`, to a private absolute path outside the target repository. Run:

```sh
python3 <skill-dir>/scripts/select-target.py <capabilities.json> \
  [--model <model-id>] [--provider <providerInstanceId>] [--option <id>=<value> ...]
```

Pass `--model`, `--provider`, and `--option` only for values that the human specified, for example `--option effort=xhigh`. Without them, the helper returns the session model with high reasoning effort. The helper checks app-owned delegation support, that the provider can run child tasks (and cross-provider child tasks when it is not the session provider), the exact model ID, and each option value, and adds the high reasoning effort option unless the human specified one. If the catalog's short list omits the model, call `orchestrator_capabilities` again with `search: "<model-id>"`, save that response, and run the helper on it. The output is the complete `target` object. Use it for every subagent, and pass it to `$add-issue` in each handoff so that its investigators and recorders use the same target.

### Select the tool

- Launch analysis workers with `delegate_task` and the helper's `target`, so that they run asynchronously and their candidate reports reach the coordinator during the run. A blocking subagent call returns all candidates of a unit at once, at the end, which batches the handoffs.
- Launch other subagents, such as `$add-issue` investigators and recorders, with `delegate_task` and the same `target` too. The target always sets a reasoning option, and native subagent tools (Claude `Agent`, Codex `spawn_agent`) do not reliably apply it. Do not create top-level conversations with `create_threads` or `t3_thread_launch`.
- Record the target evidence for each worker. A matching model ID alone does not prove that a reasoning option was applied. If a worker reports a model or reasoning level that differs from the target, cancel it, mark its unit `blocked`, and reassign it on the target.

## Plan units

Run the planner before dispatch:

```sh
python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n> --format json
```

The output contains `scope`, `root`, `fileCount`, `lineCount`, and `units`. Each unit has a stable `id`, a `label`, file and line counts, and relative `paths`. The planner skips vendored, generated, binary, and lock files, splits oversized directories, and merges the smallest units to the budget. Keep the emitted IDs as coverage IDs.

Add units for cross-cutting work that a path partition cannot express: shared contracts and schemas, configuration and build files, public entry points, and callers outside the scope that establish in-scope behavior. Assign each added unit an ID that does not collide with the planner's IDs.

## Coverage and candidate ledger

Keep unit coverage and the handoff state of each candidate in the persistent ledger. Keep candidate evidence in the coordinating chat.

```sh
python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n> > <plan.json>
python3 <skill-dir>/scripts/ledger.py init --plan <plan.json> --revision <sha>
python3 <skill-dir>/scripts/ledger.py add --scope <scope> --id <id> --label <label> --path <path>...
python3 <skill-dir>/scripts/ledger.py mark --scope <scope> --unit <id> --status running --owner <taskId>
python3 <skill-dir>/scripts/ledger.py candidate --scope <scope> --id <candidate-id> --status ready --unit <id> --title <summary> --source <path:line>
python3 <skill-dir>/scripts/ledger.py candidate --scope <scope> --id <candidate-id> --status handed-off --note <taskId>
python3 <skill-dir>/scripts/ledger.py candidate --scope <scope> --id <candidate-id> --status new-issue --issue <url>
python3 <skill-dir>/scripts/ledger.py next --scope <scope>
python3 <skill-dir>/scripts/ledger.py new-pass --scope <scope>
```

The default ledger path is derived from the resolved scope under `$XDG_CACHE_HOME/static-analysis` or `~/.cache/static-analysis`; `--ledger` overrides it. `init` resumes a ledger with the same scope and revision and replaces one for a different revision. Statuses are `pending`, `running`, `complete`, and `blocked`. A unit is `complete` only when its assigned paths were analyzed and its findings or explicit no-finding result were reconciled. A worker's "no findings" is not proof of correctness. Mark a failed, partial, or idle worker's unit `blocked`, then reassign it.

Candidate statuses are `ready` (validated, not yet handed off), `handed-off`, and the terminal outcomes `new-issue`, `duplicate-comment`, `metadata-update`, `existing-issue`, `unconfirmed`, `failed`, and `rejected` (merged into another candidate or not a defect; give the reason in `--note`). A terminal outcome cannot change. Candidates stay in the ledger across passes. `next` returns `handoff` while any candidate is `ready`, before `dispatch`, `reassign`, `continue`, or `new-pass`, and lists open handoffs in `openHandoffs`.

## Passes and repeated invocations

The human runs this skill from a queue, so the same invocation can arrive many times, both while a run is active and after it finishes. Each arrival is authorization to continue scanning. Never answer it only with status, and never decline it as redundant, already running, or already complete.

- Pass 1 covers every assigned path. `next` returns `new-pass` only after every unit of the current pass is `complete`.
- On an invocation that arrives while `next` returns `dispatch`, `reassign`, or `continue`, advance the current pass: fill free slots with pending or blocked units, analyze units locally when no slot is free, and validate and hand off ready candidates.
- On an invocation that arrives after `next` returns `new-pass`, run `ledger.py new-pass` and analyze the whole scope again. Later passes rotate through foci such as cross-unit contracts, error and boundary paths, state and concurrency, differential checks against fixtures or reference implementations, and the least-productive units. Give each worker the pass number and focus, plus the candidates already handled for its unit so that it looks for new defects.
- A pass that finds no new defect does not justify refusing the next pass.

## Worker prompt

T3 children receive only the supplied prompt. Include every item below.

```text
You are a read-only static-analysis worker in a directly requested or authorized scheduled $static-analysis run.

Authorization: <original direct request or verified schedule context and restrictions>
Run: <run ID>; coordinator thread: <thread ID>; unit: <unit ID>
Pass: <pass number>; focus: <pass focus>; already handled for this unit: <candidate summaries or none>
Repository: <absolute path>; revision: <commit SHA and branch>
Issue tracker: <owner/repo>; duplicate search: python3 <skill-dir>/scripts/find-duplicates.py
Scope: <unit paths and any cross-cutting contracts>
Model target: <helper target: provider, model, and reasoning option>
GitHub account: <`gh-bot-auth activate --repo <owner/repo>` or `normal`>

Rules:
- If the GitHub account line names `gh-bot-auth activate`, run that command first, before any GitHub read. If it reports `active: false` or fails, stop and report the reason.
- Read only. Do not edit, create, or delete files. Do not run autofix, formatters, or code generators.
- Do not create, comment on, or update GitHub issues. Do not spawn subagents. Do not settle or archive any thread.
- Analyze every assigned path. Follow data and control flow into callers, tests, and configuration as needed.
- Report only defects with causal code evidence. Separate confirmed defects from suspicions.
- As soon as you identify a candidate, search for duplicates with find-duplicates.py (--path, the symbol, and the error or symptom text as queries). If an open issue has the same root cause, report the candidate with that URL and do not collect evidence that the issue already contains. Reading GitHub is permitted; writing is not.

Report each candidate immediately to <channel> in the candidate format, then continue the unit. Do not collect candidates to report them together.
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
duplicates: <queries used; probable duplicate URL or "none"; other relevant matches; incomplete queries>
```

The coordinator reconciles reports centrally, assigns run-local candidate IDs, and merges reports that share a trigger and affected behavior. It registers each validated candidate as `ready` in the ledger and starts its `$add-issue` handoff in the same turn. Keep aliases and evidence for merged reports. A report without causal evidence stays a suspicion and is not handed to `$add-issue`.

## Capacity and lifecycle

- Keep at most eight simultaneous subagents across the descendant tree, including `$add-issue` investigators and recorders. Reserve two slots for issue reporting and allocate analysis workers from the remaining budget. While a ready candidate waits for a slot, give each freed slot to its handoff before a new analysis worker. Also obey runtime capacity, which may include the coordinator and unrelated agents. Reduce parallelism when the scope is small; a ceiling is not a target.
- Launch each assignment with a unique `title`, a stable `clientRequestId`, and the unit ID. Retain `taskId`, `childThreadId`, and `childRunId` after acceptance.
- An uncertain spawn keeps its slot. Recover it with the same `clientRequestId` and inspect the recovered task; never create a second request ID to retry.
- Async completion wakes the coordinator. Continue reconciling reports and dispatching ready handoffs. Use `task_status` only when a result is needed mid-turn, and `task_cancel` for work you replace or no longer need.
- Verify terminal state and no pending child runs before releasing a slot. A completed turn with nested work still occupies the budget.
- Each continuation or reassignment is a new `delegate_task` with a new request ID, the original brief, completed evidence, and unresolved work. Do not send more work to a backing `childThreadId`.

## Failure and fallback

- A failed, partial, or idle worker is not completion. Reassign the unit or analyze it locally, and record the fallback.
- If subagent capability is absent or no usable worker can be obtained after current work completes, run the analysis locally and report the exact fallback. Do not claim parallel coverage that did not happen.
- In Plan Mode, read-only analysis workers may continue, but do not dispatch recording agents or write GitHub records. Prepare each candidate's payload through `$add-issue` and retain it for an authorized continuation.
