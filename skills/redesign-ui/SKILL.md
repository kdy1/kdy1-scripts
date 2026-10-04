---
name: redesign-ui
description: Select automatically only in Plan Mode for product UI changes, including layout, styling, components, content, interaction, navigation, or responsive behavior. Outside Plan Mode, do not select automatically; explicit `$redesign-ui` invocation requires a switch to Plan Mode before proposal work. Plan and visualize the redesign, then implement the approved design in the same conversation after leaving Plan Mode when implementation is authorized. Read-only UI inspection, a screenshot alone, or editing this skill does not trigger the redesign workflow.
---

# Redesign UI

## Goal

Produce an approved, implementation-ready UI redesign proposal in Plan Mode.
After leaving Plan Mode, implement and verify the approved design in the same
conversation when implementation is within the authorized task.

## Entry Conditions

- Use this skill automatically only when Plan Mode is active and the authorized
  task requires changing a product's UI, whether the change is requested directly
  or identified while working on the task. The human does not need to name
  `$redesign-ui`.
- Outside Plan Mode, do not select this skill automatically or ask for a mode
  switch solely because the task requires UI changes.
- Read-only UI inspection, a screenshot without a change request, or editing
  this skill does not start the redesign workflow.
- Run the proposal phase only in Plan Mode. If the human explicitly invokes
  `$redesign-ui` outside Plan Mode to start proposal work, ask the user to switch
  to Plan Mode, then stop. Do not inspect the product, generate an image, or
  modify files before the mode change. Resume the proposal phase in Plan Mode
  without requiring another explicit skill invocation.
- An approved design ready for authorized implementation resumes at step 4
  outside Plan Mode. This continues the existing workflow and does not count as
  a new automatic skill selection.
- Selecting `$redesign-ui`, explicitly or automatically, starts proposal work
  only within the authorized task. It never authorizes GitHub issue creation or
  another external mutation.

## Workflow

1. Ground the proposal.
   - Read the target repository's instructions and authoritative contracts.
   - Inspect the current UI source, design system, tokens, and relevant rendered
     states or supplied screenshots through read-only means.
   - Resolve discoverable facts before asking the user about product intent.
   - Establish the target surface, users, goal, viewports, states, current gap,
     and behavior or content that must remain unchanged.

2. Create the preview with `$imagegen`.
   - Load and follow `$imagegen`, using its built-in tool mode by default and
     the `ui-mockup` use case.
   - Treat the output as preview-only. Render it inline and leave it in the
     image-generation default storage; do not copy it into the target repository
     or update consuming code.
   - Use an available current-UI screenshot as an edit target or reference when
     visual continuity matters. State each input image's role and preserve every
     agreed invariant.
   - Show the final prompt with the preview, validate it against the grounded
     constraints, and iterate with one targeted change per feedback round.

3. Obtain approval and freeze the design record.
   - Require unambiguous human approval of a specific preview and its associated
     text specification. Feedback or a requested change invalidates earlier
     approval and returns the workflow to preview iteration.
   - Make the text specification authoritative and sufficient without the image.
     Include the target surface and viewports, information hierarchy, layout,
     components and content, visual treatment and token intent, interaction and
     navigation behavior, loading/empty/error/permission states, responsive
     behavior, keyboard/focus/accessibility requirements, preserved behavior,
     compatibility constraints, acceptance criteria, test scenarios, and
     explicit out-of-scope work.
   - Record the approved previews and text specification in the conversation's
     decision-complete Plan Mode result. For each approved final preview, retain
     the actual absolute saved file path returned by image generation, target
     surface, viewport and state, caption or alt text, and final prompt. Keep the
     preview rendered inline and exclude discarded or superseded variants from
     the approved design record. Do not implement it during the proposal phase.

4. Implement the approved design in the same conversation.
   - If implementation is part of the authorized task, tell the user to leave
     Plan Mode after design approval. While Plan Mode remains active, retain the
     approved design record without modifying product files. For a proposal-only
     request, finish with the approved Plan Mode result.
   - Once Plan Mode is no longer active, continue from the approved design record
     without requiring another skill invocation or an issue handoff. Preserve
     the original task scope and restrictions; leaving Plan Mode does not
     authorize implementation of a proposal-only request.
   - Use the approved text specification and final previews to implement the
     redesign in the target repository. Do not repeat completed proposal work or
     regenerate approved previews. If feedback or new evidence requires a
     design change, return to the proposal phase in Plan Mode and obtain approval
     of the revised preview and text specification before implementing it.
   - Run the relevant checks and inspect the rendered result against the approved
     acceptance criteria, viewports, and states. Report the changes, verification
     results, and any remaining limitations in the same conversation.

## Approved Design References

- Treat the approved text specification as the durable source of truth and the
  image as supporting evidence.
- Keep the approved previews in the image-generation default storage. Use their
  saved paths, descriptions, and final prompts from the conversation as local
  implementation references. Do not upload, copy into the target repository, or
  commit the previews merely to preserve or share the design record.
- If an approved image is unavailable, continue from the self-contained text
  specification, description, and final prompt. Report the missing reference;
  do not silently regenerate or substitute the approved preview.

## Boundaries

- Never implement the redesign during the Plan Mode proposal phase.
- Never modify repository-tracked files during the Plan Mode proposal phase.
- Do not invoke an issue-recording skill or create/update a GitHub issue as part
  of this workflow.
