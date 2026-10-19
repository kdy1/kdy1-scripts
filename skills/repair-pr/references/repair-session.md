# Repair session commands

Resolve `repair-pr.mjs` relative to the installed skill. Run it from the target checkout. New commands emit JSON; `--json` is accepted for consistency with `status`. Exit 0 means that command completed, not that every review finding or CI failure is fixed. Exit 1 means a blocker, incomplete read, failed operation, or uncertain outcome. No command watches or polls CI.

## Preflight and initialization

```sh
node "<helper>" preflight --pr <number-or-url> --json
node "<helper>" session init --file <absolute-session-path> --pr <number-or-url>
```

`--pr` defaults to the current branch's PR. Preflight is read-only: it neither fetches, checks out, acquires ownership, nor registers a stack. It returns canonical PR identity (host/owner/repository case is normalized), SHA, branch, base/push remotes, Git operations, worktrees, registry membership, GitHub relationships, available gh-stack state, and `blockers`. A successful registry lookup with no membership is insufficient to classify a PR as ordinary. Nondefault bases, related open PRs, or catalog membership require stack reconciliation. Missing gh-stack is acceptable for a verified ordinary PR; errors from an installed gh-stack normally remain blockers. Ambiguous remotes require deliberate configuration, not an assumed `origin`.

gh-stack keeps its catalog per worktree. If its specific error says the checked-out PR head branch is not part of a stack, preflight can report `catalogStatus: "absent-in-worktree"` only after complete open-PR relationship reads find no related layers, the PR targets the repository default branch, any registered stack has exactly one layer, and a fresh authenticated native-stack read returns explicit `stack: null` at the same PR URL/head/base identity. Authentication errors, missing/unsupported fields, changed identities, native stack membership and other CLI failures still block. A registered singleton keeps stack mode, its common-directory owner/token and its original session snapshot; this fallback never creates a catalog, releases ownership or treats a multi-layer stack as ordinary.

Read repository instructions separately. For an explicit PR, the sole checkout-required blocker can be handled after ownership checks; rerun preflight after checkout. Other blockers require reconciliation. A linked worktree holding the head branch cannot be stolen. Initialization requires a clean matching branch and a local tip equal to the PR remote head; pre-existing ahead commits require reconciliation.

Store the session, record inputs, snapshots, reply files, and logs outside tracked source. A convenient directory is `<git-common-dir>/codex-repair/<attempt-id>/`. The helper enforces this location rule for its session/snapshot/log writes, including symlink destinations. Session JSON is version 1 and retains identity, start SHA, remotes, problems, validation, publication, and thread outcomes. Writes use atomic replacement and a sibling `.lock` directory. Token-bearing session files have owner-only permissions.

### Stacks

Use the existing coordination workflow to register verified published membership, acquire/claim ownership, and capture inherited boundaries **before any changes**. Pass an ownership file to preflight and initialization:

```json
{
  "owner": "repair-attempt-owner",
  "token": "held-repair-token",
  "snapshotPath": "/absolute/outside-source/stack-snapshot.json"
}
```

```sh
node "<helper>" preflight --pr <url> --stack-file <ownership-file> --json
node "<helper>" session init --file <session> --pr <url> --stack-file <ownership-file>
```

The existing task snapshot needs a `layers` array in bottom-to-top registry order. Each layer has `pr` (exact URL), `headRepository` (`host/owner/repo`), `branch`, `headSha` (full pre-change commit SHA), `baseBranch`, and, for every child, `inheritedBoundary` (verified old inherited parent SHA). Keep other snapshot fields required by `manage-stacked-prs`. Initialization checks membership, held ownership, local ancestry, and authenticated remote identities/heads/bases. It cannot decide whether an inherited boundary reflects the intended layer contract; the stack workflow must establish that fact.

## Record each problem and validation

```sh
node "<helper>" session record --file <session> --input <record-json>
node "<helper>" session verify --file <session>
```

Each input contains exactly one of `problem`, `validation`, or `stackPublication`. A changing problem has exactly one commit. Record it immediately after committing, before starting another repair. Duplicate reports share one problem and commit; independent problems cannot share commits or thread IDs. The agent decides root-cause identity, correctness, and validation sufficiency.

```json
{
  "problem": {
    "id": "review-null-input",
    "kind": "review",
    "commit": "<full-commit-sha>",
    "evidence": "The failing case and the corrected behavior.",
    "validation": [
      {"command": "<focused test command>", "revision": "<same-commit-sha>", "result": "passed"}
    ],
    "threads": [
      {"id": "PRRT_example", "disposition": "fixed", "evidence": "The commit corrects this finding."}
    ]
  }
}
```

`kind` is `merge`, `review`, or `ci`. Merge and CI problems require a commit; use an empty `threads` array. A review problem without changes omits `commit` and uses `incorrect` or `blocked` thread dispositions. Every problem/thread requires concrete evidence. `fixed` requires a commit. Only an `incorrect` thread may include `replyBodyFile`; the finish command also confirms its finding was authored by the bot. For threads with both bot and `@me` comments, supply `findingCommentId` to identify the exact bot finding. `status` includes comment IDs for this purpose. A selected human comment cannot receive an optional reply. Prepare any optional explanation in English. An `@me` finding cannot receive this optional reply. Explicitly requested comments outside this exception remain a separately scoped workflow; these commands do not publish them.

