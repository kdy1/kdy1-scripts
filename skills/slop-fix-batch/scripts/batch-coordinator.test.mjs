import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, applyEvent } from './batch-ledger.mjs';
import { readJson, save } from './helper-common.mjs';
import { observe, dispatch, waitPolicy } from './batch-coordinator.mjs';
const sha = 'a'.repeat(40), issue = { key: 'github.com/o/r/1', url: 'https://github.com/o/r/issues/1', canonicalOrder: 0 };
const at = '2026-10-12T00:00:00Z';
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-coordinator-'));
  const path = join(dir, 'ledger.json'), api = join(dir, 'api.json');
  const l = initialize({ version: 1, batchId: 'b', coordinator: 'root', repository: 'github.com/o/r', query: 'is:issue is:open',
    selection: { complete: true, query: 'is:issue is:open', issues: [issue] }, inspectedSha: sha, authorization: 'Fix the fixed list; no manual CI', baseBranch: 'main', remote: 'origin', context: { requestState: api } });
  l.maintenance = { state: 'active', management: 'direct' };
  l.checkpoints.nextFullAt = 300000; l.scheduler = { version: 1, capacity: 3, tasks: [] };
  save(path, l); save(api, { version: 1, cooldowns: {} });
  try { return fn({ dir, path, api, l, input: { version: 1, ledgerPath: path, at: 0 } }); }
  finally { rmSync(dir, { force: true, recursive: true }); }
}
function event(l, type, value) { return applyEvent(l, { id: `e${l.revision}`, expectedRevision: l.revision, at, type, value }, 'root'); }
function preparation(path, role = 'investigation') {
  const dir = join(path, '..');
  const assignment = { assignmentId: 'a', ledgerPath: path, scope: 'Investigate the selected issue', repositoryInstructions: '/repo/AGENTS.md',
    concurrency: 'One reserved slot', estimateEvidence: 'One function', requestHelper: '/skill/github-request.mjs', requestState: join(dir, 'api.json'),
    schedulerHelper: '/skill/batch-scheduler.mjs', timingState: join(dir, 'timing.json'), checkout: '/repo/worker', startSha: sha, inspectedSha: sha,
    issueKeys: [issue.key], complexity: 'standard', complexityReason: 'Requires investigation' };
  return { version: 1, requestId: 'prepare-a', expectedRevision: 0, at, ledgerPath: path, coordinator: 'root', mode: 'execution', role,
    reservation: { id: 'a', taskId: 'investigate', lane: role, role, status: 'reserved', slots: 1, worktree: assignment.checkout, startSha: sha,
      complexity: assignment.complexity, complexityReason: assignment.complexityReason }, assignment };
}
function start(p, result) { return { ...p, requestId: 'start-a', expectedRevision: result.revision, reservation: undefined, assignment: { ...p.assignment, worker: 'worker-a' } }; }

test('unchanged time only returns empty changes; deadlines and cooldowns become visible', () => fixture(({ input, path, api, l }) => {
  l.checkpoints.refresh = { s: 60000 }; save(path, l);
  const first = observe(input); assert.equal(first.mode, 'recovery'); assert.equal(first.nextCheckAt, 60000);
  const next = observe({ ...input, at: 30000 }); assert.equal(next.changed, false); assert.deepEqual(next.changes, { assignments: {}, stacks: {}, tasks: {} });
  assert.equal(next.waitMs, 30000);
  const due = observe({ ...input, at: 60000 }); assert.equal(due.changes.control.remoteRefreshRunnable, true); assert.equal(due.waitMs, 0);
  save(api, { version: 1, cooldowns: { all: 120000 } });
  const paused = observe({ ...input, at: 60000 }); assert.equal(paused.changes.control.remoteRefreshRunnable, false); assert.equal(paused.nextCheckAt, 120000); assert.equal(paused.waitMs, 30000);
  const released = observe({ ...input, at: 120000 }); assert.equal(released.changes.control.remoteRefreshRunnable, true);
  rmSync(api); const unknown = observe({ ...input, at: 120001 }); assert.equal(unknown.changes.control.api.known, false); assert.equal(unknown.changes.control.remoteRefreshRunnable, false);
}));

test('cooldown suppresses remote allocations but preserves independent local implementation', () => fixture(({ input, path, api, l }) => {
  l.scheduler.tasks = ['publication', 'maintenance', 'repair', 'inventory', 'implementation'].map((lane, i) => ({ id: lane, stack: 's'+i, lane, status: 'pending', eligible: true, requires: [] }));
  save(path, l); save(api, { version: 1, cooldowns: { core: 100000 } });
  const r = observe(input); assert.deepEqual(r.changes.control.allocations.map(a => a.lane), ['implementation']);
  assert.equal(r.changes.control.remoteRefreshRunnable, false);
}));

