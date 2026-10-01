---
name: slop-maintain-repo-prs
description: "Watch my open PRs in the current repository with $bulk-watch and delegate each PR to $slop-maintain-pr. Start only when the human explicitly invokes $slop-maintain-repo-prs."
---

# Slop Maintain Repo PRs

Start only when the human explicitly invokes `$slop-maintain-repo-prs` to maintain their PRs. That invocation authorizes `$bulk-watch` to create an item worktree chat for each existing or subsequently discovered matching PR, and `$slop-maintain-pr` to maintain that assigned PR in its item chat. Loading, editing, or planning this skill does not start a watch.

## Resolve and delegate

1. Read [$bulk-watch](../bulk-watch/SKILL.md) and [$slop-maintain-pr](../slop-maintain-pr/SKILL.md), resolving their installed `SKILL.md` files to absolute paths. Confirm their required dependencies before delegation; report missing dependencies instead of substituting another workflow.
2. Resolve the current checkout's GitHub host and repository through its remote and authenticated `gh` access, including the owning repository when already in a worktree. Ask only if the repository cannot be resolved uniquely. Record the authenticated login for that host as the author represented by `@me`; if that identity changes on a later read, reconcile before admitting items from a different author.
3. Explicitly invoke `[$bulk-watch](<absolute-bulk-watch-skill-path>)` with the source and common prompt below, replacing both skill-path placeholders and the source placeholders. Supply shared context containing the original human invocation, the delegation chain, the resolved host/repository/author and exact query, and the authorized task of maintaining only each assigned PR. Preserve that context in the watch record, saved heartbeat, and every item chat.
4. Forward any user-specified interval to both the watch and PR maintenance; otherwise let each skill preserve its existing cadence or use its five-minute default. Forward concurrency and any explicitly requested starting Git state to `$bulk-watch`.

### Source

```text
Search GitHub pull requests on <github-host> in <owner/repo> matching:
repo:<owner/repo> is:pr is:open author:@me
Include draft PRs. Use the recorded authenticated author when continuing this same watch.
```

### Common prompt

```text
Explicitly invoke [$slop-maintain-pr](<absolute-slop-maintain-pr-skill-path>) with the assigned PR's exact URL. Carry the original human invocation, delegation chain, and authorized repository/query/task scope supplied in shared context as the authorization origin. Forward the user's interval when specified. Report whether maintenance was registered or reused, its owner and cadence, and the first maintenance-pass outcome or blocker. Follow that skill's handling of existing maintenance owners and merged or closed PRs.
```

Let `$bulk-watch` own discovery, scheduling, item chats, deduplication, and coordination, and let `$slop-maintain-pr` own each PR's maintenance. An item's registration and first-pass result are distinct from the PR reaching a terminal state; record the actual outcome without waiting for the PR to merge before dispatching other items. Stopping the watch follows `$bulk-watch`'s rules and does not itself stop PR maintenance in item chats.
