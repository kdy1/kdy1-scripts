# PRD GitHub Issue Template

Create one issue per coherent feature or implementation slice. Follow the target repository's issue template and style contract when present; use this reference only as the fallback.

## Title

Use the repository's required format. When none exists, prefer:

```text
<area>: <description>
```

- Use a stable area or component identifier when one is evident.
- Keep the description concise and specific, starting with a lowercase verb phrase when natural.
- If no stable area exists, use a concise descriptive title without inventing a prefix.

## Body

Use the following section order when the repository does not provide another template:

```markdown
## Summary
State the requested feature, target users, core value, and success criteria in one or two concise paragraphs.

## Evidence
- Source:
- Current gap:
- Users or actors affected:
- Repository or contract evidence:
- Duplicate search:

## Current Gap
Explain the current behavior, missing capability, or operational gap that makes the feature necessary.

## Proposed Scope
Describe the exact functional and operational scope to implement. Include interfaces, data/state, UX, security/privacy, integrations, rollout, observability, docs, and support decisions that are in scope.
When a feature flag applies, name it and document its owner, evaluation and enforcement surfaces, gated paths, default, disabled, and evaluation-failure behavior, initial target, staged rollout, kill switch and rollback behavior, and removal criteria. Keep authorization, tenancy, billing, budget, resource-state, and safety enforcement independent from the flag.

## Acceptance Criteria
- A user or system can ...
- Authorization, data ownership, and error behavior are ...
- When a feature flag applies, it gates every decided entry point and execution path and produces the specified observable behavior in each state.
- Observability and operational controls are ...
- Documentation or support artifacts are ...

## Test Scenarios
- Verify the primary happy path.
- Verify permission, validation, and error handling.
- Verify contract, data, migration, or integration behavior.
- When a feature flag applies, verify default, enabled, disabled, evaluation-failure, targeting, staged-rollout, kill-switch, and rollback behavior.
- Verify rollout, rollback, observability, and support scenarios where applicable.
- Verify non-regression for preserved behavior.

## Out of Scope
- List adjacent capabilities, migrations, redesigns, compatibility promises, or operational work that the user explicitly excluded.
```

Append `## Additional Notes` only when useful context does not fit the required sections.

## Filing Checklist

Before filing, verify:

- Every applicable decision-ledger row is closed without inferred material defaults.
- The title and body follow the target repository's contracts, or the fallback above when none exist.
- Acceptance criteria and test scenarios are concrete enough for implementation and QA.
- Out-of-scope decisions are explicit.
- Feature Flag and Rollout rows are complete when a flag applies or explicitly marked `not applicable` with the user's reason when no repository contract requires one.
- Any feature flag supplements rather than replaces authorization, tenancy, billing, budget, resource-state, and safety enforcement.
- Repository labels were inspected. `PRD` will be applied only when it exists or is explicitly required, and the skill will not create it.
- Other metadata will be applied only when the user explicitly requested it or the repository requires it.
