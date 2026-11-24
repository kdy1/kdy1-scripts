---
name: post-review
description: "Post review findings on a GitHub pull request as one review, through Post Text with its human approval step, and choose the review event from the finding priorities and the pull request author: Request Changes for any P0 or P1; for P2, Request Changes when the author is an external contributor (GitHub author association) and a non-blocking review when the author is a team member; P3 findings are posted but never block. A non-blocking review is a comment, and an approval (Approve with changes, or Approve) only when the human asks to approve. Use only when a human explicitly invokes $post-review (or /post-review) or asks to run Post Review; never select it automatically."
disable-model-invocation: true
---

# Post Review

Post the findings of a pull request review as one GitHub review, with the event that the priority policy chooses. [$post-text](../post-text/SKILL.md) drafts, shows, and posts the review: this skill adds the policy, the labels, and the layout.

| Findings | Author | Verdict and event | When the human asks to approve |
| --- | --- | --- | --- |
| Any P0 or P1 | Any | Request changes, `REQUEST_CHANGES` | Not allowed |
| P2 (no P0 or P1) | External contributor | Request changes, `REQUEST_CHANGES` | Not allowed |
| P2 (no P0 or P1) | Team member | Changes suggested, `COMMENT` | Approve with changes, `APPROVE` |
| Only P3 | Any | No blocking problems, `COMMENT` | Approve, `APPROVE` |
| None | Any | No problems found, `COMMENT` | Approve, `APPROVE` |

P3 findings are always posted, labelled non-blocking, and never change the verdict.

**Approve only when the human asks.** The skill uses `APPROVE` only when the human's own message in this conversation asks to approve the pull request, for example "approve해줘" or "approve with changes로 올려". The `$post-review` invocation, the policy, a reviewer's verdict, and approval of a draft review are not a request to approve.

Helper: `scripts/post_review.py` (Python 3.9+ and `gh`). It imports the `post-text` helper from the sibling skill directory. Run it with its absolute path.

## Start

- Start only when a human's own message explicitly invokes `$post-review` (or `/post-review` in Claude Code), or asks to run Post Review. A request from another skill, agent, or automation, and creating, editing, or testing this skill, do not start it.
- The invocation is the human's request for the event that the policy chooses: `REQUEST_CHANGES` or `COMMENT`. It is not a request to approve (see **Approve only when the human asks** above). Post Text still requires human approval of the exact review, its destination, and its event before it posts.
- The invocation authorizes one review on one pull request. It does not authorize other comments, thread resolutions, merges, pushes, or code changes.
- If the pull request is not clear from the message or the conversation, ask for its URL. Do not guess.

## Required skills

Read these before you start, and resolve each `SKILL.md` to an absolute path. If `post-text` is missing, report it and stop.

- [$post-text](../post-text/SKILL.md): its rules for grounding, language, provenance, approval, and posting apply to every step below.
- [$write-ste](../write-ste/SKILL.md) for the summary and the finding bodies, when it is installed.

## 1. Collect the findings

- Use the findings in the current conversation: for example the result of `$review-pr` or `$review-once` on this pull request, or findings that the human gave. If there are none, ask the human which findings to post, or whether to run `$review-pr` or `$review-once` first. Do not review the pull request in this skill.
- Include the findings that were confirmed and the findings that the human told you to include. Leave out rejected findings. For an unverified finding, ask the human whether to include it.
- Give each finding a priority. Keep the priority from the source review, unless the human gave another one. When a finding has no priority, use the Review Once definitions: P0 data loss, a security hole, or a crash on a common path; P1 wrong behavior that users will hit; P2 wrong behavior in an edge case, or a missing test for changed behavior; P3 a small defect, for example a misleading message or a stale comment. Show each priority that you assigned in the approval step.
- Find the reviewed commit: the pinned head SHA of the source review. If you cannot establish it, ask the human. Do not assume that the findings apply to the current head.

## 2. Write the findings file

Write the review in the language that Post Text selects. The helper writes the verdict, the labels, and the counts in English. Write a JSON file in your scratch space (in a T3 Code worktree, in `.t3-tmp/`):

```json
{
  "summary": "One short paragraph: what the pull request does and the overall result of the review.",
  "findings": [
    {
      "priority": "P2",
      "title": "Empty input skips the cache update",
      "path": "src/cache.py",
      "line": 42,
      "body": "Trigger, impact, and evidence..."
    },
    {"priority": "P3", "title": "The error message names the old option", "body": "..."}
  ]
}
```

