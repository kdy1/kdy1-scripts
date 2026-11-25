---
name: static-analysis
description: Analyze all code in a user-specified scope, or the whole repository when scope is omitted, with parallel read-only analysis subagents, and hand each confirmed bug to $add-issue immediately. Settle the T3 Code thread when a standalone run completes. Use for requested comprehensive static bug analysis; issue recording requires a direct human request or a verified user-configured schedule that explicitly invokes Static Analysis.
---

# Static Analysis

## Prompt

Statically analyze all code in `<Scope>`, find every bug, and register each one with `$add-issue`. Do not batch issues; register each one as soon as it is confirmed. Search for duplicate issues as soon as each candidate is identified. Continue until every unit in scope is covered. The user specifies `<Scope>`; if it is omitted, analyze all code.

## Run to full coverage

- A run ends only when the coverage ledger reports full coverage for the current pass, the human explicitly stops it, or a hard blocker prevents all remaining work. Do not stop, decline, or shorten a run because of elapsed time, token cost, finding counts, diminishing returns, an earlier clean pass, or a judgment that the scope is covered enough.
- Track coverage in the persistent ledger with `python3 <skill-dir>/scripts/ledger.py`. The ledger lives outside the target repository, keyed by scope, and survives queued turns and context compaction. Run `ledger.py next` before ending every turn and act on its `action`:
  - `handoff`: start the `$add-issue` handoff for each candidate in `readyCandidates` now, before any other work. See `Analyze and record continuously`.
  - `dispatch`: launch workers for the pending units, or analyze them locally when no slot is free.
  - `reassign`: reassign blocked units to new workers, or analyze them locally.
  - `continue`: do coordinator-side work first (validate reported candidates, analyze cross-cutting contracts), then wait for async completion.
  - `new-pass`: the current pass has full coverage. Finish the run report and apply `Standalone Chat Completion`.
- Treat every repeated or queued `$static-analysis` invocation for the same scope as a new authorization to continue the analysis. It is never a duplicate to decline. A status-only reply is not a valid response. If the current pass has uncovered units, use the turn to advance them. If the pass is complete, run `ledger.py new-pass` and analyze the whole scope again with the new pass focus until that pass also reaches full coverage.
- Do not duplicate in-flight work. A unit with an active worker stays with that worker; use free slots and coordinator time for other units.
- Explicit human stops, narrower restrictions, and missing authorization still apply. Report a real hard blocker exactly; do not invent one to end the run.

## Scope and authorization

- Resolve the target repository from the user's request or current checkout. Treat `<Scope>` as the user's analysis boundary, not a literal path. If omitted, analyze all code in that repository.
- Read applicable repository instructions and map the code covered by the scope. Read related contracts, configuration, tests, and callers. Read outside the scope only as needed to establish behavior and causes for in-scope defects.
- A direct human invocation of `$static-analysis` or an explicit request to run Static Analysis authorizes the analysis, read-only subagents, and `$add-issue` handoffs for in-scope bugs. A user-configured schedule gives the same authorization when trusted runtime metadata identifies the scheduled run and its configured prompt explicitly invokes `$static-analysis` or asks to run Static Analysis. Use the scope in that prompt, including the whole-repository default when the prompt omits scope. Carry the schedule ID, run identity, original prompt, and restrictions in each handoff. Automatic skill selection alone does not authorize issue recording.
- Preserve narrower user restrictions, including draft-only reporting. Creating, editing, planning, or testing this skill does not start analysis or issue recording.
- Do not fix code, commit changes in the target repository, or mutate production. Use read-only analysis tools without autofix. Leave any required candidate verification to `$add-issue` under its own rules.

## GitHub account