Apply the skill's **Repair scope** rules before recording repairs. Report CI failures left unfixed because they are unrelated to the PR or their relationship is unclear in the current chat with supporting evidence; do not create a `ci` problem record for them, because that record requires a repair commit. Record out-of-scope review findings as `blocked`, not `incorrect`, and leave their threads unresolved. Record any required validation failure as `failed`. Failed or skipped results do not block publication or handling fixed and incorrect threads; retain the ownership, revision and remote-publication checks.

After all repairs, record each required final validation at the final local head:

```json
{
  "validation": {
    "command": "<required validation command>",
    "revision": "<final-head-sha>",
    "result": "passed"
  }
}
```

Results can be `passed`, `failed`, or `skipped`; publication/thread writes require final records at the current head, but do not require passing results. Rerunning the same command replaces its final result and retains prior attempts in `validationHistory`. Adding a problem or recording stack publication clears older final validation. Verification checks commit existence/ancestry, first-parent repair inventory, duplicate commits/threads, and validation revisions. It does not execute recorded test commands or certify their coverage. Session identity and operation outcomes are helper-owned; do not edit them to bypass a blocker.

### Record final stack publication

`publish` refuses stacks. Complete `manage-stacked-prs` with the session's existing owner/token and original inherited boundaries. Then record:

```json
{
  "stackPublication": {
    "complete": true,
    "targetBoundary": "<final-target-inherited-parent-sha>",
    "repairCommits": [
      {"problemId": "review-null-input", "commit": "<final-replayed-repair-sha>"}
    ],
    "layers": [
      {"pr": "<exact-url>", "headRepository": "host/owner/repo", "branch": "<branch>", "headSha": "<verified-final-sha>", "baseBranch": "<base>"}
    ],
    "validation": [
      {"command": "<required check>", "revision": "<changed-layer-final-sha>", "result": "passed"}
    ]
  }
}
```

Include every layer in original order and validation results for every changed tip, including failures and skipped checks. Use a repair mapping for each repair if the target was replayed; retain original problem commit SHAs. The helper checks target commit counts against original boundaries and mapped repair ancestry; the stack workflow must compare old/new ranges and reconcile conflict changes to prove that intended work survived. Record final target validation **after** this result. Thread finishing independently rereads remote heads/base chains, checks parent ancestry, and verifies the original stack token. It never acquires/releases a token or performs restacking.

## Collect CI logs

```sh
node "<helper>" ci-logs --session <session> --output-dir <outside-source-directory>
```

Collect failed/cancelled Actions run/job logs only after verifying repository, current remote head SHA, and attempt. Repeated references to the same run/job/attempt share a log file. External checks return `external`; stale or inaccessible logs return `unavailable` with evidence. A complete check inventory can still contain unavailable logs; that state does not mean CI passed. Read failures and a head change during collection make the inventory incomplete. Investigate accessible external logs through `gh` separately when necessary.

`status` preserves its existing JSON fields and adds `checks.complete` and `checks.exitCode`. Valid check JSON with failure exit 1 or pending exit 8 is retained. API/authentication failures, unexpected exits, and malformed JSON are reported as incomplete rather than healthy.

## Publish and finish threads

```sh
node "<helper>" publish --session <session>
node "<helper>" finish-threads --session <session>
```

For ordinary PRs, publication requires clean Git state, unchanged identity/remotes, recorded commits, and final validation records at the current head. Failed and skipped checks remain recorded and do not prevent publication. It performs one explicit normal target-branch push, disables automatic tag/submodule publication, and checks the actual destination and final GitHub head. No changes means `noop`, without an empty commit or push. Completed publication is reused only if the current local/remote heads still match. Thread finishing can verify a no-op directly when no push is necessary.

Finishing validates all selected thread IDs against the current PR and eligible finding author before any write. Newly outdated findings require reassessment. Already resolved threads are reconciled without another mutation. Only `fixed`/`incorrect` are handled; `blocked` remains unresolved. An optional bot reply is recorded before the request; failure does not skip the required resolution attempt. Reply and resolution outcomes are independent. A partial failure is reported per thread, and other prepared threads are still handled.

### Interrupted or uncertain operations

Each push/reply/resolution records `attempting` before external mutation. Reexecution rereads actual GitHub state. A published target SHA or resolved thread confirms completion; an uncertain reply is confirmed only by a new authenticated-user comment matching the recorded body and absent from the pre-request comment IDs. The helper never blindly retries an unconfirmed request. Missing remote evidence remains a blocker, with thread outcomes preserved even if resolution succeeded.

A session lock has no timeout or automatic stealing. After interruption, positively establish that the prior process stopped, inspect its operation record and local/remote effects, then remove only the abandoned sibling session lock. Stack/catalog recovery follows the separate coordination reference. Do not clear operation records to make a retry succeed. A known failed attempt needs explicit effect reconciliation before a separate replacement attempt; retain the original session as evidence. Do not release a stack token while effects remain uncertain. Known thread-write failures are reported according to the existing stack workflow.
