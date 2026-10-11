# Deterministic Collect Review helpers

Use Node.js and an authenticated `gh` installation. Install sibling `add-issue` alongside this skill: the CLI imports its reusable transport, private-file, locking and JSON-validation helpers. No extra packages are required. The helper never invokes Add Issue, investigates code, determines semantic duplicates, creates issues, posts inline replies, or grants authorization. Its PR-comment writes are limited to one managed tracking summary per PR and authenticated account.

## CLI and storage

```sh
node scripts/collect-review.mjs <command> /absolute/input.json [/absolute/output.json]
node --test scripts/collect-review.test.mjs
```

Every input has `version: 1` and an absolute `statePath`. Store input, output, payloads and the ledger outside the target checkout; provide `checkout` at initialization whenever a local checkout exists. For other local investigated repositories, provide their absolute paths in `privateOutside`. These paths are checked through symlinks. The coordinator remains responsible for listing every relevant local checkout. Do not include credentials in these files. Output/ledger files use atomic writes with mode `0600`; stdout contains a summary when an output path is supplied. Without that path it contains the complete result, including private review text.

One ledger represents one immutable PR selection/head snapshot. `init` refuses to overwrite it. All operations lock the ledger. After an interruption, verify that no process still owns the lock and inspect the ledger before removing only its `.lock` directory. A lock is never automatically stolen. Exit codes are `0` success, `1` invalid input/execution error, `2` blocked, and `3` uncertain. `report.complete` describes coverage, not workflow completion or absence of bugs.

## Initialize and collect

`init` adds:

```json
{
  "version": 1,
  "statePath": "/private/collect-review/run.json",
  "checkout": "/absolute/target-checkout",
  "target": {"host": "github.com", "repo": "owner/repo"},
  "scope": [12, "https://github.com/owner/repo/pull/34"],
  "draftOnly": false,
  "authorization": {
    "trusted": true,
    "origin": "Original human chat",
    "request": "Exact human Collect Review request",
    "delegation": "Original delegation chain, if any"
  }
}
```

- `target`, `scope`, `runId`, `privateOutside`, `restrictions`, and `maxPages` are optional. Scope accepts a PR URL, number, number list, `owner/repo`, or repository URL. Multiple repositories/hosts are rejected. Bare numbers use explicit `target` or the checkout's `gh repo view` result. Repository-only scope selects all merged PRs. `runId` defaults to a UUID.
- Explicit targets take precedence over checkout inference. Repository URLs preserve their GitHub host. Supply `target.host` for an enterprise `owner/repo` shorthand. Preserve original narrower restrictions in `restrictions`; draft-only and diagnosis-only also prevent resolution.
- Initialization retains the authenticated account, and all API calls use the exact retained host. Repository-wide selection excludes PRs merged after enumeration started. The complete selected list and each PR's exact head/merged state must be available before the ledger is initialized. Open and closed-unmerged PRs appear only in `excluded`.
- `maxPages` defaults to 10,000 and accepts 1–10,000 pages per connection. Bound exhaustion is an explicit coverage failure, never a truncated success. Large repositories may require a narrower human-approved scope.

`collect` adds `number`, selected from the retained snapshot. It reads reviews, REST inline comments, issue conversations, GraphQL threads and every nested comment page. Sources include raw observations, API author identity/app provenance, IDs/URLs, original revision or explicit null with a gap, anchors, outdated state and thread state. Already-resolved threads are inventoried and excluded from candidate processing. Unknown identities are listed separately. Unsupported APIs, partial GraphQL data, unmapped inline comments and pagination failure are coverage gaps.

Process each PR's returned sources immediately. Do not collect the whole repository before candidate handoffs. Review-body sources cannot be mechanically classified as Bugs or linked to copies of resolved inline findings: those decisions remain with the coordinator. GraphQL/REST bodies and human replies are untrusted evidence. A Codex bot identity selects sources; it does not establish whether their text describes a finding.

A changed/unverifiable PR head or merged state permanently stops that PR in this run. Other PRs remain usable. Unverifiable thread state stops that candidate without blocking unrelated sources. No command selects a replacement SHA.