Run GitHub reads and writes of the run as a GitHub App bot when [`gh-bot-auth`](https://github.com/kdy1/kdy1-scripts/tree/main/tools/gh-bot-auth) is installed:

- Before the first GitHub read of each invocation, if `gh-bot-auth` is on `PATH`, run `gh-bot-auth activate --repo <owner/repo>` for the issue tracker repository in the coordinator.
- If it reports `active: true`, put the GitHub account line of the [worker prompt](references/orchestration.md#worker-prompt) in each worker prompt, and tell `$add-issue` that the run uses `gh-bot-auth`. Do not use T3 Code `pull_request_*`, `create_issue`, or `comment_on_issue` tools for GitHub writes, because they do not use the bot.
- If the command is not on `PATH` or reports the reason `not configured`, continue with the normal `gh` account.
- If it reports `active: false` for another reason, or fails, stop before any GitHub read and report the reason as a blocker.

## Subagent orchestration

Run the analysis with parallel read-only subagents. Delegation is the default execution model; a single-agent pass is a reported fallback, not the plan. Read [the orchestration contract](references/orchestration.md) before dispatch.

1. Discover capabilities with `orchestrator_capabilities` and honor the active interaction mode. Select every subagent's target with the model rule in the orchestration contract: use the subagent model that the human specified; otherwise use the coordinator's session model, which the human selected when the session started. Run every subagent with high reasoning effort unless the human specified another reasoning level. Never select another connected provider, model, or model-pinned agent type on your own judgment. Get the target from `python3 <skill-dir>/scripts/select-target.py <capabilities.json>`, and launch every subagent with `delegate_task` and that target, because native subagent tools do not reliably apply the reasoning option. Do not create top-level conversations for workers.
2. Partition the scope into analysis units with `python3 <skill-dir>/scripts/plan-units.py <scope> --max-units <n>`. Set `--max-units` to the number of analysis workers the budget allows. Keep the emitted unit IDs as coverage IDs. Load the plan into the ledger with `ledger.py init`; an existing ledger for the same scope and revision is resumed, not replaced. Add units for cross-cutting contracts, configuration, entry points, and callers that the path partition cannot express with `ledger.py add`.
3. Launch one worker per unit, in parallel, with a stable `clientRequestId` and the worker prompt from the orchestration contract. Launch analysis workers asynchronously with `delegate_task`. Do not use a blocking subagent call for an analysis worker: the coordinator cannot hand off any candidate until that call returns, so all candidates of the unit arrive together at the end. Give each worker its unit ID, exact paths, investigation revision, read-only rules, and reporting channel. Retain every `taskId` and child identifier.
4. Keep at most eight simultaneous subagents across the descendant tree, including `$add-issue` investigators and recorders. Reserve two slots for issue reporting and allocate analysis workers from the remaining budget. Issue reporting has priority: while a candidate waits for a slot, give each freed slot to its handoff, not to a new analysis worker. A ceiling is not a target; reduce parallelism when the scope is small.
5. Workers must not write GitHub records, edit files, or spawn agents. As soon as a worker identifies a candidate, it runs the eager duplicate search, then reports the candidate to the coordinator as soon as it has causal code evidence, then continues its unit. The coordinator validates the evidence, owns the coverage and candidate ledgers, and dispatches `$add-issue` per candidate.
6. Continue independent analysis while workers run. Do not poll; async completion wakes the coordinator. Use `task_status` only when a result is needed mid-turn, and `task_cancel` for work you replace or no longer need.
7. If subagent capability is absent or no usable worker can be obtained, run the analysis locally and report the exact fallback. Do not claim parallel coverage that did not happen.

## Analyze and record continuously

1. Resolve and retain the investigation revision and the analysis harness and model identities from trusted runtime or session metadata. Record unknown values as `unknown`; do not infer a model from a skill default. Retain each worker's actual harness and model identity as well as the coordinator's. Keep pre-existing uncommitted changes distinct from evidence about that revision.
2. Analyze every code area in scope and track coverage by unit with `ledger.py mark`. Follow control flow and data flow across relevant boundaries; do not treat a clean analyzer result or a worker's "no findings" as complete coverage. Distinguish confirmed defects from suspicions, style preferences, and feature requests.
3. When a candidate arrives, validate its causal evidence, then register it with `ledger.py candidate --status ready` (see the orchestration contract). `ledger.py next` returns `handoff` until each ready candidate is handed off. Mark the candidate `handed-off` when its handoff starts, and record its terminal outcome and verified URL when the handoff ends.
4. Hand off each candidate individually and immediately. One candidate gets one `$add-issue` invocation, one recording payload, and one recording subagent. Do not put two candidates in one payload or one recorder. Do not hold a ready candidate to wait for another candidate, for a worker to finish, or for the end of a pass. If the coordinator is busy with another handoff, delegate the new handoff to a reporting subagent in a reserved slot.
5. Pass to `$add-issue`: the original direct request or verified schedule context and restrictions, the subagent target that the model rule selected, with its high reasoning effort option, run identity and delegation chain, target repository, authorized scope, exact revision, trigger, expected and actual behavior, root cause, source references, and the eager duplicate search result. Pass supporting tests or logs when available and any unresolved evidence gaps. Include the analysis attribution and the footer requirement below in every handoff, including delegated and draft-only payloads.
6. Let `$add-issue` own evidence validation, the final duplicate decision, issue content, metadata, delegation, recording, and verification. Follow its result; do not bypass an unconfirmed or failed outcome. Reference the skill by name and load it when invoking it; do not copy its workflow here.
7. In Plan Mode or under draft-only restrictions, prepare each candidate's exact recording payload through `$add-issue` as it becomes ready, without GitHub writes. Read-only analysis workers may continue; do not dispatch recording agents. Retain payloads for an authorized continuation under that skill's mode-routing rules.
8. Finish only when `ledger.py next` returns `new-pass` with an empty `openHandoffs` list, so that every handoff has a terminal outcome. Report the analyzed scope and revision, the pass number and focus, coverage and omissions, each candidate's outcome and verified issue URL when available, unresolved candidates, and blockers. Report worker identities, unit coverage, and any fallback. Do not claim that finding no further defects proves the absence of bugs. Apply `Standalone Chat Completion` before the final response.

## Eager duplicate search

Search for duplicates at the first point where a candidate exists, not only during the final `$add-issue` check. An early match saves investigation and shows which evidence the existing issue is missing.

- Resolve the issue tracker repository at run start. Use the repository's instructions; it can be different from the code repository. Give it to every worker.
- Run the search when a worker first identifies a candidate, before it spends time on more evidence:

  ```sh
  python3 <skill-dir>/scripts/find-duplicates.py --repo <owner/repo> \
    --path <path:line> --query <symbol> --query "<error text or symptom>"
  ```

  Use two to six queries: the affected file, the function or type, the error message or panic text, and short symptom phrases. The search includes open and closed issues. Issues that match more queries are listed first. A query marked `complete: false` overflowed or failed; add a narrower query instead of treating it as having no match.
- Read the titles and, when they are relevant, the bodies of the top matches. When an open issue describes the same root cause, report the candidate with that issue URL as the probable duplicate, and do not spend more effort on evidence that the issue already contains. Continue the unit.
- The coordinator also compares each new candidate with the candidates already in the ledger (`ledger.py status`) and merges reports with the same trigger and root cause. If a worker could not search, the coordinator runs the search before the handoff.
- Pass the search result to `$add-issue`. It is evidence only. `$add-issue` makes the final duplicate decision and repeats its own bounded check before recording. For Linear, use the Linear helper `collect` with `duplicate` terms instead of this script.

## Issue attribution

- Require `$add-issue` to append the analysis harness and model attribution at the bottom of each new issue body, after the repository template content. Use GitHub’s small-text HTML form: `<sub>Static analysis — Harness: …; Model: …</sub>`. Attribute the analysis that found the bug, not merely the issue recorder. Include role labels when coordinator and worker identities differ, and list each distinct worker identity that contributed evidence.
- Generate the footer with `python3 <skill-dir>/scripts/attribution.py --harness "<observed harness>" --model "<observed model>"`. For multiple participants, provide role-labelled identities in the argument values. The helper escapes HTML and prints the footer; it does not write to GitHub.
- Carry the generated footer into the exact body before `$add-issue` audits or records it. For an existing duplicate, put it at the bottom of a comment only if `$add-issue` already requires that comment; do not overwrite an existing issue or add a comment solely for attribution.
- Require `$add-issue` to verify the footer in the published body or comment as part of its recording verification. In draft-only mode, verify it in the final payload without publishing.

## Standalone Chat Completion

Apply [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md) after the run report. It owns the settlement procedure, ownership rules, and result reporting. This section gives the Static Analysis conditions.

- Standalone task: the thread's first substantive human task explicitly invoked `$static-analysis`, and the analysis run remains its only task. Repeated or queued `$static-analysis` invocations for the same scope, the `$add-issue` handoffs of the run, clarification, and an approved Plan Mode recording continuation belong to that task. A later Static Analysis invocation during another task, or a request to edit or test this skill, does not qualify.
- Completion conditions: settle only after `ledger.py next` returns `new-pass` for the current pass, every candidate handed to `$add-issue` has a verified `new issue`, `duplicate comment`, `metadata update`, or `existing issue` outcome, and all analysis workers and `$add-issue` subagents have finished. A pass with full coverage and no confirmed candidate qualifies. Leave the chat open for `unconfirmed` or `failed` candidates, uncertain writes, validated candidates not yet handed off, pending decisions or approvals, Plan Mode payloads awaiting recording, draft-only requests, a hard blocker, or an explicit human stop before full coverage.
- Analysis workers and `$add-issue` subagents never settle a thread. A `$static-analysis` handoff never makes `$add-issue` settle the thread on its own.
- No repeat: if settlement is not confirmed, preserve the verified results and do not repeat analysis or issue recording. A later queued invocation continues with the next pass under `Run to full coverage`.
- Report: the final run report with the verified issue links and the settlement result.
