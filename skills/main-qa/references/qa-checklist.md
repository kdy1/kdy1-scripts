# MainQA coverage checklist

Use this reference to expand applicable checks within the selected QA scope. A human checklist remains authoritative: a narrowly requested scenario does not authorize testing its entire feature. Without a checklist, discover the whole app and apply every applicable dimension below. Record results per item and dimension; do not select only the easiest checks.

## Inventory and expectations

- Inventory first-party screens/routes, navigation destinations, visible controls, important role-dependent flows, and applicable initial, populated, loading, empty, error, and completed states.
- Use app requirements, UI promises, docs, configuration, and existing tests to establish expected behavior. Preserve uncertainty when they conflict or do not define an outcome; do not invent a product requirement to classify a preference as a bug.
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

Keep behavioral evidence distinct from root-cause proof. MainQA observations feed `$add-issue`; its investigation determines whether the cause is confirmed, whether it remains on the freshly fetched default branch, and whether a GitHub record can be written.