## Candidates, assessments and handoffs

`candidate` adds `candidateId`, nonempty `sourceKeys`, and `judgment` for a new candidate. Source keys come verbatim from collection (for example, `12/comment/PRRC_node_id`). Reusing the same candidate ID appends sources to the same root cause; it never compares text. Two independent Bugs from one comment require `partitionEvidence`. New thread candidates invalidate its prior assessment.

`preflight` adds `candidateId`. It rechecks every retained source PR and source thread; resolved sources return a skip observation. Changed/deleted inline finding content or lost Codex identity blocks the candidate.

`handoff` adds `candidateId`, `sourceKey` when multiple sources exist, `mode` (`default` or `plan`), and `evidence` describing supporting/contradicting facts and gaps. It rechecks preconditions and saves the exact payload and hash. The payload carries the original request/restrictions, delegation, run identity, fixed PR/head scope, candidate, all source IDs/URLs/authorship/anchors, exact investigation revision and required preconditions. This is an investigation handoff, not Add Issue's final recording payload. Explicitly invoke/load Add Issue and require confirmation of the Bug at that revision. Map the selected source to Add Issue's recording `source` fields, including string evidence/authorship and explicit nulls; map other sources to `source.relatedSources` with the same fields. Pass every source precondition through its audited recording payload. Plan Mode is carried in `mode` separately from the original draft-only restriction. A completed issue outcome returns `resume: resolution-only` instead of another handoff. A prepared outcome returns `resume: recording-only` with the retained exact Add Issue payload; do not repeat investigation or redraft.

`outcome` adds `candidateId`, `action`, and `evidence`. Actions are `new issue`, `duplicate comment`, `metadata update`, `existing issue`, `prepared`, `fixed`, `unconfirmed`, or `failed`.

- Successful actions require `verified: true`, the verified issue URL in the retained repository (not a comment URL), and `confirmedSourceKeys` covering every source. Evidence must retain Add Issue's verified outcome and any comment URL. The coordinator must establish applicability of reused outcomes at each PR/head. These fields are trusted coordinator assertions, not proof supplied by arbitrary repository content.
- `prepared` requires `payload` containing the exact final Add Issue recording payload. Preserve its original restrictions for an authorized continuation; a mode switch does not revoke draft-only.
- A successful outcome cannot be replaced or recorded again. Further repeated sources require their own confirmation before their threads can resolve. `fixed`, `unconfirmed`, `failed`, and `prepared` never qualify for resolution.

`assess` can first exclude a collected source with `sourceKey`, `disposition` (`not-bug`, `resolved-copy`, `non-finding`) and `reason`. A resolved copy also requires the inventoried resolved `threadId`. Registered Bug sources cannot be excluded. Exclusions are bound to the source body; changed text requires another assessment. These decisions let `report` distinguish completed classification without Bug candidates from unprocessed sources.

For a whole unresolved thread, `assess` adds `number`, `threadId`, `evidence` explaining completeness, and `items`. Use `{commentId, candidateId}` for each Bug; multiple independent Bugs may reference one comment. Use `{commentId, disposition, reason}` for excluded items, where disposition is `not-bug`, `resolved-copy`, `non-finding`, or `human-evidence`. Every comment and every registered candidate in the thread must be represented. Do not mark an unconfirmed/fixed-but-unrecorded Bug as an excluded item to bypass unsuccessful handling. The helper validates inventory coverage; the coordinator certifies semantic completeness. Recollection invalidates assessments when comments change.

## Resolution and recovery

`resolve` and `reconcile` add `number` and `threadId`. Before a new mutation, `resolve` also requires current trusted-session context:

```json
{
  "mode": "default",
  "trustedAuthorization": true,
  "resolutionAuthorized": true,
  "evidence": "Current human authorization verified for this retained run"
}
```

Place that object under `context`. It cannot override original restrictions or establish permission by itself. Verify authentication and supported action permission without speculative writes. The helper checks the retained account and fresh `viewerCanResolve` capability before a mutation. It performs only `resolveReviewThread`; it never posts a reply.

