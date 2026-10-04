---
name: slop-fix-repo-issues
description: "Collect open issues matching required user-specified conditions in the current repository once, then use $bulk to delegate each issue to $slop-fix-issue through PR creation. Start only when the human explicitly invokes $slop-fix-repo-issues."
---

# Slop Fix Repo Issues

Start only when the human explicitly invokes `$slop-fix-repo-issues` to fix repository issues and supplies selection conditions. That invocation and the supplied conditions authorize `$bulk` to create an item worktree chat for each issue in the fixed list collected for this run, and `$slop-fix-issue` to handle only that assigned issue through evidence-backed closure or PR creation. Loading, editing, or planning this skill does not start a run.

This is a one-shot batch. Do not register a watch or heartbeat, invoke PR maintenance, or add newly discovered issues after fixing the list. Collect results through issue closure or verified PR creation without waiting for CI, reviews, or merging.

## Require selection conditions

Accept the human's issue-selection conditions in natural language or as a GitHub search expression. If conditions are missing or ambiguous, ask a focused question and wait for the answer before searching or assigning issues. A bare skill invocation is not a request to process every open issue. An explicit request for all open issues is a valid selection condition.

Use `repo:<owner/repo> is:issue is:open` as the base scope. Translate natural-language conditions faithfully and combine them with that scope, preserving the meaning and grouping of supplied search expressions. Add author, label, or other selection filters only when the human specifies them. If conditions conflict with the current repository's open-issue scope, clarify before starting rather than silently changing or discarding them.

## Resolve and collect once

1. Read [$bulk](../bulk/SKILL.md) and [$slop-fix-issue](../slop-fix-issue/SKILL.md), resolving their installed `SKILL.md` files to absolute paths. PR publication through `$slop-fix-issue` additionally requires [$create-pr](../create-pr/SKILL.md). Report unavailable skills instead of substituting another workflow. Let each skill perform its own required preflight and let `$slop-fix-issue` check and invoke `$create-pr` when needed; evidence-backed issue closure does not need that publishing dependency.
2. Resolve the current checkout's GitHub host and repository through its remote and authenticated `gh` access, including the owning repository when already in a worktree. Ask if the repository cannot be resolved uniquely. Resolve the exact query from the required human conditions and base scope. Only when the human selects `author:@me`, including a natural-language request for issues they authored, record the authenticated login for that host and resolve that qualifier to the recorded author so the collection cannot change scope with authentication identity.
3. Search issues through authenticated `gh` on the resolved host using the exact query. Fetch all relevant pages and exclude pull requests. Check `incomplete_results`, the reported total, and pagination completeness; GitHub search exposes at most 1,000 results per query. A failed, partial, capped, or incomplete search is not an empty result. Report the limitation and do not dispatch from it or silently narrow the query.
4. Once collection succeeds, keep one canonical issue URL per verified host/repository/issue-number identity, preserving first-occurrence order. Record the fixed list, original conditions, exact query, recorded author when applicable, and authorization context in this chat. An empty list is a completed no-op: report it and stop without invoking `$bulk` or creating chats.

## Delegate the fixed list

Invoke `$bulk` with the fixed issue URL list and the common prompt below. Keep the original human invocation, delegation chain, selection conditions, resolved host/repository, exact query, recorded author, and authorized scope in the coordinator ledger. Do not pass shared context or extra instructions into item prompts. Forward concurrency and any explicitly requested starting Git state as dispatch settings.

### Common prompt

```text
$slop-fix-issue <issue_url>
```

Treat `<issue_url>` as the item placeholder and replace it with the assigned canonical issue URL. Require `create_thread.prompt` to equal that single line with no prefix, suffix, Markdown skill path, or additional context.

Let `$bulk` own item chats, coordination, result collection, and its existing automatic archiving rules, and let `$slop-fix-issue` own each issue's assessment, closure, or implementation through PR creation. A failed item or one needing input does not stop independent items. Report each item's actual outcome and links, including incomplete work and attachment or cleanup limitations, then end the batch.

On continuation in this chat, reuse the fixed list and `$bulk` ledger and resume only unfinished items. Do not repeat completed items, create duplicate chats or PRs, or search for additional issues. If the recorded list or ledger is unavailable, report the missing state and reconcile prior effects before replacement work; do not infer a new run from an automation prompt. Cancellation follows `$bulk`'s rules for queued and already assigned work.
