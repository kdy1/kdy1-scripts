import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialize, applyEvent, submitEvents } from './batch-ledger.mjs';
import { roleEvents } from './batch-delegation.mjs';
import { mergeQueue, mergerStatus } from './batch-merger.mjs';
import { coordinatorView } from './batch-coordinator.mjs';
import { renderHandoff } from './render-handoff.mjs';
import { save } from './helper-common.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), at = '2026-10-11T00:00:00Z', now = Date.parse(at);
const issues = [1, 2, 3].map((n, i) => ({ key: `github.com/o/r/${n}`, number: n, url: `https://github.com/o/r/issues/${n}`, canonicalOrder: i }));
const owner = 'batch:merger';
function root(l, type, fields = {}) { return applyEvent(l, { id: `root:${l.revision}`, at, expectedRevision: l.revision, type, ...fields }, 'root'); }
function fixture(capacity = 4, stacks = 2) {
  const query = 'repo:o/r is:issue is:open';
  let l = initialize({ version: 1, batchId: 'batch', coordinator: 'root', query, repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix selected issues', inspectedSha: base, selection: { complete: true, query, issues } });
  l = root(l, 'groups', { groups: issues.map((issue, i) => ({ id: `g${i}`, issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix function', dependencyEvidence: 'Separate functions' })) });
  for (let i = 0; i < stacks; i++) l = root(l, 'stack', { value: { id: `s${i}`, groups: [`g${i}`], phase: 'building', layers: [], baseSha: base, worktree: `/tmp/s${i}`, fetchedAt: at, revalidationEvidence: 'Fetched exact base' } });
  return root(l, 'delegation-enable', { capacity, evidence: { operationsClear: true, ownersReconciled: true, summary: 'No active workers' } });
}
const url = i => `https://github.com/o/r/pull/${i + 3}`;
function publish(l, i) {
  const layer = { groupId: `g${i}`, branch: `kdy1/fix${i}`, requirementsSatisfied: true, headSha: head, workerSha: base, checks: [{ command: 'node --test', status: 'passed', sha: base }], integrationChanged: false, realWorldValidation: { status: 'passed', sha: base, environment: 'local dev server', evidence: 'Confirmed the fix' } };
  const p = { groupId: `g${i}`, url: url(i), headRepository: 'github.com/o/r', headBranch: `kdy1/fix${i}`, headSha: head, baseBranch: 'main', baseSha: base, title: 'fix: correct function', body: `Fix function\n\nCloses ${issues[i].url}`, closes: [issues[i].url] };
  l = root(l, 'layer', { stackId: `s${i}`, value: layer });
  return root(l, 'publication', { stackId: `s${i}`, verification: { version: 1, expected: { stackId: `s${i}`, baseBranch: 'main', layers: [p] }, observed: { stackId: `s${i}`, complete: true, attachmentComplete: true, layers: [{ ...p, state: 'OPEN', isDraft: false }], attachments: [p.url] } } });
}
function makeReady(l, i) {
  l = publish(l, i);
  l = root(l, 'coordination', { stackId: `s${i}`, value: { phase: 'ready', evidence: 'Registry verified ready' } });
  return root(l, 'ready', { stackId: `s${i}`, detachedSha: head, evidence: 'Clean detached checkout' });
}
function startMerger(l, n = 1, extra = {}) {
  const a = { id: `merger-${n}`, taskId: `merger-${n}`, role: 'merger', lane: 'maintenance', status: 'reserved', slots: 1, worker: `worker-merger-${n}`, worktree: '/tmp/merger', startSha: base, mergeOwner: owner, ...extra };
  l = root(l, 'assignment', { value: a }); l = root(l, 'assignment', { value: { ...a, status: 'active' } });
  const g = { id: `grant-merger-${n}`, role: 'merger', assignmentId: a.id, worker: a.worker, stackIds: [], generation: n, allowedEvents: roleEvents.merger, childAssignmentIds: [] };
  l = root(l, 'delegation-grant', { value: g }); return { l, g, a: l.assignments[a.id] };
}
function send(l, g, events) { return submitEvents(l, { version: 1, grantId: g.id, worker: g.worker, generation: g.generation, sequence: l.delegation.grants[g.id].sequence + 1, at, events }); }
const observation = (i, extra = {}) => ({ evidence: 'Fresh complete reads', outstandingEffects: false, alignmentPending: false, ownershipActive: false, prs: [{ url: url(i), state: 'OPEN', headSha: head }], nextCheckAt: now + 60000, ...extra });
const finish = a => ({ type: 'assignment', value: { ...a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Every batch PR reconciled' } });

test('merger grant starts without stacks, needs two slots and stays unique', () => {
  assert.throws(() => startMerger(fixture(1)), /capacity of at least two/);
  let { l } = startMerger(fixture());
  assert.throws(() => startMerger(l, 2), /Only one merger/);
  const a = { id: 'm', taskId: 'm', role: 'merger', lane: 'maintenance', status: 'reserved', slots: 1, worker: 'w', worktree: '/tmp/m', startSha: base, mergeOwner: owner };
  let other = root(root(fixture(), 'assignment', { value: a }), 'assignment', { value: { ...a, status: 'active' } });
  assert.throws(() => root(other, 'delegation-grant', { value: { id: 'g', role: 'merger', assignmentId: 'm', worker: 'w', stackIds: ['s0'], generation: 1, allowedEvents: roleEvents.merger } }), /starts without stacks/);
  other = root(root(fixture(), 'assignment', { value: { ...a, mergeOwner: undefined } }), 'assignment', { value: { ...a, mergeOwner: undefined, status: 'active' } });
  assert.throws(() => root(other, 'delegation-grant', { value: { id: 'g', role: 'merger', assignmentId: 'm', worker: 'w', stackIds: [], generation: 1, allowedEvents: roleEvents.merger } }), /stable merge owner/);
});

test('merger joins ready stacks through its own events and never touches building stacks', () => {
  let l = makeReady(fixture(), 0);
  const m = startMerger(l); l = m.l;
  assert.throws(() => send(l, m.g, [{ type: 'stack-observation', stackId: 's1', value: observation(1) }]), /only on ready stacks/);
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's0', value: observation(0) }]);
  assert.deepEqual(l.delegation.grants[m.g.id].stackIds, ['s0']);
  l = makeReady(l, 1);
  l = send(l, m.g, [{ type: 'checkpoint', value: { type: 'candidate', queue: 'merge', stackId: 's1', prs: [url(1)], evidence: 'Fresh gates' } }]);
  assert.deepEqual(l.delegation.grants[m.g.id].stackIds, ['s0', 's1']);
  // Per-stack maintenance cannot overlap the merger.
  const a = { id: 'maint', taskId: 'maint', stackId: 's0', role: 'maintenance', lane: 'maintenance', status: 'reserved', slots: 1, worker: 'w', worktree: '/tmp/x', startSha: base };
  l = root(root(l, 'assignment', { value: a }), 'assignment', { value: { ...a, status: 'active' } });
  assert.throws(() => root(l, 'delegation-grant', { value: { id: 'gm', role: 'maintenance', assignmentId: 'maint', worker: 'w', stackIds: ['s0'], generation: 1, allowedEvents: roleEvents.maintenance } }), /another execution owner|cannot both be active/);
});

test('active repair blocks a new merge operation; merger keeps its slot until effects are known', () => {
  let l = makeReady(fixture(), 0);
  const m = startMerger(l); l = m.l;
  const repair = { id: 'repair', taskId: 'repair', stackId: 's0', lane: 'repair', status: 'reserved', slots: 1, worktree: '/tmp/r', startSha: head };
  const repaired = root(l, 'assignment', { value: repair });
  const op = { id: 'merge-1', kind: 'standalone-auto-merge', owner, token: 't1', headSha: head, status: 'uncertain' };
  assert.throws(() => send(repaired, m.g, [{ type: 'operation', stackId: 's0', value: op }]), /Active repair blocks/);
  l = send(l, m.g, [
    { type: 'coordination', stackId: 's0', value: { phase: 'ready', owner, token: 't1', evidence: 'Edit token acquired' } },
    { type: 'operation', stackId: 's0', value: op },
  ]);
  assert.throws(() => send(l, m.g, [finish(m.a)]), /Unreconciled effects/);
  l = send(l, m.g, [
    { type: 'operation', stackId: 's0', value: { ...op, status: 'verified', outcome: 'auto_merge_pending' }, reconciled: true, evidence: 'autoMergeRequest at exact head' },
    { type: 'stack-observation', stackId: 's0', value: observation(0, { outstandingEffects: true, ownershipActive: true, headSha: head, autoMergePending: true }) },
  ]);
  // A verified auto-merge wait keeps the token, not the slot.
  const done = send(l, m.g, [finish(m.a)]);
  assert.equal(done.delegation.grants[m.g.id].status, 'finished');
  // A replacement keeps the stable owner and inherits the waiting stack.
  const next = startMerger(done, 2); let r = next.l;
  r = send(r, next.g, [{ type: 'stack-observation', stackId: 's0', value: observation(0, { outstandingEffects: true, ownershipActive: true, headSha: head, autoMergePending: true }) }]);
  assert.deepEqual(r.delegation.grants[next.g.id].stackIds, ['s0']);
  assert.throws(() => startMerger(done, 2, { mergeOwner: 'someone-else' }), /stable merge owner/);
});

test('queue orders due stacks by mergeable PRs and keeps the merger alive until every PR merges', () => {
  let l = makeReady(makeReady(fixture(4, 3), 0), 1);
  let q = mergeQueue(l, now);
  assert.deepEqual(q.due, ['s0', 's1']);
  assert.equal(q.finish.allowed, false); assert.match(q.finish.reason, /Construction/);
  const m = startMerger(l); l = m.l;
  l = send(l, m.g, [
    { type: 'stack-observation', stackId: 's0', value: observation(0, { mergeablePrCount: 0 }) },
    { type: 'stack-observation', stackId: 's1', value: observation(1, { mergeablePrCount: 1, nextCheckAt: now - 1 }) },
  ]);
  q = mergeQueue(l, now);
  assert.deepEqual(q.due, ['s1']); assert.equal(q.waitMs, 0);
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's1', value: observation(1, { nextCheckAt: now + 120000 }) }]);
  q = mergeQueue(l, now);
  assert.deepEqual(q.due, []); assert.equal(q.waitMs, 30000);
  assert.equal(mergeQueue(l, now + 59000).waitMs, 1000);
  // A coordinator event about the stack makes it due again before its deadline.
  l = root(l, 'checkpoint', { value: { type: 'invalidate', stackId: 's0', at: now } });
  assert.deepEqual(mergeQueue(l, now).due, ['s0']);
  // Blocked stacks wait for a change; repairing stacks are never due.
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's0', value: observation(0, { blocked: true, blocker: 'Human finding', nextCheckAt: null }) }]);
  assert.equal(mergeQueue(l, now).stacks.find(x => x.id === 's0').status, 'blocked');
  assert.deepEqual(mergeQueue(l, now + 600000).due, ['s1']);
  l = root(l, 'assignment', { value: { id: 'repair', taskId: 'repair', stackId: 's1', lane: 'repair', status: 'reserved', slots: 1, worktree: '/tmp/r', startSha: head } });
  assert.equal(mergeQueue(l, now + 600000).stacks.find(x => x.id === 's1').status, 'repairing');
  assert.deepEqual(mergeQueue(l, now + 600000).due, []);
  // Merged stacks drop out; the merger stays while a stack is still building.
  const merged = i => observation(i, { prs: [{ url: url(i), state: 'MERGED', headSha: head, mergeCommitSha: base }] });
  l = root(l, 'assignment', { value: { ...l.assignments.repair, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Repaired' } });
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's0', value: merged(0) }, { type: 'stack-observation', stackId: 's1', value: merged(1) }]);
  q = mergeQueue(l, now);
  assert.deepEqual(q.mergedStacks, ['s0', 's1']); assert.deepEqual(q.buildingStacks, ['s2']); assert.equal(q.finish.allowed, false);
  l = makeReady(l, 2);
  assert.match(mergeQueue(l, now).finish.reason, /Construction can still publish/);
  l = root(l, 'implementation-ended');
  assert.match(mergeQueue(l, now).finish.reason, /open PRs/);
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's2', value: merged(2) }]);
  q = mergeQueue(l, now);
  assert.equal(q.finish.allowed, true); assert.equal(q.waitMs, 0);
});

