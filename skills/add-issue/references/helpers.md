# Deterministic helpers

Read this reference when collecting a workspace baseline, auditing a final payload, or recording it. Run the bundled CLI with Node.js. It uses only Node built-ins and installed `git` and `gh`; it does not install or upgrade tools. Paths below are relative to this skill folder.

## Responsibilities and invocation

The coordinator decides cause, classification, readiness, semantic duplicates, metadata, image approval, repair scope, and authorization from trusted session context. Helpers collect observations and enforce mechanical invariants; a `confirmed` flag or successful schema check does not establish those judgments. The recording subagent runs `record` after the coordinator audits the exact payload. Existing delegation, model, scope, mode, and recording-only restrictions still apply.

```sh
node scripts/add-issue.mjs --help
node scripts/add-issue.mjs snapshot /absolute/snapshot-input.json /absolute/private/baseline-result.json
node scripts/add-issue.mjs compare /absolute/compare-input.json /absolute/private/compare-result.json
node scripts/add-issue.mjs collect /absolute/collect-input.json /absolute/private/observations.json
node scripts/add-issue.mjs validate /absolute/validate-input.json /absolute/private/audit-result.json
node scripts/add-issue.mjs preflight /absolute/preflight-input.json /absolute/private/preflight-result.json
node scripts/add-issue.mjs refresh /absolute/refresh-input.json /absolute/private/refresh-result.json
node scripts/add-issue.mjs record /absolute/record-input.json /absolute/private/outcome.json
node scripts/add-issue.mjs verify /absolute/verify-input.json /absolute/private/verification.json
node scripts/add-issue.mjs images /absolute/images-input.json
```

All inputs are JSON with `version: 1`. Every result includes `version`, `status`, `complete`, and `errors`. Exit codes: `0` verified, `1` malformed input or execution exception, `2` blocked/failed/needs-review, `3` uncertain. Per-candidate outcomes retain surviving URLs, operations, omissions, and verified attachments. An existing issue outcome performs no write.

Store input, output, baselines, payloads, and the recording ledger in a private directory outside the investigated repository. Output files are written atomically with mode `0600`. With an output argument, stdout shows only a summary and file path. Without it, stdout contains the full result: use an output argument for diffs, private evidence, or issue text. Raw baselines contain diffs and must remain private; sanitize excerpts before exposing them or drafting published text. Never place secrets in payloads or permission evidence. Helpers do not certify redaction.

## Workspace inputs

`snapshot`: `{version, repo, inventory?, originalRef?, repairLedger?}`. `repo` is absolute. The result's `baseline` contains repository root, exact HEAD, branch (null for detached HEAD), NUL-delimited status, binary staged/unstaged diffs, and sorted file entries with content hashes and modes. It inventories all tracked and nonignored untracked paths. Use `inventory` for relevant ignored files or regenerable state; paths must be repository-relative files, not directories. Symlink targets are hashed without following them. Initialized submodule repositories retain nested snapshots; changed nested contents change the baseline even when their outer dirty flag remains the same. Artifact-path checks follow existing symlinks so an outside alias cannot redirect a ledger into the investigated repo. Baselines do not enumerate ignored databases or volumes automatically. Choose any additional data-preservation evidence required by the investigation.

`compare`: `{version, baseline}`. It captures the same inventory again and reports every changed category. It does not restore, delete, reset, repair, or silently accept concurrent changes. Resolve differences using the skill's ownership and preservation rules; an unexplained difference blocks recording.

After an independently verified authorized repair, collect another snapshot with `originalRef` set to the original baseline's `ref` and a nonempty `repairLedger` describing targets, rationale, actions, recovery paths, verification, and results. Retain both baselines. A linked snapshot is not proof that the repair was authorized or verified; the coordinator audits it before payload finalization.

## Collection inputs

`collect`: `{version, target: {host, repo}, discover?, projects?, duplicate?, issueUrl?, includeComments?, metadata?}`.

- Resolve a unique canonical host and `owner/repo` first. Reads use that explicit host through `gh`; ambient repository defaults are not used.
- `discover: true` reads labels, enabled repository issue types, organization issue fields, and only the supplied project IDs. Account/repository/capability observations are always collected. Project IDs are GitHub node IDs.
- `duplicate: {query, limit}` searches open issues in that repository, with `limit` from 1 to 100. Incomplete or overflowing searches are unavailable, not empty. Choose a narrower recorded query when necessary.
- For a selected existing issue, set `issueUrl` and `includeComments: true`. Retain the issue and complete bounded comment observations. Use `metadata` entries for precise definition/current-value observations.
- Each observation records `available` plus `value` or a reason. Repository roles and project `viewerCanUpdate` are evidence, not proof of every credential scope or operation permission. The agent must establish credential requirements with current read-only evidence and official documentation. Do not refresh credentials or probe permissions by writing.

