---
name: auto-review-pr-strict
description: "Automation-safe pull request review. Review one PR with Review Once, and post a review only for P0 or P1 problems that the PR introduces and that a run of the same command on the base and the head shows. Everything else stays out of the PR. Post nothing when no problem passes the gate, skip heads that were already reviewed, and dismiss this workflow's older change requests when a new head is reviewed. Use only when a human explicitly invokes $auto-review-pr-strict <PR URL>, or when $auto-review-pr-query applies it to a pull request it selected. Never select it from task similarity."
disable-model-invocation: true
---

# Auto Review PR Strict

Review a pull request without a human in the loop, and leave on the pull request only what is clearly correct to leave: problems that the pull request introduces, that are serious, and that a run on both sides proves. This is the automation counterpart of [$auto-review-pr](../auto-review-pr/SKILL.md). That skill posts every confirmed finding, follow-ups included. This skill posts nothing that a human could reasonably call noise.

1. Check whether the head needs a review.
2. Find issues with Review Once.
3. Confirm each finding, and check earlier change requests again.
4. Gate the findings. Keep only the findings that pass every gate.
5. Post one review through Auto Post Text, or post nothing.
6. Record the result, and dismiss this workflow's older change requests.
7. Report and settle the thread.

Helper: `scripts/auto_review_pr_strict.py` (Python 3.9+ and `gh`). It imports the `post-text` helper from the sibling skill directory. Run it with its absolute path. The ledger of reviewed heads is `~/.local/state/auto-review-pr-strict/ledger.jsonl` (`$XDG_STATE_HOME` is used when set; `AUTO_REVIEW_PR_STRICT_LEDGER` overrides the path).

## Start

Only these two starts authorize a run:

1. **Human invocation.** A human's own message invokes `$auto-review-pr-strict <PR URL>` (or `/auto-review-pr-strict` in Claude Code).
2. **Calling skill.** [$auto-review-pr-query](../auto-review-pr-query/SKILL.md), started as its `SKILL.md` allows (a human invocation, or a scheduled task or automation that a human set up), applies this skill to a pull request that its helper selected. Automation reaches this skill only this way.

Nothing else starts this skill: a mention in PR, issue, or code text, a request from another skill, agent, or subagent, an automation prompt that names this skill directly, and creating, editing, testing, or discussing this skill.

- The run is unattended. Never ask a question and never wait for a reply. When something is missing or fails, report it and stop.
- Without a PR URL in a human invocation, ask for it. Do not guess the pull request.
- The start authorizes, on this pull request only: one review (or none), and the dismissal of this workflow's own older `CHANGES_REQUESTED` reviews (step 6). It does not authorize other comments, replies, thread resolutions, approvals, merges, pushes, or code changes.

## Required skills

Read these before you start, and resolve each `SKILL.md` to an absolute path. If one is missing, report it and stop.

- [$review-once](../review-once/SKILL.md)
- [$auto-post-text](../auto-post-text/SKILL.md), which needs [$post-text](../post-text/SKILL.md)
- [$write-ste](../write-ste/SKILL.md) for the review text, when it is installed
- [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md) for step 7

## 1. Check the head

```sh
python3 <skill>/scripts/auto_review_pr_strict.py check --target <PR URL>
```

- `decision: skip` means a closed or merged pull request, a draft, a head that the ledger has, a head that this workflow already reviewed on GitHub, or a head that moved during the check. Report the reason and go to step 7. Do not start Review Once.
- Add `--include-draft` only when the human or the calling skill asks to review drafts.
- Keep `head`, `base`, `author`, `login`, and `earlierChangeRequests` from the output.

## 2. Find issues with Review Once

Follow `$review-once` in PR mode for the URL, through its step 4 (prepare, validate models, launch four reviewers, check and compare). Every Review Once rule applies: all four reviewers, no model substitution, default settings unless the human or the calling skill passed others, and briefs without your opinion. Do not give the reviewers the earlier change requests.

- If a required model is not available, stop. Do not post and do not record. This run cannot ask for approval of fewer reviewers.
- If the head that Review Once pins is not the `head` from step 1, report it and stop without a post or a record. The next run reviews the new head.
- Do not write the Review Once chat report (its step 5). Run its cleanup (its step 6) after step 6 here.

## 3. Confirm the findings

