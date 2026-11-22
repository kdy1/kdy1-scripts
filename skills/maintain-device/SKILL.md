---
name: maintain-device
description: Maintain this machine in two parts. Free disk space until at least 50% of the volume's capacity is free (for example 1 TB on a 2 TB volume), or a requested target, by removing regenerable build output from idle agent worktrees and batch runs, safe tool caches and old unused Docker images, idle build output in the user's own projects, and finally old agent worktrees. Archive T3 Code automation threads, which scheduled tasks started, after 48 hours without activity. Run without questions and settle the T3 Code thread when both parts are complete. Start only on explicit `$maintain-device` invocation or a direct human request to run Maintain Device, free disk space, or archive old automation threads.
---

# Maintain Device

## Invocation and autonomy

Start only when the human invokes `$maintain-device` or directly asks to run Maintain Device, free disk space, or archive old automation threads. A scheduled task whose prompt the human wrote counts as a human request. Another agent's request, a handoff from another skill, or creating, editing, or testing this skill does not start a run.

A run has two parts: **Disk cleanup** and **Archive automation threads**. Do both, in that order. If the human asks for only one part, for example "free disk space", do only that part.

Run the whole workflow without questions. The defaults below are the human's standing decisions: target, deletion scope, idle thresholds, archive scope, and settlement. Use a different free-space target, extra exclusion, or idle threshold only if the human states it. Ask a question only if the run cannot continue without a human-only input, such as a password prompt. Do not ask for confirmation before you delete files in the allowed scope or archive threads in the archive scope.

## Disk cleanup

### Allowed scope

Delete only output that a build or package manager can regenerate, old unused Docker images, and old agent worktrees. The helper enforces this scope:

1. **Agent artifacts:** Cargo `target/`, `node_modules`, `.next`, `.nuxt`, `.turbo`, `.svelte-kit`, `.parcel-cache`, and SwiftPM `.build` directories under agent-owned roots (`~/.t3/worktrees`, `~/.t3` and `~/.codex` batch and artifact directories, `~/.claude/slop-fix-batch`, `~/.codex/slop-fix-batch`, and `/private/tmp`). Each directory must sit next to a matching manifest, or carry Cargo's `CACHEDIR.TAG`. The helper deletes candidates oldest-activity first.
2. **Tool caches:** `npm`, `pnpm store prune`, `yarn`, `bun`, the Go build cache, `uv cache prune`, `pip`, Homebrew downloads, Docker build cache, dangling images, and unused images created more than 7 days ago, unavailable simulators, and Xcode DerivedData. The helper skips a cache while its tool is running. Docker itself keeps every image that a container, running or stopped, still uses.
3. **Project artifacts:** the same artifact types under `~/projects`, with a longer idle threshold.
4. **Old worktrees:** whole linked git worktrees at `~/.t3/worktrees/<repo>/<name>`, the last resort after tiers 1 to 3. The helper removes a worktree with `git worktree remove` (never `--force`) and then runs `git worktree prune`. It deletes the oldest first. It never deletes the branch. It removes a worktree only if all of these are true:
   - Nothing in the worktree's top-level entries, or in its git index or HEAD, changed within 3 days. This includes worktrees nested in it, such as review checkouts in `.t3-tmp/`.
   - No process has its working directory in it, and it is not in the current working directory or an `--exclude` path.
   - Git can stash any staged, unstaged, and untracked changes in it and in registered worktrees nested in it. The helper uses `git stash push --include-untracked` before removal. If a stash fails or changes remain, it keeps the worktree. Stashes stay in the repository and are listed by worktree path in the JSON report. Use `git stash list` to find them and `git stash apply --index` to restore one. Ignored files such as `target` are not stashed.
   - It is not the main worktree and not locked.
   - If its HEAD is detached, a local branch, remote branch, or tag contains that commit. A worktree on a branch keeps its commits on that branch.

The helper skips an artifact if a process has its working directory anywhere in that checkout, if the checkout's git index or HEAD, the artifact's top levels, or its parent changed within the idle threshold (24 hours for agent roots, 7 days for `~/projects`), or if it is in the current working directory or an `--exclude` path. It never follows symlinks. Just before each deletion, it checks activity and safety again.

Never delete source checkouts, any git worktree outside tier 4, batch run state, session histories, databases, Docker volumes or containers, toolchains, Time Machine snapshots, or files in `~/Downloads`, `~/Documents`, or `~/Desktop`. Do this even when the target is not met. Never delete anything under `~/projects` except the tier 3 artifacts. Do not delete anything by hand outside the helper.

### Run

Use Python 3.9+. Resolve the script path relative to this skill directory.

