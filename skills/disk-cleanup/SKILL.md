---
name: disk-cleanup
description: Free disk space on this machine until the volume has at least 400 GB free (or a requested target), by removing only regenerable build output from idle agent worktrees and batch runs, safe tool caches, and then idle build output in the user's own projects. Do nothing when enough space is already free. Run without questions and settle the T3 Code thread when the target is met. Start only on explicit `$disk-cleanup` invocation or a direct human request to run Disk Cleanup or free disk space.
---

# Disk Cleanup

## Invocation and autonomy

Start only when the human invokes `$disk-cleanup` or directly asks to run Disk Cleanup or free disk space. Another agent's request, an automatic workflow, or creating, editing, or testing this skill does not start a run.

Run the whole workflow without questions. The defaults below are the human's standing decisions: target, deletion scope, idle thresholds, and settlement. Use a different free-space target, extra exclusion, or idle threshold only if the human states it. Ask a question only if the run cannot continue without a human-only input, such as a password prompt. Do not ask for confirmation before you delete files in the allowed scope.

## Allowed scope

Delete only output that a build or package manager can regenerate. The helper enforces this scope:

1. **Agent artifacts:** Cargo `target/`, `node_modules`, `.next`, `.nuxt`, `.turbo`, `.svelte-kit`, `.parcel-cache`, and SwiftPM `.build` directories under agent-owned roots (`~/.t3/worktrees`, `~/.t3` and `~/.codex` batch and artifact directories, `~/.claude/slop-fix-batch`, `~/.codex/slop-fix-batch`, and `/private/tmp`). Each directory must sit next to a matching manifest, or carry Cargo's `CACHEDIR.TAG`. The helper deletes candidates oldest-activity first.
2. **Tool caches:** `npm`, `pnpm store prune`, `yarn`, `bun`, the Go build cache, `uv cache prune`, `pip`, Homebrew downloads, Docker build cache and dangling images, unavailable simulators, and Xcode DerivedData. The helper skips a cache while its tool is running.
3. **Project artifacts:** the same artifact types under `~/projects`, with a longer idle threshold.

The helper skips an artifact if a process has its working directory anywhere in that checkout, if the checkout's git index or HEAD, the artifact's top levels, or its parent changed within the idle threshold (24 hours for agent roots, 7 days for `~/projects`), or if it is in the current working directory or an `--exclude` path. It never follows symlinks. Just before each deletion, it checks activity and safety again.

Never delete source checkouts, git worktrees, batch run state, session histories, databases, Docker volumes or containers, toolchains, Time Machine snapshots, or files in `~/Downloads`, `~/Documents`, or `~/Desktop`. Do this even when the target is not met. Do not delete anything by hand outside the helper.

## Run

Use Python 3.9+. Resolve the script path relative to this skill directory.

1. Check the current state:

   ```sh
   python3 scripts/disk_cleanup.py status --target-gb 400 --json
   ```

   The helper uses decimal GB, as Finder and `diskutil` do, and reads free space from the volume that contains `$HOME`. If `met` is `true`, delete nothing. Report the free space and go to **Completion**.

2. Clean until the target is met:

   ```sh
   python3 scripts/disk_cleanup.py run --target-gb 400 --json
   ```

   The helper performs the tiers in order. It checks free space after each deletion or cache command and stops as soon as the target is met. Exit code `0` means the target is met. Exit code `2` means the allowed scope did not free enough space. A large run can take many minutes, so run it in the background and wait for it with `t3_background_wait` when that is available. Do not interrupt a run while it deletes files.

   Use `--dry-run` only when the human asks for a preview. It measures candidates with `du` and simulates the result without deleting anything.

3. Read the JSON report: `initialFreeBytes`, `finalFreeBytes`, `freedBytes`, `actions`, `skippedByReason`, and `errors`. Treat a `failed` action as a fact to report. Do not retry it with broader commands or elevated privileges.

## Target not met

If the report says `met: false`, find out where the remaining space is, but do not delete anything else. Measure only the largest directories, for example with `du -sh` on the top-level directories of `$HOME`, `~/.t3`, `~/.claude`, and `~/.codex`. List the largest remaining items, say which ones are regenerable but were skipped (and why, from `skippedByReason`), and say which ones need a human decision, such as old worktrees, batch run directories, Docker images, or toolchains. Do not ask the human to choose during this run. Leave the thread open, as **Completion** describes.

## Completion

- Report briefly: free space before and after, the target, whether it was met, the space freed per tier, the largest removed items, skip counts by reason, and any errors. For a run where the target was already met, report only the free space and the target.
- Settle the current thread when this skill was the first substantive human task of the thread, cleanup remains its only task, the target is met (including when it was already met before the run), and no background work is still running. Errors on individual items do not prevent settlement if the target is met. Leave the thread open when the target is not met, when the human asked to keep it open, or when the human added another unfinished task.
- To settle, prepare the final report, then call `mcp__t3_code__t3_thread_organize` with `{"action":"settle"}` and no `threadId`. This completion policy authorizes settlement without another confirmation. Do not archive the thread or its worktree instead. If the tool is unavailable or returns an error or an uncertain result, say that settlement was not confirmed; do not run the cleanup again.
- A response with `settlesWhenTurnEnds: true` means that settlement is scheduled for when the turn completes successfully. Report it as scheduled, not as done. Claim completed settlement only when the tool confirms that state.

## Validation

After you change the helper, run its offline checks:

```sh
python3 -m unittest discover -s scripts -p 'test_disk_cleanup.py'
```