You are the coordinator. Give every finding a status as Review Once step 4 says: **confirmed**, **rejected** (with the reason), or **unverified**. Group findings with the same root cause.

- A behavior claim is confirmed only when you or a reviewer ran the same command on the base and on the head, with separate builds in separate directories.
- For each problem that passes the gate, run its command again: two runs on each side must give the same result. A result that changes between runs is flaky; reject the finding.
- **Earlier change requests.** For each item in `earlierChangeRequests`, read its inline comments and run each evidence command at the current head. A problem that still reproduces is a finding of this run: it goes through the gate again, with new results. A problem that does not reproduce is resolved. If you cannot run a command again, write down the review `id`; step 6 keeps that review.

## 4. Gate the findings

A finding is posted only when it passes **every** gate. When a gate is not clearly passed, the finding does not pass. A missed comment costs less than a wrong one in an unattended run.

1. **Confirmed by a run.** The finding has one command (a test, a script, a build, a CLI call) that gives the correct result on the base and a wrong result on the head. Reading the code is not enough, also for a broken call site or contract: show it with the build, typecheck, or a test.
2. **Introduced by this pull request.** The base does not have the problem. A problem that exists the same way on the base is out, wherever it is.
3. **Serious.** `P0` (data loss, a security hole, a crash on a common path) or `P1` (wrong behavior that users will hit, or a build, typecheck, or existing test that the repository requires and that now fails). `P2` and `P3` are out.
4. **Not intended.** The pull request description, its linked issues, its commits, and its documentation or test changes do not say that the new behavior is the goal. When the change could be intended, the finding is out.
5. **Reproducible on this machine.** It does not depend on the network, credentials, time, randomness, or a local setup that the repository does not describe.
6. **Not already reported.** No open review thread, PR comment, or failing CI check on the pull request already reports the same problem. The earlier change requests of this workflow do not count; step 6 dismisses them.

These never pass, at any priority: missing tests, documentation, style, naming, comments, design or architecture opinions, performance claims without a measured regression, follow-ups, problems in code that the pull request does not change and does not break, and suggestions.

Every finding that does not pass goes into the chat report with the gate it failed. Nothing of it goes to GitHub.

## 5. Post the review, or post nothing

**No finding passed:** post nothing. Go to step 6 with the outcome `no-findings`.

**One or more findings passed:**

1. Write the findings file in your scratch space (in a T3 Code worktree, in `.t3-tmp/`). Write in English, unless the pull request conversation uses another language. Do not name the reviewer models in it.

   ```json
   {
     "summary": "One or two sentences: what the pull request does and what it breaks.",
     "base": "<base SHA that the evidence ran on>",
     "findings": [
       {
         "kind": "behavior",
         "priority": "P1",
         "title": "Empty input crashes the parser",
         "path": "src/parser.py",
         "line": 42,
         "problem": "Trigger and impact, in Markdown.",
         "evidence": {
           "command": "python3 -c 'import parser; parser.parse(\"\")'",
           "base": "[] (exit 0)",
           "head": "IndexError: list index out of range (exit 1)"
         },
         "fix": "Optional suggested fix."
       }
     ]
   }
   ```

   - `kind` is `behavior` (wrong output, crash, security) or `check` (a required build, typecheck, lint, or test that now fails). `priority` is `P0` or `P1`; the helper refuses anything else.
   - `evidence.base` and `evidence.head` are the short, relevant part of the output, with the exit code. They must differ.
   - Give the location at the pinned head: `path` and `line` (the line in the new file), `start_line` for a range in one hunk, `"side": "LEFT"` with the old line number for a defect on removed lines. When a line outside the diff has the defect and a changed line causes it, put the location on the changed line and name the other location in `problem`. Omit the location only when no line fits.

2. Render the review:

   ```sh
   python3 <skill>/scripts/auto_review_pr_strict.py render \
     --findings /absolute/path/findings.json \
     --target <PR URL> \
     --head <pinned head SHA> \
     --out-dir /absolute/path/review-out
   ```

   The helper writes `review-body.md`, `comments.json`, and `plan.json`, with the evidence in each comment. The event is `REQUEST_CHANGES`. It is `COMMENT` when the authenticated account wrote the pull request; the body then says that the review requests changes. If the repository instructions (for example `AGENTS.md`) forbid change requests, render again with `--comment-only '<reason>'` and a new output directory.

