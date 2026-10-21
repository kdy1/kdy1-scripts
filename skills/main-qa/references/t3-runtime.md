# MainQA in T3 Chat / T3 Code

Apply this contract to QA workers, issue coordinators, investigators, and recorders. Keep MainQA's authorization, scope, required Luna settings, and root-controlled ten-descendant budget across provider boundaries.

## Discover and validate capabilities

Read `orchestrator_capabilities` for live provider instances, models, model options, active interaction mode, and app-owned subagent support. Do not infer support from the native `spawn_agent` model list. If tool discovery omits T3 tools, make one direct `mcp__t3_code__orchestrator_capabilities({})` attempt before declaring them absent.

When MCP tools are not callable but `T3_ACP_MCP_NODE` is present, use the supported transport:

```sh
ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" ${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'
```

The same transport accepts other tool names and one serialized JSON argument. Use a JSON serializer and proper shell quoting or a file read into a quoted argument. Never interpolate task prose into shell code. Do not access private app APIs or spawn ordinary conversations as a fallback.

Save the returned raw catalog or MCP response with `structuredContent` to a private absolute path outside the app checkout. Run:

```sh
python3 <absolute-main-qa-path>/scripts/select-target.py <absolute-capabilities-json>
```

Use `--provider <providerInstanceId>` to require a particular instance. Otherwise the helper prefers the inherited instance when eligible, then another eligible catalog instance. It checks app-owned delegation support, provider eligibility, the exact `gpt-5.6-luna` ID, and the `reasoningEffort` option's `xhigh` value. The output is the complete `target` object; do not invent provider IDs or silently use defaults. Pass this target through reporting handoffs and verify it against the live catalog in each delegating environment. Missing support blocks affected phases, without substituting another model or local execution.

## Delegate and retain task identity

Use `delegate_task` with the helper's explicit `target`, a unique `title`, `mode: "async"`, and a run/role/item-specific `clientRequestId`. Default shared isolation is appropriate for browser QA and read-only investigation of the actual app checkout, including pre-existing edits. Use `isolation: "worktree"` only when a phase needs a separate checkout: it starts at the parent's committed revision, runs setup, and does not copy uncommitted edits. Never assume a worktree represents the running app's revision.

T3 children receive only the supplied task prompt. Include the original human MainQA invocation and restrictions, delegation chain, run and candidate/item IDs, target URL/repository/revision evidence, installed skill/reference paths, expected checks, browser/data ownership, root and immediate-parent thread IDs, model target, slot grants, and output requirements. Record `taskId`, `childThreadId`, `childRunId`, provider/model evidence, and slot ownership after acceptance. Do not claim the reasoning option was verified solely because the returned model ID matches.

Recover a lost delegation response by retrying the identical request with the same `clientRequestId`, then inspect the recovered `taskId` with `task_status`. Hold the allocation while uncertain. A new ID creates new work and is not a recovery mechanism. Verify terminal state, `workState: "result_available"`, and `hasPendingChildRuns: false` before releasing capacity; a completed turn with nested work is still occupying the run budget. `waitTimedOut` is a parent wait timeout, not cancellation. Cancel through `task_cancel` and verify the resulting state before releasing a slot.

Each continuation or reassignment uses a new `delegate_task` and request ID with the original brief, completed evidence, prior outcomes, and unresolved work. Do not use `t3_thread_send` to the backing `childThreadId` to start more delegated work. Do not use `create_threads`, `t3_thread_launch`, or scheduling for MainQA descendants.

Async completion wakes the parent. Continue discovery, evidence reconciliation, and ready issue handoffs while workers run. When no independent work remains, yield with an explicit in-progress status; resume on completion without a polling loop or watcher. Use `task_status` only when a result is needed during active work. Resolve a child's `hasPendingQuestion` through `t3_pending_request_list/read/respond` with its `childThreadId`, within existing authorization; ask the human for missing decisions. These tools do not approve permissions.

## Send discoveries and allocate nested work

Use `t3_thread_send` to the supplied MainQA root thread ID with `mode: "auto"` and a stable per-message `clientRequestId`. This is an in-run progress report or slot request to the coordinator, not another task assignment. Include run, task/role, coverage/candidate IDs, sanitized evidence, and a message sequence ID. Retry uncertain message delivery with the same ID. Updates for the same candidate identify the earlier observation; the root deduplicates them centrally.

Send each candidate immediately, then continue independent checks. Send browser handles, blockers, slot requests, and issue outcomes through the same channel. If messaging is absent or rejected, return the observation/blocker immediately with completed and remaining coverage so task completion wakes the parent. The parent processes the candidate before delegating unfinished checks again. Do not wait until all assigned checks finish to expose a candidate.

Only the root grants slots. A reporting coordinator may use a root-granted role-specific nested allocation for an investigator and subsequently a distinct recorder after verified investigator release. Obtain any additional grant through a progress message before delegation. If no messaging channel is usable, return the allocation request and full continuation context to the parent; do not silently exceed the allocation or perform the delegated phase locally. Every child reports accepted handles and terminal state to both its immediate coordinator and the root, so nested occupancy is visible. Keep the issue-reporting reservation protected while QA continues.

## Browser ownership and evidence

Honor explicit human browser/tab selection. Otherwise use T3's collaborative browser. Call `preview_status` first, including its available profiles and tab owners. If no automation-capable tab is attached, call `preview_open` before treating the browser as unavailable. The acting worker opens its own allocated tab with `reuseExistingTab: false`, optionally passing the selected `profileId`, and reports the returned `tabId` to the root. Pass that ID on every subsequent call. The root allocates permission to open a tab, not control of a tab it owns. Inspect human-owned or other-agent tabs through `preview_snapshot` only. Never take over a human-controlled tab.

Use `preview_navigate`, `preview_snapshot`, and focused interaction tools. Prefer snapshot-provided locators; refresh them after navigation, snapshots, or human takeover. Save screenshots with `preview_snapshot({tabId, save:true})`. Record actual viewport dimensions, URL, state, and sanitized screenshot paths. Keep sanitized evidence outside the app checkout and accessible to the receiving investigator or recorder. If tools cannot expose console/network data, record that inspection limit instead of claiming those checks passed.

Use another browser only when the T3 tools are absent, `preview_open` explicitly reports unsupported/unavailable, the human or an invoked documented workflow selects another browser, or the same step on an open tab fails twice. For repeated failures, quote the raw error and record the fallback. Correct actionable arguments before retrying. Do not switch because the preview is merely closed. Follow the alternative browser's instructions, preserve the human preference and root allocations, and leave an unavailable explicitly selected browser/tab blocked.

Tabs and profiles can share authentication, storage, and backend data. Root-owned shared-state grants still apply across browsers and provider instances. Each agent releases only its own run-created tabs using supported tools; preserve human tabs, evidence, and unresolved cleanup state. A T3 thread attachment is not a GitHub-native issue attachment; `$add-issue` retains ownership of portable evidence and recording.