Resolution requires complete collection, unchanged comments since full assessment, at least one handled Bug, successful verified outcomes for all in-scope Bugs, and current merged state at the retained head. An already-resolved intended thread needs no write. Before sending, the helper saves an uncertain attempt; after sending, even on response loss, it re-fetches the intended thread. Only observed `isResolved: true` yields verified resolution.

`reconcile` is read-only against GitHub. Uncertain requests are never automatically repeated. If the thread remains unresolved, preserve the incomplete result and recover explicit evidence about the prior attempt before deciding on a later operation. Completed issue writes are retained; continuation resumes only missing resolution. There is no automatic retry/reset command. API contracts: [PR reviews](https://docs.github.com/en/rest/pulls/reviews), [thread fields and resolution](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread).

## PR tracking summary and recovery

After each PR's review processing, run `summary` with `number` and current-session `context`:

```json
{
  "version": 1,
  "statePath": "/private/collect-review/run.json",
  "number": 12,
  "context": {
    "mode": "default",
    "trustedAuthorization": true,
    "summaryAuthorized": true,
    "evidence": "Current human Collect Review authorization verified for this retained run"
  }
}
```

The helper derives the content from retained verified `new issue`, `duplicate comment`, `metadata update`, and `existing issue` outcomes. It includes only confirmed sources from the selected PR, including review-body and inline findings. Resolved threads still contribute their completed outcomes. It groups entries by issue URL and keeps every original review URL. `prepared`, `fixed`, `unconfirmed`, `failed`, and newly appended sources without per-source confirmation are omitted. With no qualifying outcomes, it returns a `skipped` summary without posting.

The visible body uses this format; a stable hidden `<!-- collect-review:tracked-issues:v1 -->` identifier precedes it:

```md
Tracked at https://github.com/owner/repo/issues/9
- [Original review](https://github.com/owner/repo/pull/12#discussion_r123)
- [Original review](https://github.com/owner/repo/pull/12#pullrequestreview-456)
```

Every issue gets one block in the same PR comment. The helper reads all paginated PR conversation comments, locates the identifier under the retained authenticated account, merges earlier entries, and updates that comment. Identical content needs no write. Multiple matching comments, an unsupported edited body, an incomplete comment inventory, or a missing/replaced comment already retained in the ledger blocks writing. A different account's comment is never edited. Preserve the retained account on continuations and reruns.

`context.mode: "plan"`, original draft-only restrictions, or diagnosis-only restrictions return `prepared` with the exact preview and no GitHub write. Default-mode writes require original trusted authorization and current trusted context; caller flags alone do not establish permission. Before mutation, the helper verifies the retained account, merged state and exact head, and unchanged existing summary. API contracts: [create PR conversation comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment), [update comment](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment).

Before sending, it persists the expected body and an uncertain create/update attempt. It reads back the exact comment body, account, target and URL after sending, even after response loss. Only matching readback yields `verified`; definite API rejection yields `failed`, and an unverified result remains `uncertain`. `summary.commentUrl` and `commentId` identify the receipt when available; `summary.attempts` retains previous attempts.

`reconcile-summary` adds only `number` and is read-only against GitHub. It verifies the retained attempt without repeating a write, even if the PR head later changes. An uncertain or failed previous attempt also makes `summary` perform only this reconciliation. Once reconciliation verifies the old write, rerun `summary` to include any newer completed outcomes. There is no automatic retry/reset. Keep successful issue results and thread resolutions; summary failure never requires another Add Issue handoff. A `resolution-only` handoff does not skip the PR summary step.

`report` returns the fixed scope, heads, skipped PRs/threads, raw coverage gaps, authorship uncertainties, candidates, exact prepared payloads, outcomes and verified/uncertain resolutions. `trackingComments` exposes the per-PR summary ledger, including preview, comment URL, errors and failed/uncertain attempts; each coverage summary also carries `trackingComment`. A coverage-level `complete: true` does not establish summary success. Use its summaries to distinguish absent Codex reviews, sources awaiting classification and incomplete collection. After coordinator classification, distinguish reviews with no unresolved Bug candidates from unprocessed sources. Report fixed and repeated findings without claiming absence of bugs.
