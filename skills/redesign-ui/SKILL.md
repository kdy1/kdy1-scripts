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
   - Record the approved previews and text specification in the conversation's
     decision-complete Plan Mode result. For each approved final preview, retain
     the actual absolute saved file path returned by image generation, target
     surface, viewport and state, caption or alt text, and final prompt. Keep the
     preview rendered inline and exclude discarded or superseded variants from
     the handoff. Do not implement it or create/update a GitHub issue.

4. Require a separate `$add-issue` handoff.
   - While Plan Mode remains active, do not invoke `$add-issue` or perform a
     GitHub write.
   - After approval, tell the user to leave Plan Mode and send a new message that
     explicitly invokes `$add-issue`, for example:

     `Use $add-issue to record the approved redesign from this conversation, including the approved ImageGen previews and final prompts.`

   - The initial `$redesign-ui` invocation, design approval, or a generic request
     such as "file it" does not count as an explicit `$add-issue` invocation.
   - Only after the human explicitly invokes `$add-issue` outside Plan Mode,
     load and follow that skill in full. Let `$add-issue` independently classify,
     investigate, audit, and record the work; do not bypass any of its evidence,
     workspace-integrity, duplicate, metadata, or delegation requirements.

## Approved Image Handoff

- Treat the approved text specification as the durable source of truth and the
  image as supporting evidence.
- Pass the approved final images, their saved file paths and descriptions, final
  prompts, and text specification through `$add-issue`'s audited recording
  payload. Its recording phase must include the final prompts and attempt to
  attach the images to the new issue body or, when that writing path cannot
  include attachments, one image-handoff comment on the same issue. For an open
  duplicate, include missing approved visuals in its permitted handoff comment;
  do not attach images already recorded in the thread.
- Allow uploads only as GitHub-native attachments to the target issue during
  the separately authorized `$add-issue` recording phase. Never upload in Plan
  Mode, publish to external hosting, commit the images to the repository, or
  introduce another persistent mutation solely to make them available. Follow
  `$add-issue`'s attachment support checks, browser fallback, and verification.
- If attachment is unavailable or fails, continue with the self-contained text
  specification and final prompts. Describe the approved visual precisely enough
  that the implementer does not need access to the local image, and report which
  images were omitted and why. Never publish local paths as GitHub image links.

## Boundaries

- Never implement the redesign during this workflow.
- Never modify repository-tracked files during the Plan Mode proposal phase.
- Never create or update a GitHub issue from Plan Mode.
- Refer to the issue skill only as `$add-issue`, never by a local filesystem
  path.