test('cursor corruption and other batch recover safely', () => fixture(({ input, path, l }) => {
  let r = observe(input); writeFileSync(r.cursorPath, '{'); assert.equal(observe(input).mode, 'recovery');
  let c = readJson(r.cursorPath); c.batchId = 'other'; save(r.cursorPath, c); assert.equal(observe(input).mode, 'recovery');
}));

test('rollback and diverging ledger histories invalidate cursor; explicit resume stays compact', () => fixture(({ input, path, l }) => {
  const next = event(l, 'scheduler', { version: 1, capacity: 2, tasks: [] }); save(path, next); observe(input);
  save(path, l); assert.equal(observe(input).mode, 'recovery');
  save(path, next); observe(input);
  const different = event(l, 'scheduler', { version: 1, capacity: 1, tasks: [] }); save(path, different);
  assert.equal(observe(input).mode, 'recovery');
  assert.equal(observe(input, true).recovery.reason, 'explicit-resume');
}));

test('head, owner, uncertain effects, check result and assignment completion are detected', () => fixture(({ input, path, l }) => {
  l.groups.g = { id: 'g', issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix', dependencyEvidence: 'Independent' };
  l.stacks.s = { id: 's', groups: ['g'], phase: 'building', baseSha: sha, layers: [], coordination: { owner: 'one', token: 'token' } };
  l.assignments.a = { id: 'a', taskId: 't', lane: 'implementation', status: 'active', slots: 1, worker: 'w', worktree: '/repo', startSha: sha };
  save(path, l); observe(input);
  l.stacks.s.baseSha = 'b'.repeat(40); l.stacks.s.coordination.owner = 'two';
  l.stacks.s.operations = { op: { id: 'op', status: 'uncertain', kind: 'push', owner: 'two', headSha: sha } };
  l.stacks.s.maintenance = { checks: [{ id: 1, conclusion: 'failure' }] };
  l.assignments.a = { ...l.assignments.a, status: 'finished', slots: 0, outcome: 'failed', evidence: '/batch/failure.json' };
  save(path, l); const r = observe(input);
  assert.equal(r.changes.stacks.s.baseSha, 'b'.repeat(40)); assert.equal(r.changes.stacks.s.coordination.owner, 'two');
  assert.equal(r.changes.stacks.s.uncertainOperations.length, 1); assert.equal(r.changes.assignments.a.outcome, 'failed');
  const oldHash = r.changes.stacks.s.observationHash;
  l.stacks.s.maintenance.checks[0].conclusion = 'success'; save(path, l);
  assert.notEqual(observe(input).changes.stacks.s.observationHash, oldHash);
}));

test('summary excludes completed assignment history and large evidence', () => fixture(({ input, path, l }) => {
  const small = JSON.stringify(observe(input, true)).length;
  for (let i = 0; i < 200; i++) l.assignments['done'+i] = { id: 'done'+i, taskId: 'old'+i, lane: 'investigation', status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Large evidence '.repeat(1000) };
  save(path, l); const r = observe(input, true);
  assert.ok(JSON.stringify(r).length <= small + 20); assert.deepEqual(r.changes.assignments, {});
  assert.equal(observe(input).changed, false);
}));

test('prepare/start reuse settings, persist once, and require reconciliation on retries', () => fixture(({ path }) => {
  const p = preparation(path); p.assignment.findings = 'Full evidence '.repeat(1000);
  const prepared = dispatch('prepare', p); assert.equal(prepared.revision, 1); assert.equal(prepared.settings.model, 'gpt-6.1-sol');
  assert.equal(prepared.evidencePaths.length, 1); assert.equal(readJson(path).assignments.a.status, 'reserved');
  const retry = dispatch('prepare', p); assert.equal(retry.delivery, 'reconcile-before-send'); assert.equal(readJson(path).revision, 1);
  assert.throws(() => dispatch('prepare', { ...p, assignment: { ...p.assignment, scope: 'Different' } }), /Conflicting duplicate/);
  const s = start(p, prepared); const started = dispatch('start', s);
  assert.equal(started.revision, 2); assert.equal(readJson(path).assignments.a.worker, 'worker-a');
  assert.equal(dispatch('start', s).delivery, 'reconcile-before-send'); assert.equal(readJson(path).revision, 2);
  assert.throws(() => dispatch('prepare', p), /advanced or stopped/);
  let l = readJson(path); l = event(l, 'assignment', { ...l.assignments.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: '/result.json' }); save(path, l);
  assert.throws(() => dispatch('start', s), /advanced or stopped/);
}));

test('invalid input, revision race, lock contention and failed START do not commit authority', () => fixture(({ path }) => {
  const p = preparation(path), original = readJson(path);
  assert.throws(() => dispatch('prepare', { ...p, assignment: { ...p.assignment, inspectedSha: 'main' } }), /SHA/);
  assert.deepEqual(readJson(path), original);
  assert.throws(() => dispatch('prepare', { ...p, expectedRevision: 42 }), /revision/);
  mkdirSync(path+'.lock'); assert.equal(dispatch('prepare', p).status, 'busy'); rmSync(path+'.lock', { recursive: true });
  const prepared = dispatch('prepare', p), reserved = readJson(path), s = start(p, prepared);
  assert.throws(() => dispatch('start', { ...s, assignment: { ...s.assignment, scope: 'Expanded' } }), /prepared scope/);
  assert.throws(() => dispatch('start', { ...s, assignment: { ...s.assignment, checkout: '/other' } }), /scope\/checkout/);
  assert.deepEqual(readJson(path), reserved);
  // Staged artifacts without a ledger commit are harmless; rerunning the original
  // operation recreates them, without assuming a worker was created or messaged.
  save(path, original); assert.equal(dispatch('prepare', p).replayed, false); assert.equal(readJson(path).revision, 1);
}));

test('wait policy respects process backoff, deadlines, immediate work and invalid input', () => {
  assert.equal(waitPolicy({ at: 0, process: true }), 10000);
  assert.equal(waitPolicy({ at: 0, process: true, unchanged: 1 }), 20000);
  assert.equal(waitPolicy({ at: 0, process: true, unchanged: 50 }), 30000);
  assert.equal(waitPolicy({ at: 100, nextCheckAt: 500 }), 400);
  assert.equal(waitPolicy({ at: 100, nextCheckAt: 50 }), 0);
  assert.equal(waitPolicy({ at: 0, actionable: true }), 0);
  assert.throws(() => waitPolicy({ at: NaN }), /Invalid/);
});

test('refresh timestamps do not replay observations; changed failures still do', () => fixture(({ input, path, l }) => {
  l.groups.g = { id: 'g', issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix', dependencyEvidence: 'Independent' };
  l.stacks.s = { id: 's', groups: ['g'], phase: 'building', baseSha: sha, layers: [], maintenance: { readAt: 100, evidence: '/old.json', checks: [{ id: 1, conclusion: 'success' }] } };
  save(path, l); observe(input);
  l.stacks.s.maintenance.readAt = 200; l.stacks.s.maintenance.evidence = '/new.json'; save(path, l);
  assert.equal(observe(input).changed, false);
  l.stacks.s.maintenance.checks[0].conclusion = 'failure'; save(path, l);
  assert.ok(observe(input).changes.stacks.s);
}));

test('uncertain shared writes are exposed without globally blocking independent reads', () => fixture(({ input, api, path, l }) => {
  l.checkpoints.nextFullAt = 0; save(path, l);
  save(api, { version: 1, cooldowns: {}, writes: { attempt: { status: 'uncertain', method: 'POST', url: '/pulls' } } });
  const r = observe(input); assert.equal(r.changes.control.api.uncertainWrites[0].id, 'attempt');
  assert.equal(r.changes.control.remoteRefreshRunnable, true);
}));

test('delegated START atomically binds grant identity; revoked grants cannot be replayed', () => fixture(({ path, l }) => {
  l.groups.g = { id: 'g', issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix', dependencyEvidence: 'Independent' };
  l.stacks.s = { id: 's', groups: ['g'], phase: 'building', baseSha: sha, layers: [] };
  l = applyEvent(l, { id: 'enable', expectedRevision: 0, at, type: 'delegation-enable', capacity: 3, evidence: { operationsClear: true, ownersReconciled: true, summary: 'Idle' } }, 'root'); save(path, l);
  const p = preparation(path, 'inventory'); p.expectedRevision = 1;
  const prepared = dispatch('prepare', p), s = start(p, prepared);
  s.assignment.grantId = 'grant'; s.assignment.generation = 1;
  s.grant = { id: 'grant', assignmentId: 'a', worker: 'worker-a', role: 'inventory', stackIds: ['s'], generation: 1, allowedEvents: ['checkpoint', 'assignment'] };
  const invalid = { ...s, grant: { ...s.grant, worker: 'other' } };
  assert.throws(() => dispatch('start', invalid), /Grant identity/); assert.equal(readJson(path).assignments.a.status, 'reserved');
  const started = dispatch('start', s); assert.equal(started.revision, prepared.revision + 2);
  assert.equal(readJson(path).delegation.grants.grant.worker, 'worker-a');
  assert.equal(dispatch('start', s).replayed, true);
  l = readJson(path); l.delegation.grants.grant.status = 'revoked'; save(path, l);
  assert.throws(() => dispatch('start', s), /delegation/);
}));

test('Claude dispatch keeps recorded runtime settings and uncertain assignment blocks START', () => fixture(({ path, l }) => {
  l.context.runtime = 'claude-code'; save(path, l);
  const p = preparation(path), r = dispatch('prepare', p);
  assert.deepEqual(r.settings, { subagent_type: 'general-purpose', model: 'sonnet', effort: 'high' });
  l = readJson(path); l = event(l, 'assignment', { ...l.assignments.a, status: 'uncertain' }); save(path, l);
  assert.throws(() => dispatch('start', { ...start(p, r), expectedRevision: l.revision }), /reserved/);
}));

test('changed dispatch artifacts cannot be reused as a successful receipt', () => fixture(({ path }) => {
  const p = preparation(path), r = dispatch('prepare', p);
  const message = readJson(r.messagePath); save(r.messagePath, { message: 'Changed message' });
  assert.throws(() => dispatch('prepare', p), /artifact changed/);
  save(r.messagePath, message);
  const packed = readJson(r.handoffPath); packed.assignment.scope = 'Expanded scope'; save(r.handoffPath, packed);
  assert.throws(() => dispatch('start', start(p, r)), /Prepared handoff changed/);
  assert.equal(readJson(path).assignments.a.status, 'reserved');
}));

test('legacy capacity and stopped management reject dispatch without consuming a slot', () => fixture(({ path, l }) => {
  l.scheduler.capacity = 0; save(path, l);
  const p = preparation(path);
  assert.throws(() => dispatch('prepare', p), /capacity/); assert.deepEqual(readJson(path).assignments, {});
  l.scheduler.capacity = 1; l.maintenance = { state: 'stopped' }; save(path, l);
  assert.throws(() => dispatch('prepare', p), /stopped/);
  const r = observe({ version: 1, ledgerPath: path, at: 300001 }); assert.equal(r.changes.control.remoteRefreshRunnable, false);
}));

test('stack-execution START retains checked group identity and exact grant', () => fixture(({ path, l }) => {
  l.groups.g = { id: 'g', issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix', dependencyEvidence: 'Independent' };
  l.stacks.s = { id: 's', groups: ['g'], phase: 'building', baseSha: sha, layers: [] };
  l = applyEvent(l, { id: 'enable', expectedRevision: 0, at, type: 'delegation-enable', capacity: 3, evidence: { operationsClear: true, ownersReconciled: true, summary: 'Idle' } }, 'root'); save(path, l);
  const p = preparation(path, 'stack-execution'); p.expectedRevision = 1;
  Object.assign(p.assignment, { stackId: 's', groupId: 'g', acceptance: 'Fix', dependencyEvidence: 'Independent', integrationWorktree: '/repo/worker',
    coordinationHelper: '/skill/stack-coordination.mjs', coordinationRoot: '/repo/.git', stackHelper: '/skill/batch-stack.mjs', coordinationId: 's', stackOwner: 'builder', branch: 'fix',
    createPrSkill: '/skill/create-pr/SKILL.md', workerStartSha: sha, requirementsSatisfied: true, commits: [sha], checks: [{ command: 'check', status: 'passed', sha }], integrationCheckCommands: [] });
  Object.assign(p.reservation, { lane: 'publication', stackId: 's', groupId: 'g', branch: 'fix', commits: [sha], coordinationId: 's', stackOwner: 'builder' });
  const r = dispatch('prepare', p), s = start(p, r);
  s.assignment.grantId = 'grant'; s.assignment.generation = 1;
  s.grant = { id: 'grant', assignmentId: 'a', worker: 'worker-a', role: 'stack-execution', stackIds: ['s'], generation: 1, allowedEvents: ['layer', 'assignment'] };
  assert.throws(() => dispatch('start', { ...s, assignment: { ...s.assignment, commits: ['b'.repeat(40)] } }), /prepared commits/);
  const result = dispatch('start', s);
  assert.equal(result.phase, 'start'); assert.equal(readJson(path).delegation.grants.grant.role, 'stack-execution');
}));


test('an unstarted batch does not request an inventory before its first verified prefix', () => fixture(({ input, path, l }) => {
  l.maintenance = null; l.checkpoints.nextFullAt = 0; save(path, l);
  const r = observe(input); assert.equal(r.changes.control.checkpoints.fullDue, true);
  assert.equal(r.changes.control.remoteRefreshRunnable, false); assert.equal(r.waitMs, 30000);
}));


test('changing runtime after preparation cannot silently change an existing worker setting', () => fixture(({ path }) => {
  const p = preparation(path), r = dispatch('prepare', p);
  const l = readJson(path); l.context.runtime = 'claude-code'; save(path, l);
  assert.throws(() => dispatch('prepare', p), /runtime changed/);
  assert.throws(() => dispatch('start', start(p, r)), /runtime changed/);
  assert.equal(readJson(path).assignments.a.status, 'reserved');
}));
