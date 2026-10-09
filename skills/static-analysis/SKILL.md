---
name: static-analysis
description: Analyze all code in a user-specified scope, or the whole repository when scope is omitted, and hand each confirmed bug to $add-issue immediately. Use for requested comprehensive static bug analysis; issue recording requires a direct human invocation of $static-analysis or an explicit request to run Static Analysis.
---

# Static Analysis

## Prompt

`<Scope>`에 대한 모든 코드를 정적 분석하고 모든 버그를 찾아 각각 `$add-issue`로 등록해. 이슈를 모으지 말고 확인되는 대로 바로바로 등록해. `<Scope>`는 사용자가 지정하며, 생략하면 코드 전체를 대상으로 해.

## Scope and authorization

- Resolve the target repository from the user's request or current checkout. Treat `<Scope>` as the user's analysis boundary, not a literal path. If omitted, analyze all code in that repository.
- Read applicable repository instructions and map the code covered by the scope. Read related contracts, configuration, tests, and callers. Read outside the scope only as needed to establish behavior and causes for in-scope defects.
- A direct human invocation of `$static-analysis` or an explicit request to run Static Analysis authorizes this analysis run and `$add-issue` handoffs for bugs found within its scope. Automatic skill selection alone does not authorize issue recording.
- Preserve narrower user restrictions, including draft-only reporting. Creating, editing, planning, or testing this skill does not start analysis or issue recording.
- Do not fix code, commit changes in the target repository, or mutate production. Use read-only analysis tools without autofix. Leave any required candidate verification to `$add-issue` under its own rules.

## Analyze and record continuously

1. Resolve and retain the investigation revision. Keep pre-existing uncommitted changes distinct from evidence about that revision.
2. Analyze every code area in scope and track coverage. Follow control flow and data flow across relevant boundaries; do not treat a clean analyzer result as complete coverage. Distinguish confirmed defects from suspicions, style preferences, and feature requests.
3. As soon as a bug has causal code evidence, invoke `$add-issue` for that individual candidate. Pass the original human request and restrictions, run identity and delegation chain when applicable, target repository, authorized scope, exact revision, trigger, expected and actual behavior, root cause, and source references. Pass supporting tests or logs when available and any unresolved evidence gaps.
4. Let `$add-issue` own evidence validation, duplicate checks, issue content, metadata, delegation, recording, and verification. Follow its result; do not bypass an unconfirmed or failed outcome. Reference the skill by name and load it when invoking it; do not copy its workflow here.
5. Do not wait for the full analysis, a final worker report, or a collected batch before handing off or recording a ready candidate. A queue is only for active serialization or explicit blockers. Continue independent analysis while a handoff is in progress when feasible.
6. In Plan Mode or under draft-only restrictions, prepare each candidate's exact recording payload through `$add-issue` as it becomes ready, without GitHub writes. Retain payloads for an authorized continuation under that skill's mode-routing rules.
7. Finish with the analyzed scope and revision, coverage and omissions, each candidate's outcome and verified issue URL when available, unresolved candidates, and blockers. Do not claim that finding no further defects proves the absence of bugs.
