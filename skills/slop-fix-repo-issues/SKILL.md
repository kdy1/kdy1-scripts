---
name: slop-fix-repo-issues
description: "Watch my open issues in the current repository with $bulk-watch and delegate each issue to $slop-fix-issue. Start only when the human explicitly invokes $slop-fix-repo-issues."
---

# Slop Fix Repo Issues

Start only when the human explicitly invokes `$slop-fix-repo-issues` to fix their issues. That invocation authorizes `$bulk-watch` to create an item worktree chat for each existing or subsequently discovered matching issue, `$slop-fix-issue` to handle that assigned issue, and `$slop-maintain-pr` to maintain the resulting PR. Loading, editing, or planning this skill does not start a watch.

## Resolve and delegate

1. Read [$bulk-watch](../bulk-watch/SKILL.md) and [$slop-fix-issue](../slop-fix-issue/SKILL.md), resolving their installed `SKILL.md` files to absolute paths. Report unavailable skills instead of substituting another workflow. Let each skill perform its own required preflight, including `$slop-fix-issue`'s distinction between evidence-backed closure and implementation dependencies.
2. Resolve the current checkout's GitHub host and repository through its remote and authenticated `gh` access, including the owning repository when already in a worktree. Ask only if the repository cannot be resolved uniquely. Record the authenticated login for that host as the author represented by `@me`; if that identity changes on a later read, reconcile before admitting items from a different author.
3. Explicitly invoke `[$bulk-watch](<absolute-bulk-watch-skill-path>)` with the source and common prompt below, replacing both skill-path placeholders and the source placeholders. Supply shared context containing the original human invocation, the delegation chain, the resolved host/repository/author and exact query, and the authorized task of handling only each assigned issue and maintaining its resulting PR. Preserve that context in the watch record, saved heartbeat, and every item chat.
4. Forward any user-specified interval to both the watch and issue workflow for its PR maintenance; otherwise let each scheduling skill preserve its existing cadence or use its five-minute default. Forward concurrency and any explicitly requested starting Git state to `$bulk-watch`.

### Source

```text
Search GitHub issues on <github-host> in <owner/repo> matching:
repo:<owner/repo> is:issue is:open author:@me
Use the recorded authenticated author when continuing this same watch.
```

### Common prompt

```text
Explicitly invoke [$slop-fix-issue](<absolute-slop-fix-issue-skill-path>) with the assigned issue's exact URL. Carry the original human invocation, delegation chain, and authorized repository/query/task scope supplied in shared context as the authorization origin. Forward the user's interval when specified. Handle only this assigned issue; do not select another. Report its state, evidence-comment or PR links, verification, and maintenance handoff's registration and first-pass outcome or blockers.
```

Let `$bulk-watch` own discovery, scheduling, item chats, deduplication, and coordination, and let `$slop-fix-issue` own issue resolution and its handoff to `$slop-maintain-pr`. Record an item's actual closure or PR creation and maintenance handoff outcome without waiting for the PR to merge before dispatching other items. Stopping the watch follows `$bulk-watch`'s rules and does not itself stop assigned issue work or PR maintenance in item chats.
