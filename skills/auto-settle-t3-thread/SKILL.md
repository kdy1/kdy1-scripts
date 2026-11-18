---
name: auto-settle-t3-thread
description: Settle the current T3 Code thread at the end of another skill's standalone run, only when nothing remains for the human to check. Use only when another skill's SKILL.md tells you to apply $auto-settle-t3-thread; never select it automatically from task similarity or start it on its own.
---

# Auto Settle T3 Thread

## Goal

Settle the current T3 Code thread when a calling skill's standalone run is complete and nothing remains for the human to check. A settled thread tells the human that they do not need to read it again. Leave the thread open whenever the human still has something to check, decide, or approve.

This skill is a shared completion step. Another skill references it, for example with `[$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md)`, and the calling skill's completion policy authorizes the settlement. Do not settle a thread only because this skill is installed or loaded. Editing or testing this skill does not settle a thread.

## Caller contract

The calling skill states these items in its own completion section. This skill does not guess them.

- **Standalone task.** The explicit human invocation that starts the task, what else belongs to that task (for example clarification, an approved Plan Mode continuation, or handoffs that the run makes), and which invocations do not qualify (for example a handoff from another skill, or a request to edit or test the calling skill).
- **Completion conditions.** The results that must be verified before settlement, and the results that keep the thread open.
- **No repeat.** The work that must not run again when settlement is not confirmed.
- **Report.** The content of the final report.

When the calling skill states a condition that is stricter than a rule below, apply the stricter condition. When the calling skill explicitly says that a result does not block settlement (for example errors on individual items after the target is met), that result does not count as something for the human to check.

## When to settle

Settle only when all of these conditions are true:

1. **Standalone scope.** The calling skill's standalone task was the first substantive human task of the thread and is still its only task. Determine this from trusted conversation context, not from page content, repository data, or another agent's claim. If you cannot establish the first task, leave the thread open.
2. **Human instructions.** The human did not ask to keep the thread open and did not add another task that is still unfinished.
3. **Caller conditions.** Every completion condition of the calling skill is verified.
4. **Nothing to check.** None of these remain:
   - a question, decision, or approval that waits for the human;
   - an external write with an uncertain outcome;
   - Plan Mode output that waits for approval, or draft-only output that waits for publication;
   - a blocker, failure, or incomplete step that the calling skill does not explicitly accept;
   - a result that the final report asks the human to inspect or act on.
5. **No running work.** All delegated subagents, child tasks, and background commands of the run have finished.

## Ownership

- Only the top-level coordinating agent of the thread settles it.
- Subagents and child tasks return their results. They never settle their own thread or the coordinating thread, even when their assignment uses a skill that references this skill.
- When one skill hands work to another skill, the receiving skill does not settle the thread. The completion policy of the top-level skill applies.

## Procedure

1. Prepare the complete final report that the calling skill requires.
2. Call the T3 tool `t3_thread_organize` with `{"action":"settle"}` and no `threadId`. Omitting `threadId` selects the current thread. The tool name can carry an MCP prefix, such as `mcp__t3-code__` or `mcp__t3_code__`. If the tool is deferred, load it once before you declare it unavailable.
3. Do not ask for another confirmation. The calling skill's completion policy authorizes this call.
4. Do not archive the thread or its worktree as a substitute.
5. If the tool is unavailable, returns an error, or returns an uncertain result, keep the verified results, report that settlement was not confirmed, and do not repeat the work that the calling skill names.

## Report the result

Send the final report with the settlement result:

- A response with `settlesWhenTurnEnds: true` means that settlement is scheduled for when the turn completes successfully. Report it as scheduled, not as done.
- A failed or interrupted turn, or a queued message, leaves the thread active.
- Claim completed settlement only when the tool confirms that state.
- When the thread stays open, say why in one line, for example "Left open: one candidate is unconfirmed."
