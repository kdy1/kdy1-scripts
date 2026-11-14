# Linear helpers

Read this reference when the selected tracker is Linear. The Linear CLI keeps the workspace, payload, ledger, and authorization rules of [the GitHub helpers](helpers.md). Only the tracker target, duplicate query, metadata kinds, image upload, and authentication differ. It uses only Node built-ins, `git`, and the macOS `security` tool.

```sh
node scripts/linear-issue.mjs auth-status [WORKSPACE]
node scripts/linear-issue.mjs auth-store /absolute/key-file [--default]
node scripts/linear-issue.mjs auth-delete WORKSPACE
node scripts/linear-issue.mjs collect /absolute/collect-input.json /absolute/private/observations.json
node scripts/linear-issue.mjs validate /absolute/validate-input.json /absolute/private/audit-result.json
node scripts/linear-issue.mjs preflight /absolute/preflight-input.json /absolute/private/preflight-result.json
node scripts/linear-issue.mjs refresh /absolute/refresh-input.json /absolute/private/refresh-result.json
node scripts/linear-issue.mjs record /absolute/record-input.json /absolute/private/outcome.json
node scripts/linear-issue.mjs verify /absolute/verify-input.json /absolute/private/verification.json
```

Use `snapshot` and `compare` from `scripts/add-issue.mjs` for workspace baselines. Results, exit codes, and private-output rules match the GitHub CLI.

## Authentication

The helper reads the Linear personal API key in this order:

1. The `LINEAR_API_KEY` environment variable, when it is set.
2. The login Keychain item with service `kdy1-scripts.add-issue.linear` and account set to the workspace URL key. When no workspace is named, the helper uses the default workspace from `~/.config/kdy1-scripts/add-issue/linear.json`. That file holds only non-secret workspace names and user IDs.

Run `auth-status` first. A `verified` result reports the key source, workspace, authenticated user, and teams. It never prints the key. Ask the human for a key only when a result has `authRequired: true`. This happens when no key is stored, or when Linear rejects the stored key because it expired or was revoked. Do not ask for a key at any other time.

To store a key, call T3 `request_secret` with `delivery: "file"`, `url` set to the result's `keyUrl`, and a reason that says the key is stored in the macOS Keychain. Then run `auth-store` with the delivered file path in the same command. The helper checks the key against Linear before it stores it. It writes the key to the Keychain through stdin, so the key is not in a process argument list. Pass `--default` to make that workspace the default. Do not copy the key into chat, payloads, ledgers, logs, or other files. On a platform without the Keychain, ask the human to set `LINEAR_API_KEY` for the session.

When any other command returns `authRequired: true`, stop. Run the secret request and `auth-store` once, then repeat the same command with the same payload and ledger. The ledger keeps all operations that were done before the key failed.

## Target and collection

`target` is `{workspace, team, teamId}`: the workspace URL key, the team key (the `ENG` in `ENG-123`), and the team UUID from `auth-status` or `collect`. A payload records only in that team. Issue URLs use the form `https://linear.app/WORKSPACE/issue/TEAM-N`, optionally with a slug.

`collect` input: `{version, target: {workspace, team}, discover?, duplicate?: {terms, limit}, issueUrl?, includeComments?, metadata?}`.

- `discover: true` reads team and workspace labels, workflow states, projects, current and future cycles, active members, priority values, and the team estimate scale.
- `duplicate` runs a deterministic query. It finds open issues in the team (all state types except `completed` and `canceled`) whose title or description contains any term, without regard to case. Use 1 to 10 terms of 2 to 100 characters each. Set `limit` from 1 to 100. If more issues match than `limit`, the observation is unavailable, not empty. Use narrower terms. Linear semantic search and the Linear MCP server can help find candidate terms during investigation, but only this query is retained and checked again at recording time.
- `issueUrl` with `includeComments: true` retains the selected issue as `{id, identifier, url, title, body, state}` and its comments as `{id, url, body, author}`, sorted by ID. `body` is the issue description.
- `metadata` entries `{id, kind, value}` return the normalized `definition` and whether the value is `usable` for the team. When `issueUrl` is set, they also return the `current` value.

## Payload differences

A Linear payload has `tracker: "linear"`, the Linear `target`, and `account` set to the authenticated Linear user ID. Candidates follow the GitHub payload contract, with these differences:

| Field | Linear contract |
| --- | --- |
| `authorization.kind` | `human`, `main-qa`, or `static-analysis`. Collect Review handoffs record on GitHub. |
| `issueUrl` | A Linear issue URL in the target team, or `null` for `new issue` |
| `duplicate` | `{terms, limit, complete: true, issues, evidence}` with the exact sorted `collect` result. Existing-issue actions also retain `issue` and `comments`. |
| `metadata[].kind` | `label` (added, never removed), `priority` (1 Urgent to 4 Low), `estimate` (an integer on the team scale), `state`, `project`, `cycle`, `assignee` |
| `metadata[].value` | The UUID for labels, states, projects, cycles, and users. The integer for priority and estimate. |
| `metadata[].definition` | The `collect` definition. `name` must match the entry name. When the definition has an `id`, it must equal `value`. |
| `metadata[].observed` | `false` or `null` for a new issue. Otherwise, the current value from `collect`. |
| `images[].destination` | `body` for a new issue. `comment` or `existing` for a duplicate comment. `existing` for other actions. There is no `imageComment`. |
| `images[].attachmentUrl` | For `existing` only: the retained `https://uploads.linear.app/` URL on `surfaceUrl` (the issue URL, or a comment URL with `#comment-ID`) |

The metadata rules in `SKILL.md` apply unchanged. Set state, project, cycle, and assignee only when the human or an authoritative repository rule selects them. On an existing issue, replacing a non-empty single value requires `overwrite: true` and `overwriteAuthority`.

## Recording

`record`, `preflight`, `verify`, and `refresh` take the same inputs as the GitHub helpers. Preflight checks the workspace baseline, image files, the authenticated user, the workspace and team, the selected issue and thread, the duplicate query (except for Plan Mode payloads), and every audited metadata definition and current value. A Plan Mode payload with a changed selected issue or thread is blocked. A payload prepared outside Plan Mode returns `needs-review` with `duplicateReview`. The coordinator then reviews it and runs `refresh` as described in `SKILL.md`.

The recorder writes in this order:

1. It uploads each pending image with Linear `fileUpload`, verifying the approved file hash first. It appends `![caption](assetUrl)` lines to the issue body or comment. An unreferenced upload is private and harmless, so the recorder repeats an upload with an unknown outcome.
2. It creates the issue, with all audited metadata that passed preflight, or it adds the one handoff comment. The ledger stores a client UUID before the request. When a response is lost or rejected, the recorder reads that UUID. If the record exists, the recorder verifies it. If it does not exist, the next run sends the same UUID again, which cannot make a second record. `recover-create` is therefore not necessary for Linear.
3. It writes each remaining metadata entry with a separate `issueUpdate`, then reads the issue again to confirm the value.
4. It verifies the result. It checks the author and title. It checks that the body or comment has the same letters and digits in the same order as the audited text, because Linear can re-render Markdown. It checks each metadata value and that each image URL is on its surface.

The ledger, its lock, and refresh history follow the GitHub rules: it is bound to the payload hash, it is never reset or replaced, and only the reviewed candidate's duplicate observations can change after any of its operations started.

## Validation

```sh
node --test scripts/linear.test.mjs
```

The tests use a fake Linear GraphQL endpoint and a fake Keychain. They do not read the real Keychain or call Linear.
