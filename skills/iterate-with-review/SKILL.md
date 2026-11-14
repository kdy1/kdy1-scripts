---
name: iterate-with-review
description: "Repeat Review Once on a PR or local change, judge every finding, apply and commit the valid fixes, and review again, until one Review Once round finds no problem. Use only when the user explicitly invokes $iterate-with-review or asks to run Iterate with Review. Requires the review-once skill."
---

# Iterate with Review

Improve a change through repeated independent reviews:

1. Run Review Once on the change.
2. Judge every finding. Apply and commit the valid ones.
3. Run Review Once again.

Stop only after a **clean round**. A clean round is a Review Once round in which all four reviewers completed, no finding was applied, and every finding was rejected with code evidence. There is no round limit.

Helper: `scripts/iterate_with_review.py` (Python 3.9+, Git 2.31+, and `gh` for PRs). It imports the `review-once` helper from the sibling `review-once` skill directory. Read `../review-once/SKILL.md` before the first round, and follow it for every review. Run the helpers with their absolute paths.

## Boundaries

- An Iterate with Review invocation authorizes edits and local commits on the target branch, in the target workspace. It does not authorize a push, a PR comment, a merge, or a force operation. For a PR, push at the end only if the user asked to update the PR; otherwise report the local commits and ask.
- Do not edit the workspace while Review Once reviewers are running.
- Stop early only when the user cancels, or for a blocker that you cannot resolve: a reviewer model is unavailable, authentication fails, or reviewers fail again after retries. Report a blocker as "paused, not finished", with the ledger path. Never describe a paused run as clean.
- Never reject a valid finding to end the loop. "Minor", "nit", or "not worth it" is not a reason to reject. Small valid findings are applied.

## 1. Choose the target and workspace

- **PR:** If the current checkout is already on the PR branch, use it. Otherwise run:

  ```sh
  python3 <skill>/scripts/iterate_with_review.py pr-workspace <PR_URL> [--repo <local clone>] [--dest <path>]
  ```

  It reuses a worktree that is on the PR branch, or creates one with `gh pr checkout --worktree` next to the clone. It needs a local clone of the repository; if none exists, ask where to clone.
- **Local:** Use the current repository and branch, or the directory that the user names. A detached HEAD is not supported; ask which branch to use.

Each round reviews committed `HEAD`. If the workspace has uncommitted changes at the start, ask the user whether to commit them as they are or to stop. Do not stash or discard them.

## 2. Start the ledger

```sh
python3 <skill>/scripts/iterate_with_review.py init --workspace <dir> [--pr <PR_URL>] [--base <ref>] [--intent-file <file>]
```

- For a PR, the helper fetches the base branch from the remote that points at the PR's repository, uses `<remote>/<base>` as the base for every round, and writes the PR title and body to the intent file.
- Pass `--intent-file` with the user's stated goal when they give one.
- Use `--base` when the user names a base, or when no PR exists and the default base is wrong.
- The command prints the ledger path, the fixed `base`, and the `intentFile`. Keep the ledger path. To resume an interrupted run, read the ledger with `status` and continue from its last round. Do not run `init` again for the same branch.

## 3. Run rounds

Repeat until a round is clean:

1. **Start:** `python3 <skill>/scripts/iterate_with_review.py round-start <ledger>`. It fails if the workspace has uncommitted changes or the previous round was not recorded.
2. **Review:** Follow Review Once steps 1–4 in local mode:

   ```sh
   python3 <review-once>/scripts/review_once.py prepare-local --path <workspace> --base <ledger base> [--intent-file <ledger intentFile>]
   ```

   Then validate targets, launch the four reviewers, verify the checkouts, and check every finding against the code, as Review Once describes. Reviewers get only the Review Once brief. Do not tell them the round number, earlier findings, or your decisions. Run Review Once `cleanup` after the round's findings are judged.
3. **Judge each finding.** Give each one a disposition:
   - `applied`: the finding is a real defect, a missing case, test, or update, or a clearly better approach within the change's scope. Severity does not matter.
   - `rejected`: the code shows that the claim is false; or it contradicts the stated intent, a repository rule, or an earlier user decision. Write the evidence, for example `src/x.rs:42 already checks for null`. A finding that was rejected before can come back; check it again against the current code, and reject it again only if the evidence still holds.
   - **Ask the user** when a finding needs a product or design decision, when a finding argues for a different approach, or when findings in different rounds pull in opposite directions. Then apply or reject according to the answer, and use `User decision: <answer>` as the evidence. Add the decision to the intent file, so that later reviewers know it was made deliberately.
4. **Apply.** Fix the `applied` findings in the workspace. Keep each fix minimal and in scope. Run the tests, linters, and builds that cover the changed code. If a check fails, fix it before you continue. Commit each fix, or each group of findings with the same root cause, as a separate commit that follows the repository's commit rules.
5. **Record.** Write the round result as JSON and run `python3 <skill>/scripts/iterate_with_review.py round-record <ledger> <result.json>`:

   ```json
   {
     "reviewers": [{"slug": "astra", "complete": true, "verdict": "approve"}, "... sol, opus, sonnet"],
     "findings": [
       {"id": "R1-F1", "priority": "P1", "title": "...", "location": "path:line",
        "reporters": ["opus", "sol"], "disposition": "applied", "commits": ["<sha>"]},
       {"id": "R1-F2", "priority": "P3", "title": "...", "reporters": ["astra"],
        "disposition": "rejected", "evidence": "..."}
     ]
   }
   ```

   List all four reviewers. Use `complete: false` for a reviewer that stayed missing or incomplete after the Review Once retry. The helper checks the result. Applied findings need new commits on the branch, and rejected findings need evidence. It prints the round status:
   - `fixed`: fixes were applied. Start the next round.
   - `incomplete`: a reviewer did not complete. Start the next round. If the same model fails again, the run is blocked.
   - `clean`: the run is finished.
6. **Report progress** in one or two lines: round number, verdicts, applied and rejected counts.

## 4. Finish

When a round is clean:

1. Run `python3 <skill>/scripts/iterate_with_review.py summary <ledger>`.
2. Report in the user's language:
   - The target, workspace, branch, and base.
   - The summary table, and the number of rounds.
   - The applied fixes, grouped by round, with commit SHAs.
   - The findings rejected in the final clean round, with evidence, so that the user can check them.
   - The checks you ran, and anything that you could not run.
   - Push status. For a PR, either confirm the push or say that the commits are local, and ask whether to push.
3. If `pr-workspace` created a worktree, leave it in place and give its path.
