# MainQA coverage checklist

Use this reference to expand applicable checks within the selected QA scope. A human checklist remains authoritative: a narrowly requested scenario does not authorize testing its entire feature. Without a checklist, discover the whole app and apply every applicable dimension below. Record results per item and dimension; do not select only the easiest checks.

## Inventory and expectations

- Inventory first-party screens/routes, navigation destinations, visible controls, important role-dependent flows, and applicable initial, populated, loading, empty, error, and completed states.
- Use app requirements, UI promises, docs, configuration, and existing tests to establish expected behavior. For usability, also apply the criteria below to the observed existing flow; a documented requirement violation is not necessary to identify a concrete obstacle. Preserve uncertainty when sources conflict or the intended outcome is ambiguous; do not invent a product requirement to classify a preference as a bug.
- For equivalent dynamic record routes, test representative records and materially different states, including documented boundaries. Enumerate distinct behaviors and all explicitly listed items, not every possible data value. Note fixture/access limitations.
- Follow first-party links within the selected scope. Check the app's external-link/integration boundary when applicable; do not expand coverage to an unrelated website.

## Functional behavior

- Complete the primary user journey for each relevant screen/flow. Exercise each applicable control and check the observable result, retained data, confirmation, and destination against its expected behavior.
- Test forms with valid input and relevant empty, malformed, boundary, repeated-submit, and cancel inputs. Check validation feedback, focus, prevention of unintended writes, and correction/retry behavior.
- Cover list/search/filter/sort/pagination, dialogs, menus, uploads/downloads, and stateful actions where present. Check combinations that change behavior and nearby preserved paths rather than exhaustively enumerating equivalent permutations.
- Check authorized role/session boundaries where test accounts are available. Missing accounts or permissions are blocked coverage. Do not create accounts or alter real permissions merely to complete a checklist.

## Navigation and recovery

- Check internal links, direct route loading, refresh, back/forward navigation, and expected session/state persistence.
- Exercise loading, empty, error, and recoverable failure states when supported by fixtures or safe bounded simulation. Record when a state cannot be produced instead of assuming success.
- Verify cancel, dismiss, retry, and repeated actions behave consistently with the app's contract and avoid duplicate or unintended effects.

## Usability of existing flows

Apply these checks within the selected scope even when the functional action succeeds. Explain what information or control the user needs for an existing goal and how the observed UI makes it unclear or difficult to use.

- Check that button/link labels, icons, instructions, and terminology convey their action and relevant consequences. Identify ambiguity that could cause a wrong action or prevent choosing the intended one.
- Follow visible navigation to existing features and necessary controls. Check discoverability and prerequisites; do not invent a missing feature or guess hidden URLs to justify a candidate.
- Check that loading, success, and failure are recognizable through visible state or feedback. A successful save with no recognizable outcome can be a usability candidate; a separate toast is unnecessary when the resulting state already makes success clear.
- Check that initial, empty, and completed states make the next applicable action understandable. Distinguish a genuinely finished flow from one that strands the user before their existing goal is complete.
- Check that validation and recoverable errors explain what needs correction and how to retry or recover. Reproduce an error through an authorized path and show the missing or misleading guidance, rather than speculate about an unobserved failure.
- Compare equivalent controls and interactions for consistent meaning, affordances, and placement. Include hierarchy, layout, or styling inconsistencies only when they make actions hard to find, distinguish, understand, or operate. Exclude cosmetic spacing, alignment, color, or unfinished polish without usability impact and broad redesign proposals.

## Layout and accessibility

- Inspect representative desktop and mobile widths and material layout breakpoints from the app, respecting the user's requested device scope. Check overflow, clipping, overlaps, unreadable content, and operability of navigation and controls.
- Check keyboard reachability, visible focus, focus order, modal entry/return, dismissal, accessible names/labels, and conveyed errors using actual UI or available accessibility inspection.
- Check relevant contrast/readability and image/text alternatives where tools and evidence support a finding. State inspection limitations; do not claim a complete accessibility audit from a partial visual pass.

## Runtime signals

- Observe console errors and failed requests during each tested action when browser tools expose them. Associate signals with the action, response, visible impact, and relevant request/response evidence.
- Separate app-caused errors from extensions, expected validation/denial responses, third-party noise, and transient setup failures. A console message or non-2xx response alone is a candidate signal, not a confirmed defect.
- Redact credentials, cookies, tokens, personal/customer data, and sensitive request values. Preserve enough sanitized inputs, outputs, and timestamps to reproduce and investigate the behavior.

## Evidence and completion

For each item return its ID, checks performed, input/state, action, expected result and source, actual result, status, and evidence. Failed items additionally need reproducible steps, impact, and candidate references. Blocked or not-applicable checks need a concrete reason; do not count them as passes.

For each usability candidate, reproduce the obstacle once and capture the exact URL/screen, state, viewport, sanitized screenshot, steps and inputs, user's existing goal, concrete impact, and rationale tied to observed UI and these criteria or other expectation sources. If screenshot capture is unavailable, report the evidence blocker and preserve the candidate for follow-up; do not treat its recording evidence as complete.

Keep behavioral evidence distinct from root-cause proof and tentative classification. MainQA observations feed `$add-issue`; it applies causal proof at the identified investigation commit to `Bug` candidates, or resolves the bounded maintenance outcome and verification for `Task` candidates before deciding whether a GitHub record can be written. A bug confirmed on a non-default branch or detached HEAD does not require a default-branch comparison. Unresolved bug hypotheses cannot become `Task` candidates to bypass proof; cosmetic preferences and new feature proposals remain outside MainQA scope.