- `priority` is `P0` to `P3`. `title` is one line. `body` is Markdown that is complete without the review body: the trigger, the impact, and the evidence. Do not name the reviewer models in it.
- Do not write a fix. A finding states the problem only: no suggested fix, no patch or replacement code, and no GitHub ```` ```suggestion ```` block. When a source finding has a suggested fix, leave it out. `render` stops when a body has a `suggestion` block or a line that starts with `Suggested fix`.
- Give the location of the defect at the reviewed commit: `path` and `line` (the line number in the new file), and `start_line` for a range in the same diff hunk. For a defect on removed lines, use `"side": "LEFT"` and the line number in the old file. Omit the location only for a finding about the whole change or a missing change.
- When the defect is on a line outside the diff but a changed line causes it or exposes it, put the location on that changed line and name the other location in the body.
- Use `"findings": []` when there is no finding. The review then says that it found no problems.

## 3. Render the review

```sh
python3 <skill>/scripts/post_review.py render \
  --findings /absolute/path/findings.json \
  --target <PR URL> \
  --head <reviewed commit SHA> \
  --out-dir /absolute/path/review-out
```

The command reads the pull request, its author, and its diff, writes `review-body.md`, `comments.json`, and `plan.json` to the new directory, and prints the plan.

- **Approval.** Add `--approve` only when the human asked to approve the pull request. Then a review that the policy does not block is `APPROVE`. When the policy requests changes, `--approve` fails: tell the human why, and ask whether a priority or the author role is wrong. Do not approve against the policy. When the human asks to approve after they saw a draft, render again with `--approve` and a new output directory.

- **Author role.** The author is a team member when the GitHub author association of the pull request is `OWNER`, `MEMBER`, or `COLLABORATOR`, and an external contributor otherwise. The plan shows the login, the role, and its source. The body does not name the role. If the human says that the role is wrong, render again with `--author team` or `--author external` and a new output directory.
- **Placement.** Each finding whose location is on a line of the diff becomes an inline comment, labelled `P0`/`P1` `Blocking`, `P2` `Fix before merge`, or `P3` `Non-blocking`. The others go into the review body with their file and line, and the plan gives the reason for each. For each body item with a location, check whether a line of the diff is a correct location. If one is, fix the location in the findings file and render again with a new output directory.
- **Event limits.** When the authenticated account wrote the pull request, GitHub does not allow `APPROVE` or `REQUEST_CHANGES`; the event becomes `COMMENT`, and the body keeps the verdict and says why. This applies only to those two events. When the repository instructions (for example `AGENTS.md`) forbid the event, tell the human. Unless they confirm the event, render again with `--comment-only '<reason>'` and a new output directory.
- If the command says that the head moved, the findings do not apply to the current head. Tell the human and stop. If the pull request is closed or merged, report that and stop.

## 4. Prepare and approve through Post Text

Follow `$post-text` for a pull request review, with the rendered files, the plan event, and the plan head:

```sh
python3 <post-text>/scripts/post_text.py prepare-review \
  --text /absolute/path/review-out/review-body.md \
  --comments /absolute/path/review-out/comments.json \
  --target <PR URL> \
  --harness '<harness>' \
  --agent '<model>' \
  --event <plan event> \
  --head <plan head> \
  --output /absolute/path/review-out/review.json
```

- Name the harness and every AI agent that contributed to the findings and the text, as Post Text requires. For a `$review-once` result, include each reviewer that completed.
- Show the complete `show-review` output and the digest, as Post Text requires. Before it, show the plan in short: the author login, role, and its source; the verdict and the event; the counts for each priority; and the priorities that you assigned.
- Ask the human to approve this exact review, its destination, and its event. Then end the turn.
- When the human asks for changes, change the findings file (or the role or event options), and run `render` and `prepare-review` again with new output paths. Get approval of the new review.

## 5. Post and report

After explicit approval, post with `post_text.py post-review` and the approved digest, and follow the Post Text rules for verification and failures. If the head moved, the command posts nothing: tell the human, and do not render the findings for the new head unless they confirm that the findings still apply.

Report in the human's language: the review URL, the verdict and the event (and why it is `COMMENT`, if it is), the author role, and the number of inline comments and body items.

## Test the helper

After changes to the helper, run:

```sh
python3 -m unittest discover -s <skill>/scripts -p 'test_*.py'
```
