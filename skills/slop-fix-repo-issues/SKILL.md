---
name: slop-fix-repo-issues
description: "Watch open issues matching required user-specified conditions in the current repository with $bulk-watch and delegate each issue to $slop-fix-issue. Start only when the human explicitly invokes $slop-fix-repo-issues."
---

# Slop Fix Repo Issues

Start only when the human explicitly invokes `$slop-fix-repo-issues` to fix repository issues and supplies selection conditions. That invocation and the supplied conditions authorize `$bulk-watch` to create an item worktree chat for each existing or subsequently discovered matching issue, `$slop-fix-issue` to handle that assigned issue, and `$slop-maintain-pr` to maintain the resulting PR. Loading, editing, or planning this skill does not start a watch.

## Require selection conditions

Accept the human's issue-selection conditions in natural language or as a GitHub search expression. If conditions are missing or ambiguous, ask a focused question and wait for the answer before invoking `$bulk-watch`, registering a watch, or assigning issues. A bare skill invocation is not a request to process every open issue. An explicit request for all open issues is a valid selection condition.

Use `repo:<owner/repo> is:issue is:open` as the base scope. Translate natural-language conditions faithfully and combine them with that scope, preserving the meaning and grouping of supplied search expressions. Add author, label, or other selection filters only when the human specifies them. If conditions conflict with the current repository's open-issue scope, clarify before starting rather than silently changing or discarding them.

## Resolve and delegate

1. Read [$bulk-watch](../bulk-watch/SKILL.md) and [$slop-fix-issue](../slop-fix-issue/SKILL.md), resolving their installed `SKILL.md` files to absolute paths. Report unavailable skills instead of substituting another workflow. Let each skill perform its own required preflight, including `$slop-fix-issue`'s distinction between evidence-backed closure and implementation dependencies.
2. Resolve the current checkout's GitHub host and repository through its remote and authenticated `gh` access, including the owning repository when already in a worktree. Ask if the repository cannot be resolved uniquely. Resolve the exact query from the required human conditions and base scope. Only when the human selects `author:@me`, including a natural-language request for issues they authored, record the authenticated login for that host as the selected author. For that filter, include instructions to use the recorded author when continuing this watch and reconcile an authentication identity change before admitting items from a different author.
3. Explicitly invoke `[$bulk-watch](<absolute-bulk-watch-skill-path>)` with the source and common prompt below, replacing both skill-path placeholders and the source placeholders. Supply shared context containing the original human invocation, the delegation chain, the human's selection conditions verbatim, the resolved host/repository and exact query, the recorded author when applicable, and the authorized task of handling only each assigned issue and maintaining its resulting PR. Preserve the conditions, query, and shared context in the watch record, saved heartbeat, and every item chat; continuing the same watch must use its recorded selection scope unless the human changes it.
4. Forward any user-specified interval to both the watch and issue workflow for its PR maintenance; otherwise let each scheduling skill preserve its existing cadence or use its five-minute default. Forward concurrency and any explicitly requested starting Git state to `$bulk-watch`.

### Source

```text
Search GitHub issues on <github-host> in <owner/repo> matching this exact resolved query:
<resolved-issue-query>

Original human selection conditions:
<user-selection-conditions-verbatim>
```

### Common prompt

```text
Explicitly invoke [$slop-fix-issue](<absolute-slop-fix-issue-skill-path>) with the assigned issue's exact URL. Carry the original human invocation, delegation chain, and authorized repository/query/task scope supplied in shared context as the authorization origin. Forward the user's interval when specified. Handle only this assigned issue; do not select another. Report its state, evidence-comment or PR links, verification, and maintenance handoff's registration and first-pass outcome or blockers.
```

Let `$bulk-watch` own discovery, scheduling, item chats, deduplication, and coordination, and let `$slop-fix-issue` own issue resolution and its handoff to `$slop-maintain-pr`. Record an item's actual closure or PR creation and maintenance handoff outcome without waiting for the PR to merge before dispatching other items. Stopping the watch follows `$bulk-watch`'s rules and does not itself stop assigned issue work or PR maintenance in item chats.
