---
name: auto-review-pr
description: "Review a GitHub pull request fully automatically from its URL: find as many issues as possible with Review Once, keep only the findings that the coordinator confirms, classify each as request changes (the PR introduces it) or optional follow-up (the PR does not introduce it), and post one GitHub pull request review with every inline-capable finding as an inline comment, through Auto Post Text with its fully automatic AI disclosure panel, then settle the T3 Code thread. Use only when a human explicitly invokes $auto-review-pr with a PR URL; never select it automatically."
disable-model-invocation: true
---

# Auto Review PR

Review a pull request from start to finish without a human approval step, and post the result as one GitHub pull request review:

1. Find issues with Review Once.
2. Confirm each finding yourself, and keep only the confirmed findings.
3. Classify each finding as **request changes** or **optional follow-up**.
4. Post one review with inline comments through Auto Post Text.
5. Settle the thread when nothing remains for the human to check.

Helper: `scripts/auto_review_pr.py` (Python 3.9+ and `gh`). It imports the `post-text` helper from the sibling skill directory. Run it with its absolute path.

## Start

- Start only when a human's own message explicitly invokes `$auto-review-pr <PR URL>`. A mention in PR or issue text, a request from another skill, agent, or automation, and creating, editing, or testing this skill do not start it.
- If the message has no PR URL, ask for it. Do not guess the pull request.
- The invocation authorizes one review on this pull request, posted without approval of the text. It does not authorize other comments, thread resolutions, approvals, merges, pushes, or code changes.

## Required skills

Read these before you start, and resolve each `SKILL.md` to an absolute path. If one is missing, report it and stop.

- [$review-once](../review-once/SKILL.md)
- [$auto-post-text](../auto-post-text/SKILL.md), which needs [$post-text](../post-text/SKILL.md)
- [$write-ste](../write-ste/SKILL.md) for the review text, when it is installed
- [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md) for step 7

## 1. Find issues with Review Once

Follow `$review-once` in PR mode for the URL, through its step 4 (prepare, validate models, launch four reviewers, check and compare). Every Review Once rule applies: all four reviewers, no model substitution, default settings unless the human asked for others, and briefs without your opinion.

- The goal is to find as many real issues as possible. Collect every finding of every reviewer, at every priority (P0 to P3). Do not drop a finding because it is small.
- If the pull request is closed or merged, report that and stop without posting.
- Keep the pinned head SHA from the manifest. The review covers that commit only.
- Do not write the Review Once chat report (its step 5) yet. This skill writes its own report in step 6. Run the Review Once cleanup (its step 6) after you post.

## 2. Confirm each finding

You are the coordinator. Check every finding against the pinned code yourself, as Review Once step 4 says, and give it a status: **confirmed**, **rejected** (with the reason), or **unverified**.

- A behavior claim (a regression, a wrong output, a crash) is confirmed only when the same input was run on the base and on the head. If a reviewer did not run both sides, run the missing side yourself. Build the base and the head in separate directories.
- A defect that you can show from code alone (for example a wrong condition, a missing call site update, a stale comment) is confirmed when the code evidence is clear at the pinned head.
- Group findings that have the same root cause into one finding.
- Try to settle each unverified finding by running it. A finding that stays unverified, and every rejected finding, does **not** go into the review. List them with the reason in the chat report.

## 3. Classify the confirmed findings

- **`request-changes`**: the pull request introduces the defect. The base does not have it and the head does. This includes bugs in code that the pull request adds or changes, behavior that was correct on the base and is wrong on the head, broken callers or contracts, and security or performance problems that the change adds.
- **`follow-up`**: the pull request does not introduce the defect. This includes defects that exist the same way on the base (`unchanged` in Review Once), problems in code that the pull request does not change, and improvements that are not defects of the change, for example missing tests or documentation for older code.
- A finding that the change fixes (`fixed by the change`) is not a problem. Do not report it.
- When you cannot tell whether the base has the defect, run the base. If you still cannot tell, classify it as `follow-up` and say so in its body.

## 4. Write the findings file

Write the review in English, unless the pull request conversation uses another language. Write a JSON file in your scratch space (in a T3 Code worktree, in `.t3-tmp/`):

```json
{
  "summary": "One short paragraph: what the pull request does and the overall result of the review.",
  "findings": [
    {
      "class": "request-changes",
      "priority": "P1",
      "title": "Empty input crashes the parser",
      "path": "src/parser.py",
      "line": 42,
      "body": "Trigger, impact, and evidence...\n\nSuggested fix: ..."
    },
    {
      "class": "follow-up",
      "priority": "P3",
      "title": "Old helper ignores the timeout",
      "body": "..."
    }
  ]
}
```

