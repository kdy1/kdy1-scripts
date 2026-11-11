---
name: static-analysis
description: Analyze all code in a user-specified scope, or the whole repository when scope is omitted, with parallel read-only analysis subagents, and hand each confirmed bug to $add-issue immediately. Use for requested comprehensive static bug analysis; issue recording requires a direct human invocation of $static-analysis or an explicit request to run Static Analysis.
---

# Static Analysis

## Prompt

Statically analyze all code in `<Scope>`, find every bug, and register each one with `$add-issue`. Do not batch issues; register each one as soon as it is confirmed. Continue until every unit in scope is covered. The user specifies `<Scope>`; if it is omitted, analyze all code.

## Run to full coverage

- A run ends only when the coverage ledger reports full coverage for the current pass, the human explicitly stops it, or a hard blocker prevents all remaining work. Do not stop, decline, or shorten a run because of elapsed time, token cost, finding counts, diminishing returns, an earlier clean pass, or a judgment that the scope is covered enough.
- Track coverage in the persistent ledger with `python3 <skill-dir>/scripts/ledger.py`. The ledger lives outside the target repository, keyed by scope, and survives queued turns and context compaction. Run `ledger.py next` before ending every turn and act on its `action`:
  - `dispatch`: launch workers for the pending units, or analyze them locally when no slot is free.
  - `reassign`: reassign blocked units to new workers, or analyze them locally.
  - `continue`: do coordinator-side work first (validate reported candidates, dispatch ready `$add-issue` handoffs, analyze cross-cutting contracts), then wait for async completion.
  - `new-pass`: the current pass has full coverage. Finish the run report.
- Treat every repeated or queued `$static-analysis` invocation for the same scope as a new authorization to continue the analysis. It is never a duplicate to decline. A status-only reply is not a valid response. If the current pass has uncovered units, use the turn to advance them. If the pass is complete, run `ledger.py new-pass` and analyze the whole scope again with the new pass focus until that pass also reaches full coverage.
- Do not duplicate in-flight work. A unit with an active worker stays with that worker; use free slots and coordinator time for other units.
- Explicit human stops, narrower restrictions, and missing authorization still apply. Report a real hard blocker exactly; do not invent one to end the run.

## Scope and authorization

- Resolve the target repository from the user's request or current checkout. Treat `<Scope>` as the user's analysis boundary, not a literal path. If omitted, analyze all code in that repository.
- Read applicable repository instructions and map the code covered by the scope. Read related contracts, configuration, tests, and callers. Read outside the scope only as needed to establish behavior and causes for in-scope defects.
- A direct human invocation of `$static-analysis` or an explicit request to run Static Analysis authorizes this analysis run, read-only analysis subagents, and `$add-issue` handoffs for bugs found within its scope. Automatic skill selection alone does not authorize issue recording.
- Preserve narrower user restrictions, including draft-only reporting. Creating, editing, planning, or testing this skill does not start analysis or issue recording.
- Do not fix code, commit changes in the target repository, or mutate production. Use read-only analysis tools without autofix. Leave any required candidate verification to `$add-issue` under its own rules.

## Subagent orchestration

Run the analysis with parallel read-only subagents. Delegation is the default execution model; a single-agent pass is a reported fallback, not the plan. Read [the orchestration contract](references/orchestration.md) before dispatch.

