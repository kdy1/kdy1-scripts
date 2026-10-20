---
name: design-ui
description: Design new or changed product UI, including direct UI changes and UI plans, specifications, or issues. Ground the design, create a preview, and obtain approval before implementation or finalizing the plan or issue text. Works in T3 Chat without a Plan Mode or mode switch. Implement approved designs in the same conversation only when authorized. Read-only inspection, screenshots without a change request, and editing this skill do not start the workflow.
---

# Design UI

## Goal

Produce an approved, implementation-ready design proposal for a new or existing
UI. Use proposal and implementation phases within the conversation. These phases
do not depend on an application mode or a mode-switch control.
After design approval, implement and verify the design in the same conversation
when implementation is within the authorized task.

## Entry Conditions

- Use this skill when explicitly invoked or when the authorized task requires
  designing a new or changed product UI. This includes direct UI changes and
  preparing issues, feature specifications, or implementation plans for UI
  changes; immediate product implementation is not required. Apply whether the
  UI design need is explicit or discovered while working on the task.
- Apply alongside other explicitly invoked skills, including `$add-issue`, when
  their task requires UI design. Naming another skill does not exclude this one,
  and the human does not need to name `$design-ui`. For example,
  "add period presets to the sidebar" ("사이드바에 기간 프리셋 추가") starts this
  workflow even when requested through `$add-issue` for a future feature issue.
- Once the UI design need is established, complete the preview and design
  approval steps before finalizing the implementation plan, feature
  specification, or issue text. Do not defer design until a later implementation
  request or a separate `$design-ui` invocation.
- Backend-only or other work without UI creation or changes, read-only UI
  inspection, a screenshot without a change request, and editing this skill
  do not start the design workflow.
- Start proposal work directly in the current conversation. Do not ask the user
  to enter or leave Plan Mode or require an equivalent application control.
- An approved design ready for authorized implementation resumes at step 4
  without another skill invocation or a mode switch.
- Selecting `$design-ui`, explicitly or automatically, starts proposal work
  only within the authorized task. It never authorizes GitHub issue creation or
  another external mutation.

## Workflow

1. Ground the proposal.
   - Read the target repository's instructions and authoritative contracts.
   - Inspect available UI source, design system, tokens, and relevant rendered
     states or supplied screenshots through read-only means. For a new UI, ground
     the proposal in feature requirements, user flows, and any available design
     system; an existing screen or screenshot is not required.
   - Resolve discoverable facts before asking the user about product intent.
   - Establish the target surface, users, goal, viewports, states, requirements
     or current gap, and behavior or content that must remain unchanged.
   - When requirements, existing UI, or supplied materials establish the final
     UI's language, use that language for UI text in previews and for actual UI
     copy included in the text specification. Do not infer the UI's language
     from the conversation language alone. If the UI's language is unknown,
     this rule does not impose one. It does not set the language of explanations
     or the conversation.

2. Create the preview with `$imagegen`.
   - Load and follow `$imagegen`, using its built-in tool mode by default and
     the `ui-mockup` use case.
   - If the final UI's language is known, specify it explicitly in the image
     generation prompt as the language for visible UI text.
   - Treat the output as preview-only. Render it inline and leave it in the
     image-generation default storage; do not copy it into the target repository
     or update consuming code.
   - Use an available current-UI screenshot as an edit target or reference when
     visual continuity matters. State each input image's role and preserve every
     agreed invariant.
   - Use supplied screenshots that show a wider area as context and style
     references. Explicitly instruct the prompt to show only the area being
     changed in each final preview submitted for approval. If changes affect
     several separate areas, create a separate preview for each area.
   - For a new UI without an existing screen, generate the preview from the
     grounded requirements and user flows, using any available design system.
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
     decision-complete design record. For each approved final preview, retain
     the actual absolute saved file path returned by image generation, target
     surface, viewport and state, caption or alt text, and final prompt. Keep the
     approved preview rendered inline, showing only the area being changed.
     Exclude unchanged surrounding UI, full-screen reference images, and
     discarded or superseded variants from the final plan. For example, when
     only the sidebar changes, include only the sidebar preview even if the
     supplied screenshot shows the whole screen. Ensure each saved path,
     description, and final prompt matches the actual approved image. Do not
     implement it during the proposal phase.
   - For issue preparation, supply the approved design record to the already
     authorized issue workflow before it finalizes the issue text. That workflow
     owns GitHub recording and image attachments under its existing restrictions.

4. Implement the approved design in the same conversation.
   - If implementation is part of the authorized task, continue after explicit
     approval of the preview and text specification. Do not require a mode
     switch or another implementation confirmation. For a proposal-only request,
     finish with the approved design record.
   - An issue-only request does not enter implementation. Design approval
     preserves that restriction; continue only the authorized issue workflow.
   - Continue from the approved design record without requiring another skill
     invocation or an issue handoff. Preserve the original task scope and
     restrictions; design approval does not authorize implementation of a
     proposal-only request.
   - Use the approved text specification and final previews to implement the
     new or revised UI in the target repository. Do not repeat completed proposal
     work or regenerate approved previews. If feedback or new evidence requires a
     design change, return to the proposal phase and obtain approval
     of the revised preview and text specification before implementing it.
   - Run the relevant checks and inspect the rendered result against the approved
     acceptance criteria, viewports, and states. Report the changes, verification
     results, and any remaining limitations in the same conversation.

## Approved Design References

- Treat the approved text specification as the durable source of truth and the
  image as supporting evidence.
- Keep the approved previews in the image-generation default storage. Use their
  saved paths, descriptions, and final prompts from the conversation as local
  implementation references. Do not copy into the target repository or commit
  the previews merely to preserve or share the design record.
- If an approved image is unavailable, continue from the self-contained text
  specification, description, and final prompt. Report the missing reference;
  do not silently regenerate or substitute the approved preview.

## Boundaries

- Never implement the UI design during the proposal phase before design approval.
- Never modify repository-tracked files during the proposal phase before design approval.
- This skill does not authorize invoking an issue-recording skill or writing to
  GitHub. When an issue workflow is already authorized, contribute the approved
  design record and leave GitHub actions to that workflow.