REST/project/comment pagination stops at a finite bound (10 pages by default); bound exhaustion blocks the relevant read. Authentication tokens and raw CLI stderr are never returned. GraphQL requests use POST for read queries, which are not mutations.

## Final payload contract

`validate` input: `{version, payload}`. The helper validates structure and saved image files and returns a deterministic `payloadHash`. Return the complete payload in the coordinating chat as required by the skill, not only its hash or local filename. Preserve that exact payload across Plan Mode continuation.

Payload top level:

| Field | Required value |
| --- | --- |
| `version`, `runId` | `1`, stable run identity |
| `target` | Canonical `{host, repo}` |
| `account` | Verified authenticated login |
| `candidates` | Nonempty array of independent ready candidates |

Each candidate contains:

| Field | Contract |
| --- | --- |
| `id`, `classification`, `readiness` | Unique identity, `Bug`/`Feature`/`Task`, `ready` |
| `environment`, `revision`, `evidence` | Environment, exact SHA, sanitized self-contained evidence |
| `authorization` | `{kind, origin, request, context}`; kind is `human`, `main-qa`, `static-analysis`, or `collect-review`. Handoffs also include `runId`, `delegation`, and `scope`; retain all applicable original restrictions and MainQA allocation/model instructions in `context`. |
| `restrictions` | Boolean `draftOnly`, `diagnosisOnly`, `noRepair`, `noImplementation: true`; local investigations also require `noCodeChanges: true` |
| `workspace` | `{original, baseline, cleanupVerified: true}` with full verified snapshots; a different baseline must link to the original and retain its repair ledger |
| `logs`, `runtime` | For local investigations, sanitized evidence, exact availability gaps, or justified applicability statements |
| `action`, `issueUrl` | `new issue` with null URL; otherwise `duplicate comment`, `metadata update`, or `existing issue` with an exact issue URL in the target repo |
| `title`, `body`, `comment` | Exact text. Creation requires nonempty body and empty comment; duplicate comment requires nonempty comment and empty body; metadata-only/existing outcomes require both empty. Title is always retained. |
| `duplicate` | `{query, limit, complete: true, issues, evidence}`; `issues` is the collector's exact sorted search result. Existing actions also include the retained `issue` observation and `comments` array. |
| `metadata`, `omissions` | Audited operation entries and known omissions with reasons; arrays may be empty |
| `recordPermission` | `{confirmed: true, evidence, credentialEvidence}` for the selected action |
| `allowedActions` | Selected action, `metadata:ID` for every audited metadata entry, `image:ID` for every image, and `image-comment` only when that exact fallback comment is audited |
| `images`, `noApprovedImages` | Explicit image array and boolean that is true only for an empty array |
| `imageComment` | Exact self-contained image-handoff text when that destination or a body-upload fallback is audited |
| `source` | Required for Collect Review: `{number, url, head, merged: true, resolved: false, threadId, threadUrl, reviewRevision, reviewEvidence, authorship}`. `head` equals investigation revision. Use explicit `null` for an unavailable `reviewRevision`. For a review-body finding without a thread, use `threadId: null`, `threadUrl: null`, and `resolved: null`; recording checks only the source PR. Thread-backed findings still require all thread fields and unresolved state. Use optional `relatedSources` inside `source` for additional reported PR/thread preconditions; each entry has the same source fields, its own retained head and evidence of outcome applicability, with no nested `relatedSources`. Preflight checks every entry and skips recording if any source thread is resolved. Include review/comment IDs and URLs, authorization provenance and gaps in `reviewEvidence`/`context`. |

Structural validation does not prove causal evidence, complete implementation decisions, approval provenance, or semantic duplication. `unconfirmed`, `failed`, and `repair pending` candidates stay outside this ready recording payload and are reported separately.

### Metadata entries

Every entry has `id`, `kind`, `name`, `destination`, `value`, `observed`, `definition`, `required`, `overwrite`, `rationale`, and `permission: {confirmed, evidence, credentialEvidence}`. `definition` is the helper's normalized definition observation. `destination` is the selected issue URL, the repository URL for a new issue, or the exact project node ID for project operations. IDs must be unique. Optional entries require `omissionPolicy: "skip-on-loss-or-conflict"`. Overwrites require `overwriteAuthority` identifying explicit user instructions or an authoritative rule.