1. Check the current state:

   ```sh
   python3 scripts/disk_cleanup.py status --json
   ```

   The default target is 50% of the capacity of the volume that contains `$HOME`, so a 2 TB volume must have 1 TB free after the run. The helper reads the capacity (`totalBytes`) and free space from that volume and reports sizes in decimal GB, as Finder and `diskutil` do. If the human states a different target, pass it as `--target-percent <percent>` or `--target-gb <GB>`, in both commands. If `met` is `true`, delete nothing. Note the free space and go to **Archive automation threads**.

2. Clean until the target is met:

   ```sh
   python3 scripts/disk_cleanup.py run --json
   ```

   The helper performs the tiers in order. It checks free space after each deletion or cache command and stops as soon as the target is met. `--worktree-idle-hours` (default 72) and `--docker-image-idle-hours` (default 168) change the thresholds of tier 4 and of unused Docker images. Use them only if the human states a different threshold. Exit code `0` means the target is met. Exit code `2` means the allowed scope did not free enough space. A large run can take many minutes, so run it in the background and wait for it with `t3_background_wait` when that is available. Do not interrupt a run while it deletes files.

   Use `--dry-run` only when the human asks for a preview. It measures candidates with `du` and simulates the result without deleting anything.

3. Read the JSON report: `initialFreeBytes`, `finalFreeBytes`, `freedBytes`, `actions`, `skippedByReason`, and `errors`. Treat a `failed` action as a fact to report. Do not retry it with broader commands or elevated privileges.

### Target not met

If the report says `met: false`, find out where the remaining space is, but do not delete anything else. Measure only the largest directories, for example with `du -sh` on the top-level directories of `$HOME`, `~/.t3`, `~/.claude`, and `~/.codex`. List the largest remaining items, say which ones are regenerable but were skipped (and why, from `skippedByReason`), and say which ones need a human decision, such as worktrees the helper kept (stash failure, a commit on no ref, recent activity, a running process), batch run directories, Docker images that containers use, session data, or toolchains. Do not ask the human to choose during this run. Continue with **Archive automation threads**, and leave the thread open, as **Completion** describes.

## Archive automation threads

An automation thread is a top-level T3 Code thread that a scheduled task started. The helper identifies one by its first run: that run starts from a message whose id begins with `scheduled-task-message:`. A thread that a human started and that a scheduled task later sends messages to is not an automation thread.

### Archive scope

Archive an automation thread only if all of these are true. The helper enforces them:

- Its last activity (thread creation, the latest run start or end, or the latest message update) is at least 48 hours old.
- No run in it is active (`preparing`, `queued`, `starting`, `running`, or `waiting`).
- It is not pinned, not archived or deleted already, not a subagent or child thread, and not the current thread.

Archive a thread in scope even if it is not settled. The 48-hour rule is the human's standing decision. Report the unsettled ones by title so that the human can find them under archived threads. Archive only; never delete a thread, and never change, pause, or delete a scheduled task.

### Run

1. List the candidates. Pass the current thread's id, which `t3_thread_list` returns as `currentThreadId`:

   ```sh
   python3 scripts/automation_threads.py list --exclude-thread <current-thread-id> --json
   ```

   The helper opens the T3 Code state database (`~/.t3/userdata/statev2.sqlite`, or `$T3CODE_HOME/userdata/statev2.sqlite`) read-only and changes nothing. `--idle-hours` (default 48) changes the threshold. Use it only if the human states a different one. Exit code `1` means that the database is missing or unreadable; report the error and skip this part.

2. For each item in `candidates`, call the T3 tool `t3_thread_organize` with `{"action":"archive","threadId":"<threadId>"}`. Load the tool once with ToolSearch if it is deferred. The calls are independent, so send them in parallel batches. If a call fails, record the error and continue. Do not retry with other tools, and never write to the database directly.

3. Run the step 1 command again. An archived thread is no longer a candidate. A thread that is still listed is a failed archive; report it.

4. Read the report: `candidateCount`, `unsettledCandidateCount`, `candidates` (`title`, `scheduledTaskTitle`, `lastActivityAt`, `settled`), and `skippedByReason`.

## Completion

- Report briefly:
  - Disk cleanup: free space before and after, the target and the volume capacity, whether it was met, the space freed per tier, the largest removed items, any saved stashes, skip counts by reason, and any errors. For a run where the target was already met, report only the free space and the target.
  - Automation threads: the number of archived threads per scheduled task, the titles of archived threads that were not settled, skip counts by reason, and any failed archives.
- Then apply [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md). It owns the settlement procedure and result reporting. The Maintain Device conditions are:
  - Standalone task: this skill was the first substantive human task of the thread, and maintenance remains its only task.
  - Completion conditions: the disk target is met, including when it was already met before the run, every archive candidate is archived (the second list returns no candidate), and no background work is still running. Errors on individual disk items do not prevent settlement if the target is met. Leave the thread open when the target is not met or an archive failed. When the human asked for only one part, apply only that part's conditions.
  - No repeat: if settlement is not confirmed, do not run the cleanup or the archive again.

## Validation

After you change a helper, run the offline checks:

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
```
