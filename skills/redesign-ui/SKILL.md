---
name: redesign-ui
description: Plan and visualize a UI redesign before handing approved work to GitHub issue creation. Use only when a human explicitly invokes `$redesign-ui`; never select it automatically from UI feedback, redesign requests, screenshots, or issue-planning similarity.
---

# Redesign UI

## Goal

Produce an approved, implementation-ready UI redesign proposal without changing
the product, then hand the proposal to `$add-issue` only after a separate explicit
human invocation.

## Entry Conditions

- A human must explicitly invoke `$redesign-ui`. Do not infer invocation from a
  redesign request or similar context.
- Run the redesign workflow only in Plan Mode. If Plan Mode is not active, ask
  the user to switch to Plan Mode and explicitly invoke `$redesign-ui` again,
  then stop. Do not inspect the product, generate an image, modify files, or
  start an issue workflow in that invocation.
- The `$redesign-ui` invocation authorizes proposal work only. It never
  authorizes GitHub issue creation or another external mutation.

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
   - Record the approved preview, final prompt, and text specification in the
     conversation's decision-complete Plan Mode result. Do not implement it or
     create/update a GitHub issue.

4. Require a separate `$add-issue` handoff.
   - While Plan Mode remains active, do not invoke `$add-issue` or perform a
     GitHub write.
   - After approval, tell the user to leave Plan Mode and send a new message that
     explicitly invokes `$add-issue`, for example:

     `Use $add-issue to record the approved redesign from this conversation.`

   - The initial `$redesign-ui` invocation, design approval, or a generic request
     such as "file it" does not count as an explicit `$add-issue` invocation.
   - Only after the human explicitly invokes `$add-issue` outside Plan Mode,
     load and follow that skill in full. Let `$add-issue` independently classify,
     investigate, audit, and record the work; do not bypass any of its evidence,
     workspace-integrity, duplicate, metadata, or delegation requirements.

## Approved Image Handoff

- Treat the approved text specification as the durable source of truth and the
  image as supporting evidence.
- If the permitted GitHub issue-writing path can include the approved image as
  part of the issue record, attach it. Do not perform a separate upload, publish
  it to external hosting, commit it to the repository, or introduce another
  persistent mutation solely to make the image available.
- If attachment is unavailable or fails, continue with the self-contained text
  specification and describe the approved visual precisely enough that the
  implementer does not need access to the local image.

## Boundaries

- Never implement the redesign during this workflow.
- Never modify repository-tracked files during the Plan Mode proposal phase.
- Never create or update a GitHub issue from Plan Mode.
- Refer to the issue skill only as `$add-issue`, never by a local filesystem
  path.