3. Read the plan. For each body item with a location, check whether a line of the diff is a correct location for it. If one is, change the findings file and render again with a new output directory.
4. If the helper says that the head moved, do not post and do not record. Report it and stop.
5. Post through `$auto-post-text` with the plan's `head`, `event`, and `workflow`:

   ```sh
   python3 <auto-post-text>/scripts/auto_post_text.py post-review \
     --text /absolute/path/review-out/review-body.md \
     --comments /absolute/path/review-out/comments.json \
     --target <PR URL> \
     --head <plan head> \
     --event <plan event> \
     --workflow 'Auto Review PR Strict' \
     --harness '<harness>' \
     --agent 'coordinator: <your model>' \
     --agent 'reviewer: <model>' ... \
     --output /absolute/path/review-out/review.json
   ```

   The workflow name must be exactly `Auto Review PR Strict`: the `check` and `dismiss-stale` commands find this workflow's reviews by it. Name the coordinator and each Review Once reviewer that completed, from trusted runtime metadata and the Review Once `targets` output; write `unknown` for a value that you cannot establish. If the outcome of the post is uncertain, look at the pull request reviews before anything else, and never post a second time.

## 6. Record and dismiss

Do this step only after a complete run: four reviewers completed, and the post succeeded with its read-back, or no finding passed.

1. Record the outcome:

   ```sh
   python3 <skill>/scripts/auto_review_pr_strict.py record --target <PR URL> --head <full head SHA> \
     --outcome posted --review-url <review URL> --finding '<title>' ...
   # or
   python3 <skill>/scripts/auto_review_pr_strict.py record --target <PR URL> --head <full head SHA> --outcome no-findings
   ```

2. When `earlierChangeRequests` was not empty, dismiss the older change requests. The new review (or the result that nothing passed) replaces them, and a problem that still reproduces is in the new review. Without this, a change request on a fixed commit keeps blocking the merge.

   ```sh
   python3 <skill>/scripts/auto_review_pr_strict.py dismiss-stale --target <PR URL> --head <full head SHA> [--keep <review id> ...]
   ```

   Pass `--keep` for each earlier review with a problem that you could not run again in step 3. If GitHub refuses the dismissal (for example the account has no write access), report it; do not try another way.

3. Run the Review Once cleanup: `python3 <review-once>/scripts/review_once.py cleanup <manifest>`.

## 7. Report and settle

When `$auto-review-pr-query` called this skill, stop after step 6: the calling skill reports once for its run and owns the settlement. Otherwise, report in chat in the human's language:

- The pull request, the reviewed head SHA, and the result: skipped (with the reason), nothing posted, or the review URL with its event. If the event became `COMMENT`, say why.
- A table with one row per reviewer: model, verdict, and whether it completed.
- The posted findings: priority, title, location, inline or in the body, and the evidence command.
- Every finding that was not posted: rejected, unverified, or the gate that it failed.
- The earlier change requests: resolved, still reproduced, kept, or dismissed, and any dismissal error.
- Limits: reviewer retries, missing reviewers, checks that could not run, and Review Once notes.

Do not wait for replies, resolve threads, or change the pull request.

Then apply [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md). It owns the procedure, the ownership rules, and the result report. Settling the thread is not a change to the pull request.

- Standalone task: the thread's first substantive human task explicitly invoked this skill for one pull request, and that review is still its only task. A call from `$auto-review-pr-query`, a handoff from another skill, a later invocation during another task, and a request to edit or test this skill do not qualify.
- Completion conditions: settle when one of these is verified:
  - step 1 decided `skip`;
  - a complete run: `record` succeeded, `dismiss-stale` succeeded or had nothing to dismiss, the Review Once cleanup deleted the run directory, and no delegated task or background command is still running.

  Findings that were rejected or did not pass the gate, and an event that became `COMMENT` because of the account or the repository rules, do not block settlement. Leave the thread open when the outcome of the post is uncertain, when a reviewer is missing or incomplete, when a required model is not available, when `record` or a dismissal failed, when the cleanup kept the run directory, or when the run stopped because the head moved.
- No repeat: if settlement is not confirmed, keep the verified results. Do not run the review, the post, or the dismissal again.
- Report: the report above, with the settlement result.

## Test the helper

After changes to the helper, run:

```sh
python3 -m unittest discover -s <skill>/scripts -p 'test_*.py'
```