1. Discover capabilities with `orchestrator_capabilities` and honor the active interaction mode. Use native subagent tools when the child uses the coordinator's provider and model with no extra settings. Otherwise use `delegate_task` with an explicit target verified from the live catalog. Do not create top-level conversations for workers.
2. Partition the scope into analysis units with `python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n>`. Set `--max-units` to the number of analysis workers the budget allows. Keep the emitted unit IDs as coverage IDs. Load the plan into the ledger with `ledger.py init`; an existing ledger for the same scope and revision is resumed, not replaced. Add units for cross-cutting contracts, configuration, entry points, and callers that the path partition cannot express with `ledger.py add`.
3. Launch one worker per unit, in parallel, with a stable `clientRequestId` and the worker prompt from the orchestration contract. Give each worker its unit ID, exact paths, investigation revision, read-only rules, and reporting channel. Retain every `taskId` and child identifier.
4. Keep at most eight simultaneous subagents across the descendant tree, including `$add-issue` investigators and recorders. Reserve two slots for issue reporting and allocate analysis workers from the remaining budget. A ceiling is not a target; reduce parallelism when the scope is small.
5. Workers must not write GitHub records, edit files, or spawn agents. They report each candidate to the coordinator as soon as it has causal code evidence, then continue their unit. The coordinator validates the evidence, owns the coverage and candidate ledgers, and dispatches `$add-issue` per candidate.
6. Continue independent analysis while workers run. Do not poll; async completion wakes the coordinator. Use `task_status` only when a result is needed mid-turn, and `task_cancel` for work you replace or no longer need.
7. If subagent capability is absent or no usable worker can be obtained, run the analysis locally and report the exact fallback. Do not claim parallel coverage that did not happen.

## Analyze and record continuously

1. Resolve and retain the investigation revision and the analysis harness and model identities from trusted runtime or session metadata. Record unknown values as `unknown`; do not infer a model from a skill default. Retain each worker's actual harness and model identity as well as the coordinator's. Keep pre-existing uncommitted changes distinct from evidence about that revision.
2. Analyze every code area in scope and track coverage by unit with `ledger.py mark`. Follow control flow and data flow across relevant boundaries; do not treat a clean analyzer result or a worker's "no findings" as complete coverage. Distinguish confirmed defects from suspicions, style preferences, and feature requests.
3. As soon as a bug has causal code evidence, invoke `$add-issue` for that individual candidate. Pass the original human request and restrictions, run identity and delegation chain, target repository, authorized scope, exact revision, trigger, expected and actual behavior, root cause, and source references. Pass supporting tests or logs when available and any unresolved evidence gaps. Include the analysis attribution and the footer requirement below in every handoff, including delegated and draft-only payloads.
4. Let `$add-issue` own evidence validation, duplicate checks, issue content, metadata, delegation, recording, and verification. Follow its result; do not bypass an unconfirmed or failed outcome. Reference the skill by name and load it when invoking it; do not copy its workflow here.
5. Do not wait for the full analysis, a final worker report, or a collected batch before handing off or recording a ready candidate. A queue is only for active serialization or explicit blockers. Continue independent analysis while a handoff is in progress when feasible. When several candidates are ready at once, delegate the additional handoffs to reporting subagents within the reserved slots.
6. In Plan Mode or under draft-only restrictions, prepare each candidate's exact recording payload through `$add-issue` as it becomes ready, without GitHub writes. Read-only analysis workers may continue; do not dispatch recording agents. Retain payloads for an authorized continuation under that skill's mode-routing rules.
7. Finish only when `ledger.py next` returns `new-pass` and every handoff has a terminal outcome. Report the analyzed scope and revision, the pass number and focus, coverage and omissions, each candidate's outcome and verified issue URL when available, unresolved candidates, and blockers. Report worker identities, unit coverage, and any fallback. Do not claim that finding no further defects proves the absence of bugs.

## Issue attribution

- Require `$add-issue` to append the analysis harness and model attribution at the bottom of each new issue body, after the repository template content. Use GitHub’s small-text HTML form: `<sub>Static analysis — Harness: …; Model: …</sub>`. Attribute the analysis that found the bug, not merely the issue recorder. Include role labels when coordinator and worker identities differ, and list each distinct worker identity that contributed evidence.
- Generate the footer with `python3 <skill-dir>/scripts/attribution.py --harness "<observed harness>" --model "<observed model>"`. For multiple participants, provide role-labelled identities in the argument values. The helper escapes HTML and prints the footer; it does not write to GitHub.
- Carry the generated footer into the exact body before `$add-issue` audits or records it. For an existing duplicate, put it at the bottom of a comment only if `$add-issue` already requires that comment; do not overwrite an existing issue or add a comment solely for attribution.
- Require `$add-issue` to verify the footer in the published body or comment as part of its recording verification. In draft-only mode, verify it in the final payload without publishing.