| Kind | Value and extra fields |
| --- | --- |
| `label`, `assignee` | Exact supported name/login; `observed` is presence boolean. Addition only. |
| `type` | Exact supported type name; `observed` is current name or null. |
| `milestone` | Positive milestone number; `observed` is current number or null. Set only with authorized assignment. |
| `issue-field` | Positive `fieldId`, supported `dataType` (`text`, `number`, `date`, `single_select`), typed `value`; single select uses an existing option name. `observed` is current value or null. |
| `project-membership` | `projectId`, `value: true`, `observed` presence boolean. Addition only and explicitly authorized. |
| `project-field` | `projectId`, `fieldId`, `valueType` (`text`, `number`, `date`, `singleSelectOptionId`, `iterationId`) and typed value; selections use discovered IDs. `observed` is current value or null. Existing item or audited membership addition is required. |

Preserve private field visibility in published prose. Helpers write native fields only with nonempty additive POST payloads; labels/assignees use additions, project fields use individual writes. Membership runs before project fields. The collector never invents labels, options, rubrics, projects, ownership, or dates. Required missing support/conflicts block; optional entries may only be omitted under the audited policy. Existing issue outcomes must have no metadata operations; metadata-only outcomes require at least one.

### Images

Each image has `id`, `path`, `sha256`, `approval`, `surface`, `viewport`, `state`, `caption`, `provenance`, `generated`, and `destination` (`body`, `comment`, `image-comment`, `existing`). Generated images also require the final `prompt` in published text. For body images it must be in the exact creation body; for an existing image it may be in the retained issue body or comments. Preflight and final verification check the live published prompt too. `approval` must identify trusted human approval of the image and associated text specification. Captions are unique plain Markdown alt text without brackets, backslashes, or newlines. Paths are absolute regular files and must not contain `#`; no local saved path may appear in published text.

Choose `body` for new issues when CLI creation supports all required metadata and attachments. Also audit `imageComment` and `image-comment` permission when an attachment fallback may be needed (including unsupported CLI types or label names that require CSV quoting); this is the exact alternate surface, not a new drafting step. The ledger retains a routing override when the approved fallback is used, without modifying the payload. Missing duplicate images belong in the single audited implementation-handoff comment. For an approved image already present on the selected issue, use `destination: "existing"`, its exact `surfaceUrl` (issue body or issue-comment URL), and retained native `attachmentUrl`. Existing images are verified before any write and counted without another upload/comment; this permits image-complete `existing issue` and `metadata update` outcomes. A missing approved file or unknown path stops that candidate before writing. Immediately before CLI upload, the helper verifies and copies the approved bytes to a private temporary directory so later edits to the original file cannot change the uploaded content. It removes only these copies after the command and preserves the approved originals. Browser recorders must also verify the original file and hash before upload.

Verification accepts only native GitHub asset URLs read back from the exact issue/comment surface, with a unique matching caption, authoritative text, provenance and generated prompt retained in the manifest. It does not claim that a successful CLI exit proves attachment completion. Legacy GitHub user-images URLs and the target host's `/user-attachments/assets/` URLs are recognized; unknown hosting formats require supported native evidence rather than an external upload or a text-only downgrade.

## Preflight, recording and recovery

`preflight`: `{version, payload, candidateId, context, state?}`. `verify`: the same shape plus `omissions?`; verification requires a state with `issueUrl` and retained operation receipts. These commands are read-only.

`record`: `{version, payload, statePath, context}`. `statePath` is an absolute private ledger path outside the investigated repo. `context` is supplied by the recording agent from the current trusted session:

```json
{
  "mode": "default",
  "trustedAuthorization": true,
  "recordingAuthorized": true,
  "evidence": "Origin and current recording authorization verified in trusted session",
  "recordPermission": {
    "confirmed": true,
    "evidence": "Current action capability verified for the authenticated login",
    "credentialEvidence": "Current credential requirements verified without exposing secrets"
  },
  "permissions": {},
  "candidates": {}
}
```

Fill `permissions` by metadata entry ID with fresh action-specific permission evidence of the same shape. For multiple candidates, place their `recordPermission`, `permissions`, and `receipts` in `context.candidates[CANDIDATE_ID]`. Context does not override original draft-only/diagnosis-only restrictions. All helper commands may be used for preparation in Plan Mode except `record`; repair execution is never part of a helper.

Recording serializes candidates and performs bounded preflight. It re-fetches identity, repository, retained duplicate query/target/thread, audited definitions/current values, workspace inventory, saved images, and source PR/thread when applicable. A newly resolved source thread yields a skip with no write; unverifiable state or changed required conditions blocks. Changed duplicate search/target/thread observations return `needs-review` with `duplicateReview: {changes, issues, issue}`. Each change contains `surface`, `before`, and `after`; verified operation receipts are excluded from the comparison. Other precondition failures still return `blocked`, with any duplicate changes retained for later review. The coordinator performs bounded semantic review and automatically resumes through `refresh`; no repeated human approval is needed. Helpers never choose semantic duplicates or draft text. Verified writes by this payload are removed from duplicate comparisons, rather than treated as new duplicates.