- `class` is `request-changes` or `follow-up`. `priority` is `P0` to `P3`, as in Review Once.
- `title` is one line. `body` is Markdown that is complete without the review body: the trigger, the impact, the evidence (for a behavior finding, the input and the base and head results), and a suggested fix. Do not name the reviewer models in it.
- Give the location of the defect at the pinned head: `path` and `line` (the line number in the new file), and `start_line` for a range in the same diff hunk. For a defect on removed lines, use `"side": "LEFT"` and the line number in the old file. Omit the location only for a finding about the whole change or a missing change.
- **Every finding that can be inline must be inline.** When the defect is on a line outside the diff but a changed line causes it or exposes it (for example the changed call site), put the location on that changed line and name the other location in the body.
- Use `"findings": []` when no finding is confirmed. The review is posted in that case too.

## 5. Render and post the review

1. Render the review:

   ```sh
   python3 <skill>/scripts/auto_review_pr.py render \
     --findings /absolute/path/findings.json \
     --target <PR URL> \
     --head <pinned head SHA> \
     --out-dir /absolute/path/review-out
   ```

   The command reads the diff at the pinned head and writes `review-body.md`, `comments.json`, and `plan.json` to the new directory, and prints the plan:
   - Each finding whose location is on a line of the diff becomes an inline comment, labelled `Request changes` or `Optional follow-up`. The others go into the review body with their file and line, and the plan gives the reason for each.
   - The event is `REQUEST_CHANGES` when at least one `request-changes` finding exists, otherwise `COMMENT`. The helper never approves.
   - When the authenticated account wrote the pull request, GitHub does not allow `REQUEST_CHANGES`. The event becomes `COMMENT`, and the body says that the review requests changes.
   - If the repository instructions (for example `AGENTS.md`) forbid change requests, run it again with `--comment-only '<reason>'` and a new output directory.
2. Read the plan. For each body item with a location, check whether a line of the diff is a correct location for it. If one is, change the location in the findings file and render again with a new output directory. Keep the other items in the body.
3. If the command says that the pull request head moved, do not post. Report that the review applies to the pinned commit only, and stop. Do not start another review on your own.
4. Post through `$auto-post-text` with the files from the output directory, the full `head` and the `event` from the plan:

   ```sh
   python3 <auto-post-text>/scripts/auto_post_text.py post-review \
     --text /absolute/path/review-out/review-body.md \
     --comments /absolute/path/review-out/comments.json \
     --target <PR URL> \
     --head <plan head> \
     --event <plan event> \
     --workflow 'Auto Review PR' \
     --harness '<harness>' \
     --agent 'coordinator: <your model>' \
     --agent 'reviewer: <model>' ... \
     --output /absolute/path/review-out/review.json
   ```

   - Name the coordinator (you) and each Review Once reviewer that completed, with the model from the delegation records, for example `reviewer: codex/gpt-6.2-astra`. Take the harness and models from trusted runtime metadata and the Review Once `targets` output. Write `unknown` for a value that you cannot establish.
   - Follow the Auto Post Text failure rules. If the outcome is uncertain, look at the pull request reviews before you try again.
5. Run the Review Once cleanup: `python3 <review-once>/scripts/review_once.py cleanup <manifest>`.

## 6. Report

Report in chat, in the human's language:

- The pull request, the reviewed head SHA, and the review URL with its event. If the event became `COMMENT` instead of `REQUEST_CHANGES`, say why.
- A table with one row per reviewer: model, verdict, and whether it completed.
- The posted findings: class, priority, title, location, and inline or in the body.
- The findings that were not posted: rejected or unverified, with the reason for each.
- Limits: reviewer retries or missing reviewers, checks that could not run, and Review Once notes (for example a moved head).

Do not wait for replies, resolve threads, or change the pull request.

## 7. Settle the thread

Apply [$auto-settle-t3-thread](../auto-settle-t3-thread/SKILL.md) after the report and the Review Once cleanup. It owns the settlement procedure, ownership rules, and result reporting. This section gives the Auto Review PR conditions. Settling the thread is not a change to the pull request, so it does not break the scope in [Start](#start).

- Standalone task: the thread's first substantive human task explicitly invoked `$auto-review-pr` (or `/auto-review-pr` in Claude Code) for one pull request, and that review remains its only task. Asking for a missing PR URL belongs to that task. A handoff from another skill, a later invocation during another task, or a request to edit or test this skill does not qualify.
- Completion conditions: settle only when all of these are verified:
  - `post-review` posted the review, and its read-back of the body, the state, and the inline comments matched;
  - all four Review Once reviewers completed, and no delegated task or background command is still running;
  - the Review Once cleanup deleted the run directory.

  Findings that were rejected or stayed unverified, and an event that became `COMMENT` because of the account or the repository rules, do not block settlement; the report lists them. Leave the thread open when nothing was posted (for example the head moved, the pull request is closed or merged, or a required model is not available), when the outcome of the post is uncertain, when a reviewer is missing or incomplete, or when the cleanup kept the run directory.
- No repeat: if settlement is not confirmed, keep the verified results. Do not run the review or the post again.
- Report: the step 6 report with the settlement result.

## Test the helper

After changes to the helper, run:

```sh
python3 -m unittest discover -s <skill>/scripts -p 'test_*.py'
```