test('a stop limits due work to batch-owned auto-merge cancellation', () => {
  let l = makeReady(fixture(), 0);
  const m = startMerger(l); l = m.l;
  l = send(l, m.g, [{ type: 'stack-observation', stackId: 's0', value: observation(0, { nextCheckAt: now - 1 }) }]);
  l = root(l, 'maintenance', { value: { mode: 'batch', management: 'direct', state: 'stopped' } });
  const q = mergeQueue(l, now);
  assert.deepEqual(q.due, []); assert.equal(q.finish.allowed, true);
  assert.equal(mergerStatus(l, now).needed, false);
});

test('coordinator allocates the merger first after the first publication and replaces a finished one', () => {
  let l = publish(fixture(2), 0);
  l.scheduler = { version: 1, capacity: 2, tasks: [{ id: 'impl', stack: 's1', lane: 'implementation', status: 'pending', eligible: true, requires: [] }, { id: 'pub', stack: 's1', lane: 'publication', status: 'pending', eligible: true, requires: [] }] };
  const dir = mkdtempSync(join(tmpdir(), 'batch-merger-'));
  try {
    const requestState = join(dir, 'requests.json'); save(requestState, { version: 1, cooldowns: {} });
    let view = coordinatorView(l, { ledgerPath: join(dir, 'ledger.json'), requestState, at: now });
    assert.equal(view.control.merger.needed, true); assert.equal(view.control.merger.taskId, 'merger-1');
    assert.deepEqual(view.control.allocations.map(a => a.id), ['merger-1', 'pub']);
    const m = startMerger(l); l = m.l;
    view = coordinatorView(l, { ledgerPath: join(dir, 'ledger.json'), requestState, at: now });
    assert.equal(view.control.merger.needed, false); assert.equal(view.control.merger.assignmentId, 'merger-1');
    assert.deepEqual(view.control.allocations.map(a => a.id), ['pub']);
    l = send(l, m.g, [finish(m.a)]);
    view = coordinatorView(l, { ledgerPath: join(dir, 'ledger.json'), requestState, at: now });
    assert.equal(view.control.merger.needed, true); assert.equal(view.control.merger.taskId, 'merger-2'); assert.equal(view.control.merger.generation, 2);
    assert.equal(view.control.merger.mergeOwner, owner);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('merger START renders loop instructions and binds the merge owner', () => {
  const { l, g, a } = startMerger(makeReady(fixture(), 0));
  const assignment = { assignmentId: a.id, grantId: g.id, generation: 1, worker: a.worker, checkout: a.worktree, startSha: base, mergeOwner: owner, scope: 'Merge every passing batch PR', repositoryInstructions: 'AGENTS.md', concurrency: 'capacity 4', estimateEvidence: 'none', requestHelper: '/x/github-request.mjs', requestState: '/x/requests.json', schedulerHelper: '/x/batch-scheduler.mjs', timingState: '/x/timing.json', ledgerPath: '/x/ledger.json', batchSkill: '/s/SKILL.md', batchReference: '/s/references/batch-maintenance.md', coordinationRoot: '/repo/.git', capacityAccounting: 'merger holds one slot', mergerHelper: '/s/scripts/batch-merger.mjs', mergeSkill: '/skills/merge-pr/SKILL.md' };
  const text = renderHandoff({ version: 1, mode: 'execution', role: 'merger', phase: 'start', ledger: l, assignment });
  assert.match(text, /do not finish while the queue finish rule is false/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'merger', phase: 'start', ledger: l, assignment: { ...assignment, mergeOwner: 'other' } }), /merge owner/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'merger', phase: 'start', ledger: l, assignment: { ...assignment, mergerHelper: undefined } }), /absolute path/);
});

test('queue CLI reads the ledger and prints evidence pointers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-merger-'));
  try {
    const ledgerPath = join(dir, 'ledger.json'), input = join(dir, 'input.json');
    save(ledgerPath, makeReady(fixture(), 0)); save(input, { version: 1, ledgerPath, at: now });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./batch-merger.mjs', import.meta.url)), 'queue', input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const q = JSON.parse(result.stdout);
    assert.deepEqual(q.due, ['s0']); assert.deepEqual(q.stacks[0].evidence, { path: ledgerPath, field: 'stacks.s0' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