### Duplicate-review refresh

`refresh`: `{version, previousPayload, payload, statePath, review: {candidateId, reason, observations}, context}`. `observations` is the exact `duplicateReview` from the latest preflight. Add `context.duplicateReview: {confirmed: true, evidence}` from trusted coordinator review; existing current authorization and permission fields still apply. The reason must explain whether the change is unrelated, introduces a matching duplicate, completes missing content, or invalidates the old target. This command makes only bounded GitHub reads and updates the private ledger; it never writes GitHub.

Review the changed search results and relevant selected/new-target thread against the retained handoff. Preserve all investigation fields and other candidates. Retain the query and limit. Refresh duplicate observations and their semantic evidence; adjust action, target, exact text, metadata destination/current value/permission, omissions, and image destinations only as needed to record the same work. Metadata cannot add unaudited entries or change audited definitions/values; dropped required entries must already be satisfied on the selected target. Approved images retain identities, files, hashes, approvals, and specifications. Run payload validation before refreshing.

`refresh` locks the same ledger, verifies its previous hash, checks fresh old observations against the review, and preflights the revised payload before saving. New observation drift is returned for another coordinator review; do not ask for human approval for drift alone. Unavailable reads and other required precondition failures retain their specific blockers. Successful refresh stores both hashes, the complete previous payload, semantic review, and trusted provenance in `history`. It preserves all operation receipts, attachments, and other candidates. An identical refresh request is recoverable after a lost response.

Uncertain or failed operations must be reconciled with the previous payload first. After any verified or omitted operation, only duplicate observations can change for that candidate; its target, text, action, metadata, and images remain fixed. A verified creation is never replaced by a newly found duplicate. External title/body changes on an existing issue may refresh its preservation baseline after review. Continue recording with the returned hash and the same ledger. Never silently replace the ledger or use a new one to bypass a prior write.

The ledger is bound to the canonical payload hash. It locks recording, records each operation as uncertain before invoking `gh`, preserves returned receipts before verification, and never repeats a verified or uncertain write. Interrupted locks are not automatically stolen. After verifying that no recorder is active and checking its ledger, the coordinator may remove only that known helper-created lock directory; never clear a running or ambiguous lock.

If a response is lost, reads may reconcile metadata already applied. Creation/comment receipts recovered from trusted evidence can be supplied as hints:

```json
{
  "create": {
    "operationId": "candidate/create",
    "payloadHash": "the retained payload hash",
    "url": "https://github.com/owner/repo/issues/123",
    "evidence": "Trusted recovery provenance for this operation"
  }
}
```

Put this map in `context.receipts` (or the candidate context). The helper re-fetches the exact record and verifies target, author and content; a receipt alone is not completion. Use `comment` or `image-comment` for their operation IDs. An existing retained receipt cannot be replaced. An unreconciled operation blocks further writes for that candidate while independent candidates continue. A rejected required write returns failed with its surviving record; optional explicit HTTP rejection is reported as an omission. Uncertain transport/5xx outcomes remain uncertain and are never treated as safe omissions.

If `--attach` is unavailable, the ledger reserves the one audited browser operation and returns its target, exact text and image list. The recording agent performs that operation using the authenticated native GitHub flow, then supplies its receipt with provenance. Do not use unofficial upload endpoints, external hosting, regenerated images, or another issue/comment. CLI partial uploads retain successful records and attachments but yield an incomplete image handoff. On continuation, the helper reserves `attachments:body`, `attachments:comment`, or `attachments:image-comment` with `appendImagesOnly: true`, the retained surface URL, and only missing images. The recorder appends those images through the native browser flow without rewriting text or creating another comment. The helper re-fetches that same surface and verifies every reserved image before releasing the operation. Supply recovered receipts with the same operation identity when needed; a changed surface URL is rejected. Successful attachments and completed writes remain intact. A missing image is never an optional metadata omission.

## Validation

```sh
node --test scripts/add-issue.test.mjs
```

Tests use temporary Git repositories and mocked `gh`; they do not authenticate, repair local processes, or create real GitHub records. Run the skill-creator validator after editing the skill. It checks the skill structure, not behavioral correctness.

Official API contracts: [native field definitions](https://docs.github.com/en/rest/orgs/issue-fields), [additive field values and permissions](https://docs.github.com/en/rest/issues/issue-field-values), [issue creation and updates](https://docs.github.com/en/rest/issues/issues), [repository issue types](https://docs.github.com/en/rest/repos/issue-types), and [GraphQL reference](https://docs.github.com/en/graphql/reference). Verify current CLI help and target-host support during collection; unsupported optional metadata remains an audited omission.
