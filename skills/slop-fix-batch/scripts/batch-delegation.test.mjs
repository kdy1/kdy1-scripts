import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { initialize, applyEvent, submitEvents, submitLedger, schedulingSnapshot } from './batch-ledger.mjs';
import { roleEvents } from './batch-delegation.mjs';
import { renderHandoff } from './render-handoff.mjs';
import { runStep, reconcileStep, prepareWorktree, runCommand } from './batch-stack.mjs';
import { checkpointPlan } from './batch-checkpoints.mjs';
import { plan } from './batch-scheduler.mjs';
import { save } from './helper-common.mjs';
const base = 'a'.repeat(40), head = 'b'.repeat(40), at = '2026-10-11T00:00:00Z';
const issues = [1, 2].map((n, i) => ({ key: `github.com/o/r/${n}`, number: n, url: `https://github.com/o/r/issues/${n}`, canonicalOrder: i }));
function root(l, type, fields = {}) { return applyEvent(l, { id: `root:${l.revision}`, at: l.events.at(-1)?.at ?? at, expectedRevision: l.revision, type, ...fields }, 'root'); }
function fixture(capacity = 4) {
  const query = 'repo:o/r is:issue is:open';
  let l = initialize({ version: 1, batchId: 'batch', coordinator: 'root', query, repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix selected issues', inspectedSha: base, selection: { complete: true, query, issues } });
  l = root(l, 'groups', { groups: issues.map((issue, i) => ({ id: `g${i}`, issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix function', dependencyEvidence: 'Separate functions' })) });
  for (let i = 0; i < 2; i++) l = root(l, 'stack', { value: { id: `s${i}`, groups: [`g${i}`], phase: 'building', layers: [], baseSha: base, worktree: `/tmp/s${i}`, fetchedAt: at, revalidationEvidence: 'Fetched exact base and inspected separate functions' } });
  return root(l, 'delegation-enable', { capacity, evidence: { operationsClear: true, ownersReconciled: true, summary: 'No active workers/catalog/network operations' } });
}
function assign(l, i = 0, role = 'stack-execution', extra = {}) {
  const id = `${role}-${i}`, worker = `worker-${id}`, lane = { 'stack-execution': 'publication', maintenance: 'maintenance', inventory: 'inventory' }[role];
  const a = { id, taskId: id, stackId: `s${i}`, groupId: `g${i}`, role, lane, status: 'reserved', slots: 1, worker, worktree: `/tmp/s${i}`, startSha: base, ...extra };
  l = root(l, 'assignment', { value: a }); l = root(l, 'assignment', { value: { ...a, status: 'active' } });
  const g = { id: `grant-${a.id}`, role, assignmentId: a.id, worker: a.worker, stackIds: [`s${i}`], generation: Object.values(l.delegation.grants).filter(g => g.role === role && g.stackIds.includes(`s${i}`)).reduce((n, g) => Math.max(n, g.generation), 0) + 1, allowedEvents: roleEvents[role], childAssignmentIds: [] };
  l = root(l, 'delegation-grant', { value: g }); return { l, g, a: l.assignments[id] };
}
function envelope(l, g, events, overrides = {}) { return { version: 1, grantId: g.id, worker: g.worker, generation: g.generation, sequence: l.delegation.grants[g.id].sequence + 1, at, events, ...overrides }; }
function send(l, g, events) { return submitEvents(l, envelope(l, g, events)); }
function layer(i = 0, workerSha = base, headSha = head) { return { groupId: `g${i}`, branch: `kdy1/fix${i}`, requirementsSatisfied: true, headSha, workerSha, checks: [{ command: 'node --test', status: 'passed', sha: workerSha }], integrationChanged: false, realWorldValidation: 'not-performed' }; }
function prefix(i = 0, headSha = head, baseSha = base) {
  const p = { groupId: `g${i}`, url: `https://github.com/o/r/pull/${i + 3}`, headRepository: 'github.com/o/r', headBranch: `kdy1/fix${i}`, headSha, baseBranch: 'main', baseSha, title: 'fix: correct function', body: `Fix function\n\nCloses ${issues[i].url}`, closes: [issues[i].url] };
  return { version: 1, expected: { stackId: `s${i}`, baseBranch: 'main', layers: [p] }, observed: { stackId: `s${i}`, complete: true, attachmentComplete: true, layers: [{ ...p, state: 'OPEN', isDraft: false }], attachments: [p.url] } };
}
function makeReady(l, i = 0) {
  l = root(l, 'layer', { stackId: `s${i}`, value: layer(i) });
  l = root(l, 'publication', { stackId: `s${i}`, verification: prefix(i) });
  l = root(l, 'coordination', { stackId: `s${i}`, value: { phase: 'ready', evidence: 'Registry verified ready' } });
  return root(l, 'ready', { stackId: `s${i}`, detachedSha: head, evidence: 'Clean detached checkout at verified head' });
}
function pendingAutoMerge() {
  const actor = assign(makeReady(fixture()), 0, 'maintenance');
  const op = { id: 'auto-merge', kind: 'auto-merge', owner: actor.a.id, headSha: head, status: 'uncertain', token: 'retained-token' };
  let l = send(actor.l, actor.g, [
    { type: 'coordination', stackId: 's0', value: { phase: 'ready', owner: op.owner, token: op.token, evidence: 'Edit token acquired' } },
    { type: 'operation', stackId: 's0', value: op },
  ]);
  l = send(l, actor.g, [
    { type: 'operation', stackId: 's0', value: { ...op, status: 'verified', outcome: 'auto_merge_pending' }, reconciled: true, evidence: 'Authenticated autoMergeRequest at exact head' },
    { type: 'stack-observation', stackId: 's0', value: { evidence: 'Verified external wait, no active Git/catalog operation', outstandingEffects: true, alignmentPending: false, ownershipActive: true, headSha: head, autoMergePending: true } },
  ]);
  return { ...actor, l, op };
}
async function scratch(fn) { const dir = mkdtempSync(join(tmpdir(), 'batch-delegation-')); try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test('legacy ledgers stay coordinator-only; activation requires safe boundary and capacity', () => {
  let l = fixture(); delete l.delegation;
  assert.throws(() => submitEvents(l, { version: 1 }), /Legacy/);
  const a = { id: 'a', taskId: 'a', lane: 'implementation', status: 'reserved', slots: 1 };
  l = root(l, 'assignment', { value: a });
  assert.throws(() => root(l, 'delegation-enable', { capacity: 2, evidence: { operationsClear: true, ownersReconciled: true, summary: 'claimed' } }), /idle/);
  l = root(l, 'assignment', { value: { ...a, status: 'finished', slots: 0, outcome: 'cancelled', evidence: 'Never started' } });
  assert.throws(() => root(l, 'delegation-enable', { capacity: 2, evidence: { summary: 'No proof' } }), /proof/);
  l = root(l, 'delegation-enable', { capacity: 2, evidence: { operationsClear: true, ownersReconciled: true, summary: 'Known idle' } });
  assert.equal(l.delegation.capacity, 2);
});

test('independent submissions use per-grant sequence and preserve intervening root events', () => {
  let { l, g } = assign(fixture()); const other = assign(l, 1); l = other.l;
  const e = envelope(l, g, [{ type: 'layer', stackId: 's0', value: layer() }]);
  l = send(l, other.g, [{ type: 'layer', stackId: 's1', value: layer(1) }]);
  l = root(l, 'assessment', { issueKey: issues[0].key, value: { classification: 'actionable', evidence: 'Independent function inspected' } });
  l = submitEvents(l, e); assert.equal(l.stacks.s0.layers.length, 1); assert.equal(l.stacks.s1.layers.length, 1);
  assert.deepEqual(submitEvents(l, e), l);
  assert.throws(() => submitEvents(l, { ...e, events: [{ type: 'hold', stackId: 's0', evidence: 'Different' }] }), /Conflicting duplicate/);
  assert.throws(() => submitEvents(l, envelope(l, g, e.events, { sequence: 5 })), /sequence/);
});

test('wrong actor/generation, cross-stack, membership, scheduler and unallocated writes fail closed', () => {
  const { l, g } = assign(fixture());
  for (const [field, value] of [['worker', 'imposter'], ['generation', 2]]) assert.throws(() => submitEvents(l, envelope(l, g, [{ type: 'layer', stackId: 's0', value: layer() }], { [field]: value })), /identity/);
  for (const e of [{ type: 'layer', stackId: 's1', value: layer(1) }, { type: 'layer', stackId: 's0', value: layer(1) }, { type: 'groups', groups: [] }, { type: 'scheduler', value: {} }, { type: 'closure', issueKey: issues[0].key }, { type: 'assignment', value: { id: 'other' } }]) assert.throws(() => send(l, g, [e]));
  assert.throws(() => send(l, g, [{ type: 'checkpoint', value: { type: 'start', passId: 'global', prs: [], at: 1 } }]), /Checkpoint/);
});

test('one active executor per stack and actual slots including unknown/nested assignments', () => {
  const { l } = assign(fixture(2));
  assert.throws(() => assign(l, 0, 'stack-execution', { id: 'duplicate', taskId: 'duplicate', worker: 'duplicate' }), /another execution/);
  const other = assign(l, 1); assert.equal(Object.values(other.l.assignments).reduce((n, a) => n + a.slots, 0), 2);
  assert.throws(() => root(other.l, 'assignment', { value: { id: 'child', taskId: 'child', lane: 'repair', status: 'reserved', slots: 1 } }), /capacity/);
});

test('atomic submit preserves slots after uncertain effects and rejects stopped actors', () => {
  let { l, g, a } = assign(fixture());
  const op = { id: 'push', kind: 'push', headSha: base, owner: 'stack-owner', status: 'uncertain' };
  l = send(l, g, [{ type: 'operation', stackId: 's0', value: op }]);
  const finished = { ...a, status: 'finished', slots: 0, evidence: 'Done', outcome: 'succeeded' };
  assert.throws(() => send(l, g, [{ type: 'assignment', value: finished }]), /retain actor slot/);
  assert.throws(() => send(l, g, [{ type: 'layer', stackId: 's0', value: layer() }]), /Uncertain operation/);
  assert.throws(() => root(l, 'delegation-revoke', { grantId: g.id, ownerStopped: true, operationsClear: true, remoteReconciled: true, evidence: 'claimed' }), /Reconcile/);
  l = send(l, g, [{ type: 'operation', stackId: 's0', value: { ...op, status: 'rejected' }, reconciled: true, evidence: 'Exact remote ref confirms no push; owner stopped' }, { type: 'assignment', value: finished }]);
  assert.equal(l.delegation.grants[g.id].status, 'finished');
  assert.throws(() => send(l, g, [{ type: 'layer', stackId: 's0', value: layer() }]), /stopped/);
});

test('delegated ready is atomic with own job completion and cannot skip validation/publication', () => {
  let { l, g, a } = assign(fixture());
  assert.throws(() => send(l, g, [{ type: 'coordination', stackId: 's0', value: { phase: 'ready', evidence: 'claim' } }, { type: 'ready', stackId: 's0', detachedSha: head, evidence: 'claim' }]), /Incomplete ready/);
  l = send(l, g, [{ type: 'layer', stackId: 's0', value: layer() }, { type: 'publication', stackId: 's0', verification: prefix() }]);
  l = send(l, g, [{ type: 'coordination', stackId: 's0', value: { phase: 'ready', evidence: 'Actual registry ready' } }, { type: 'ready', stackId: 's0', detachedSha: head, evidence: 'Clean detached checkout' }, { type: 'assignment', value: { ...a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Prefix and ready verified' } }]);
  assert.equal(l.stacks.s0.phase, 'ready'); assert.equal(l.assignments[a.id].slots, 0);
});

test('maintenance scope requires ready stack; single captured inventory preserves late checkpoints', () => {
  assert.throws(() => assign(fixture(), 0, 'maintenance'), /ready/);
  let l = makeReady(fixture()); const actor = assign(l, 0, 'maintenance'); l = actor.l;
  assert.throws(() => send(l, actor.g, [{ type: 'layer', stackId: 's0', value: layer() }]), /permissions/);
  const inv = assign(l, 0, 'inventory'); l = inv.l;
  const url = l.stacks.s0.layers[0].url;
  l = send(l, inv.g, [{ type: 'checkpoint', value: { type: 'start', passId: 'pass', at: 1, prs: [url] } }]);
  l = send(l, actor.g, [{ type: 'checkpoint', value: { type: 'enqueue', id: 'late', stackId: 's0', reason: 'repair-result', at: 2 } }]);
  assert.throws(() => send(l, actor.g, [{ type: 'checkpoint', value: { type: 'finish', passId: 'pass', at: 3, inventory: { complete: true, prs: [] } } }]), /Checkpoint/);
  l = send(l, inv.g, [{ type: 'checkpoint', value: { type: 'finish', passId: 'pass', at: 3, full: true, nextFullAt: 20, refresh: { s0: 20 }, inventory: { complete: true, prs: [{ url, readComplete: true, state: 'OPEN', headSha: head, baseSha: base, readAt: 2 }] } } }]);
  assert.equal(l.checkpoints.pending.at(-1).id, 'late'); assert.equal(l.checkpoints.refresh.s0, 0);
  assert.equal(checkpointPlan(l, 4).stop, false);
});

test('verified auto-merge waits return the actor slot without releasing stack ownership', () => {
  const { l, g, a, op } = pendingAutoMerge();
  const finished = send(l, g, [{ type: 'assignment', value: { ...a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'External request confirmed; coordinator owns next reconciliation' } }]);
  assert.equal(finished.assignments[a.id].slots, 0);
  assert.equal(finished.delegation.grants[g.id].status, 'finished');
  assert.equal(finished.stacks.s0.ownershipActive, true);
  assert.equal(finished.stacks.s0.outstandingEffects, true);
  assert.equal(finished.stacks.s0.coordination.token, op.token);
  assert.equal(finished.stacks.s0.operations[op.id].outcome, 'auto_merge_pending');
  const standalone = structuredClone(l);
  Object.assign(standalone.stacks.s0.operations[op.id], { kind: 'standalone-auto-merge', outcome: undefined, result: 'auto_merge_pending', token: undefined });
  Object.assign(standalone.stacks.s0.maintenance, { headSha: undefined, autoMergePending: false, autoMergeRequest: { enabledAt: at }, prs: [{ url: l.stacks.s0.layers[0].url, headSha: head }], outstandingEffects: false });
  assert.equal(send(standalone, g, [{ type: 'assignment', value: { ...a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Verified standalone external wait' } }]).assignments[a.id].slots, 0);
  assert.throws(() => assign(finished, 0, 'maintenance', { id: 'next' }), /Reconcile prior stack/);
  const ownershipResume = { owner: op.owner, token: op.token, operationId: op.id };
  for (const key of ['owner', 'token', 'operationId']) {
    assert.throws(() => assign(finished, 0, 'maintenance', { id: 'next', ownershipResume: { ...ownershipResume, [key]: 'wrong' } }), /Reconcile prior stack/);
  }
  const resumed = assign(finished, 0, 'maintenance', { id: 'next', ownershipResume });
  assert.equal(resumed.l.assignments.next.status, 'active');
  assert.equal(resumed.l.stacks.s0.coordination.token, op.token);
});

test('auto-merge wait completion fails closed for stale proof, ownership changes and unknown effects', () => {
  const { l, g, a } = pendingAutoMerge();
  const completion = { type: 'assignment', value: { ...a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Return' } };
  const changes = [
    s => { s.maintenance.headSha = base; },
    s => { s.maintenance.autoMergePending = false; },
    s => { s.coordination.owner = 'another-owner'; },
    s => { s.coordination.token = 'another-token'; },
    s => { s.operations['auto-merge'].outcome = 'unverified'; },
    s => { s.alignmentPending = true; },
    s => { s.publicationAttempt = { reconciled: false }; },
  ];
  for (const change of changes) {
    const changed = structuredClone(l); change(changed.stacks.s0);
    assert.throws(() => send(changed, g, [completion]), /Unreconciled effects/);
  }
  const unknown = send(l, g, [{ type: 'operation', stackId: 's0', value: { id: 'cancel', kind: 'disable-auto', owner: a.id, headSha: head, status: 'uncertain' } }]);
  assert.throws(() => send(unknown, g, [completion]), /Unreconciled effects/);
  const child = { id: 'waiting-child', taskId: 'waiting-child', parentAssignmentId: a.id, stackId: 's0', lane: 'repair', status: 'reserved', slots: 1 };
  let withChild = root(l, 'assignment', { value: child });
  withChild = root(withChild, 'delegation-children', { grantId: g.id, childAssignmentIds: [child.id] });
  assert.throws(() => send(withChild, g, [completion]), /children/);
});

test('inventory slots are independent of observed stacks ownership and unresolved effects', () => {
  const maint = pendingAutoMerge();
  let l = send(maint.l, maint.g, [{ type: 'operation', stackId: 's0', value: { id: 'cancel', kind: 'disable-auto', owner: maint.a.id, headSha: head, status: 'uncertain' } }]);
  const inv = assign(l, 0, 'inventory'); l = inv.l;
  const url = l.stacks.s0.layers[0].url;
  const completion = { type: 'assignment', value: { ...inv.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Captured reads finished; maintenance owns stack effects' } };
  l = send(l, inv.g, [{ type: 'checkpoint', value: { type: 'start', passId: 'owned-pass', at: 1, prs: [url] } }]);
  assert.throws(() => send(l, inv.g, [completion]), /Finish inventory pass/);
  l = send(l, inv.g, [
    { type: 'checkpoint', value: { type: 'finish', passId: 'owned-pass', at: 3, inventory: { complete: true, prs: [{ url, readComplete: true, state: 'OPEN', headSha: head, baseSha: base, readAt: 2 }] } } },
    completion,
  ]);
  assert.equal(l.assignments[inv.a.id].slots, 0);
  assert.equal(l.assignments[maint.a.id].slots, 1);
  assert.equal(l.stacks.s0.operations.cancel.status, 'uncertain');
  assert.equal(l.stacks.s0.coordination.token, maint.op.token);
});

test('maintenance repair children require coordinator reservations and both slots remain accounted', () => {
  let l = makeReady(fixture(2));
  const id = 'maintenance-0', child = { id: 'child', taskId: 'child', parentAssignmentId: id, stackId: 's0', lane: 'repair', status: 'reserved', slots: 1, worktree: '/tmp/repair', startSha: head };
  l = root(l, 'assignment', { value: child });
  const actor = assign(l, 0, 'maintenance'); l = actor.l;
  // Root can grant a reserved child only, never capacity minted by a manager.
  l = root(l, 'delegation-children', { grantId: actor.g.id, childAssignmentIds: ['child'] });
  l = send(l, actor.g, [{ type: 'assignment', value: { ...child, status: 'active', worker: 'repair-agent' } }]);
  assert.equal(l.assignments.child.worker, 'repair-agent');
  assert.throws(() => send(l, actor.g, [{ type: 'assignment', value: { ...l.assignments.child, slots: 2 } }]), /slots/);
  assert.throws(() => send(l, actor.g, [{ type: 'assignment', value: { ...actor.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Return' } }]), /children/);
});

test('scheduler charges maintenance and inventory, excludes same-stack races, permits other construction', () => {
  const task = (id, lane, stack = id, extra = {}) => ({ id, stack, lane, status: 'pending', eligible: true, requires: [], estimate: 'short', ...extra });
  let p = plan({ version: 1, capacity: 1, tasks: [task('maintenance', 'maintenance', 's0'), task('repair', 'repair', 's0'), task('pub', 'publication', 's1')] });
  assert.deepEqual(p.allocations.map(a => a.id), ['maintenance']);
  p = plan({ version: 1, capacity: 3, tasks: [task('maintenance', 'maintenance', 's0', { status: 'active', eligible: false, slots: 1 }), task('repair', 'repair', 's0'), task('pub', 'publication', 's1'), task('inventory', 'inventory', 'batch')] });
  assert.deepEqual(p.allocations.map(a => a.id), ['pub', 'inventory']);
  assert.throws(() => plan({ version: 1, capacity: 1, tasks: [task('manager', 'maintenance', 's0', { status: 'active', eligible: false, slots: 1 }), task('child', 'repair', 's0', { status: 'reserved', eligible: false, slots: 1 })] }), /exceed/);
});

test('START renderer binds execution worker, generation, commits and exact checkout', () => {
  const extra = { branch: 'kdy1/fix0', coordinationId: 'batch/s0', stackOwner: 'build/s0', commits: [head] };
  const { l, g, a } = assign(fixture(), 0, 'stack-execution', extra);
  const assignment = { ...a, assignmentId: a.id, grantId: g.id, generation: 1, scope: 'One checked group', repositoryInstructions: 'AGENTS.md', concurrency: 'One slot', estimateEvidence: 'Worker timing', requestHelper: '/installed/github-request.mjs', requestState: '/batch/github.json', schedulerHelper: '/installed/scheduler.mjs', timingState: '/batch/timing.json', ledgerPath: '/batch/ledger.json', checkout: a.worktree, inspectedSha: base, issueKeys: [issues[0].key], acceptance: 'Fix function', dependencyEvidence: 'Independent function', integrationWorktree: a.worktree, coordinationHelper: '/installed/coordination.mjs', coordinationRoot: '/repo/.git', stackHelper: '/installed/batch-stack.mjs', createPrSkill: '/installed/create-pr/SKILL.md', workerStartSha: base, requirementsSatisfied: true, checks: [{ command: 'node --test', status: 'passed', sha: head }], integrationCheckCommands: [] };
  const input = { version: 1, mode: 'execution', role: 'stack-execution', phase: 'start', ledger: l, assignment };
  assert.match(renderHandoff(input), /prefix submission/);
  for (const change of [{ worker: 'other' }, { generation: 2 }, { checkout: '/other' }, { commits: [base] }]) assert.throws(() => renderHandoff({ ...input, assignment: { ...assignment, ...change } }));
  assert.throws(() => renderHandoff({ ...input, mode: 'plan' }), /read-only/);
});

test('simulated multi-stack construction and merge records need no root event after START', () => {
  const first = assign(fixture()); const second = assign(first.l, 1); let l = second.l;
  const rootEvents = l.events.filter(e => !e.delegated).length;
  for (const actor of [second, first]) {
    const i = actor === first ? 0 : 1;
    l = send(l, actor.g, [{ type: 'layer', stackId: `s${i}`, value: layer(i) }, { type: 'publication', stackId: `s${i}`, verification: prefix(i) }, { type: 'coordination', stackId: `s${i}`, value: { phase: 'ready', evidence: 'Simulated registry result' } }, { type: 'ready', stackId: `s${i}`, detachedSha: head, evidence: 'Simulated clean detach' }, { type: 'assignment', value: { ...actor.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Simulated prefix verified' } }]);
  }
  assert.equal(l.events.filter(e => !e.delegated).length, rootEvents);
  const maint = assign(l, 0, 'maintenance'); l = maint.l;
  const rootMergeEvents = l.events.filter(e => !e.delegated).length;
  const merge = { id: 'merge', kind: 'merge', owner: maint.g.worker, status: 'uncertain', headSha: head };
  l = send(l, maint.g, [{ type: 'operation', stackId: 's0', value: merge }]);
  l = send(l, maint.g, [{ type: 'operation', stackId: 's0', value: { ...merge, status: 'verified' }, reconciled: true, evidence: 'Simulated fresh gates, remote state/merge SHA verified' }, { type: 'stack-observation', stackId: 's0', value: { evidence: 'Mock remote observation; not live GitHub', outstandingEffects: false, alignmentPending: false, ownershipActive: false, prs: [{ url: prefix().expected.layers[0].url, state: 'MERGED', mergeCommitSha: head }] } }, { type: 'assignment', value: { ...maint.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Mock merge verified' } }]);
  assert.equal(l.events.filter(e => !e.delegated).length, rootMergeEvents);
  // The legacy writer must apply these same 5 construction + 4 maintenance events itself.
  assert.equal(l.events.filter(e => e.delegated?.grantId === first.g.id).length, 5);
  assert.equal(l.events.filter(e => e.delegated?.grantId === maint.g.id).length, 4);
});

test('parallel CLI submit serializes short local writes; busy does not lose or repeat effects', () => scratch(async dir => {
  const one = assign(fixture()), two = assign(one.l, 1), path = join(dir, 'ledger.json'); save(path, two.l);
  const entries = [one, two].map((actor, i) => { const file = join(dir, `${i}.json`); const input = envelope(two.l, actor.g, [{ type: 'layer', stackId: `s${i}`, value: layer(i) }]); save(file, input); return { file, input }; });
  const cliPath = fileURLToPath(new URL('./batch-ledger.mjs', import.meta.url));
  const results = await Promise.all(entries.map(({ file }) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cliPath, 'submit', path, file]); let out = ''; p.stdout.on('data', b => out += b); p.on('error', reject); p.on('close', code => resolve({ code, out: JSON.parse(out) }));
  })));
  for (let i = 0; i < results.length; i++) { if (results[i].out.status === 'busy') assert.notEqual(submitLedger(path, entries[i].input).complete, false); else assert.equal(results[i].code, 0); }
  const l = readJson(path); assert.equal(l.stacks.s0.layers.length, 1); assert.equal(l.stacks.s1.layers.length, 1);
  mkdirSync(`${path}.lock`); const r = submitLedger(path, entries[0].input); assert.equal(r.status, 'busy'); assert.equal(r.complete, false);
}));
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

for (const runtime of ['codex', 'claude-code']) test(`real local worktree, registration, integration and ready steps preserve stack/catalog guards (${runtime})`, () => scratch(dir => {
  const repo = join(dir, 'repo'); mkdirSync(repo); runCommand('git', ['init', '-b', 'main'], repo);
  runCommand('git', ['config', 'user.email', 'test@example.invalid'], repo); runCommand('git', ['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'source.txt'), 'before\n'); runCommand('git', ['add', 'source.txt'], repo); runCommand('git', ['commit', '-m', 'base'], repo);
  const baseSha = runCommand('git', ['rev-parse', 'HEAD'], repo), commonRoot = runCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
  const worker = join(dir, 'worker'), integration = join(dir, 'integration');
  for (const path of [worker, integration]) prepareWorktree({ version: 1, mode: 'execution', checkout: repo, path, startSha: baseSha, commonRoot, owner: 'root', authorization: 'Local test only' });
  writeFileSync(join(worker, 'source.txt'), 'after\n'); runCommand('git', ['add', 'source.txt'], worker); runCommand('git', ['commit', '-m', 'fix'], worker);
  const workerSha = runCommand('git', ['rev-parse', 'HEAD'], worker);
  let l = fixture(2); l.context.runtime = runtime; l.stacks.s0.baseSha = baseSha; l.stacks.s0.worktree = integration;
  const coord = fileURLToPath(new URL('../../repair-pr/scripts/stack-coordination.mjs', import.meta.url));
  const ledgerPath = join(dir, 'ledger.json');
  const actor = assign(l, 0, 'stack-execution', { worktree: integration, startSha: baseSha, branch: 'kdy1/fix0', baseRef: 'main', remote: 'origin', coordinationId: 'batch/s0', stackOwner: 'build/s0', coordinationRoot: commonRoot, coordinationHelper: coord, requestState: join(dir, 'requests.json'), workerStartSha: baseSha, commits: [workerSha], requirementsSatisfied: true, checks: [{ command: 'fixture check', status: 'passed', sha: workerSha }] }); l = actor.l; save(ledgerPath, l);
  const input = { version: 1, ledgerPath, grantId: actor.g.id, worker: actor.g.worker, generation: 1 };
  const run = (file, args, cwd) => {
    if (file === 'gh') {
      if (args[1] === 'init') return runCommand('git', ['switch', '-c', actor.a.branch], cwd);
      if (args[1] === 'view') return JSON.stringify({ simulated: true });
      if (args[1] === 'submit') return 'simulated submit';
      throw new Error('Unexpected mock command');
    }
    return runCommand(file, args, cwd);
  };
  assert.equal(runStep({ ...input, operationId: 'register', kind: 'register', expectedHead: baseSha }, { run }).complete, true);
  // Another stack's catalog is never released by this executor; proven contention is a no-op.
  const foreignFile = join(dir, 'foreign.json');
  save(foreignFile, { id: 'foreign', batch: 'other-batch', repository: 'github.com/o/r', ledger: join(dir, 'other-ledger.json'), layers: [{ branch: 'kdy1/foreign', headRepository: 'github.com/o/r', pr: null }] });
  const foreign = JSON.parse(runCommand(process.execPath, [coord, 'register', '--file', foreignFile, '--owner', 'foreign-owner'], integration));
  const foreignCatalog = JSON.parse(runCommand(process.execPath, [coord, 'catalog-acquire', '--stack', 'foreign', '--owner', 'foreign-owner', '--token', foreign.lock.token], integration));
  const contended = runStep({ ...input, operationId: 'contended-init', kind: 'init', expectedHead: baseSha }, { run });
  assert.equal(contended.status, 'busy');
  assert.equal(readJson(ledgerPath).stacks.s0.operations['contended-init'].status, 'rejected');
  assert.equal(JSON.parse(runCommand(process.execPath, [coord, 'status'], integration)).catalog.token, foreignCatalog.token);
  runCommand(process.execPath, [coord, 'catalog-release', '--owner', 'foreign-owner', '--token', foreignCatalog.token], integration);
  const initialized = runStep({ ...input, operationId: 'init', kind: 'init', expectedHead: baseSha }, { run }); assert.equal(initialized.status, 'needs-verification');
  assert.throws(() => runStep({ ...input, operationId: 'init', kind: 'init', expectedHead: baseSha }, { run }), /already recorded/);
  reconcileStep({ ...input, operationId: 'init', catalogToken: initialized.catalogToken, gitOperationsClear: true, remoteReconciled: true, verified: true, evidence: 'Local mock init branch and catalog verified' }, { run });
  const integrated = runStep({ ...input, operationId: 'integrate', kind: 'integrate', expectedHead: baseSha }, { run }); assert.equal(integrated.complete, true);
  l = readJson(ledgerPath); l = send(l, actor.g, [{ type: 'layer', stackId: 's0', value: layer(0, workerSha, integrated.headSha) }]);
  const p = prefix(0, integrated.headSha, baseSha);
  if (runtime === 'claude-code') {
    p.runtime = runtime; p.observed.attachmentStatus = 'not-applicable'; p.observed.attachments = [];
    delete p.observed.attachmentComplete;
  }
  l = send(l, actor.g, [{ type: 'publication-attempt', stackId: 's0', value: { id: 'publication', preparedPrefix: p } }]); save(ledgerPath, l);
  const submitted = runStep({ ...input, operationId: 'submit', kind: 'submit', expectedHead: integrated.headSha }, { run }); assert.equal(submitted.status, 'needs-verification');
  reconcileStep({ ...input, operationId: 'submit', catalogToken: submitted.catalogToken, gitOperationsClear: true, remoteReconciled: true, verified: true, evidence: 'Mock prefix submission reconciled; no live GitHub' }, { run });
  l = readJson(ledgerPath); l = send(l, actor.g, [{ type: 'publication', stackId: 's0', verification: p }]); save(ledgerPath, l);
  assert.equal(runStep({ ...input, operationId: 'detach', kind: 'detach', expectedHead: integrated.headSha }, { run }).complete, true);
  // Update verified PR registration before ready; preserves construction token.
  assert.equal(runStep({ ...input, operationId: 'register-pr', kind: 'register', expectedHead: integrated.headSha }, { run }).complete, true);
  assert.equal(runStep({ ...input, operationId: 'ready', kind: 'ready', expectedHead: integrated.headSha }, { run }).complete, true);
  l = readJson(ledgerPath); l = send(l, actor.g, [{ type: 'coordination', stackId: 's0', value: { phase: 'ready', evidence: 'Actual local registry ready' } }, { type: 'ready', stackId: 's0', detachedSha: integrated.headSha, evidence: 'Actual clean detached checkout' }, { type: 'assignment', value: { ...actor.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Local fixture ready; GitHub simulated' } }]);
  assert.equal(l.stacks.s0.phase, 'ready'); assert.equal(readFileSync(join(integration, 'source.txt'), 'utf8'), 'after\n');
}));

test('unresolved operations prevent terminal batch completion even without an active worker', () => {
  let l = makeReady(makeReady(fixture(), 1));
  l = root(l, 'operation', { stackId: 's0', value: { id: 'unknown-merge', kind: 'merge', owner: 'legacy-owner', headSha: head, status: 'uncertain' } });
  l.implementationEnded = true; l.checkpoints.pending = []; l.checkpoints.inventory = { complete: true, prs: ['s0', 's1'].map(id => ({ url: l.stacks[id].layers[0].url, state: 'MERGED', readComplete: true, headSha: head, baseSha: base, readAt: 1 })) };
  assert.equal(checkpointPlan(l, 2).stop, false);
});

test('submit CLI returns bounded receipts and --full, duplicates, busy and uncertain effects keep their contracts', () => scratch(dir => {
  const { l, g } = assign(fixture()); const path = join(dir, 'ledger.json'), file = join(dir, 'submission.json'); save(path, l);
  const submission = envelope(l, g, [{ type: 'operation', stackId: 's0', value: { id: 'pending', kind: 'submit', owner: g.worker, headSha: base, status: 'uncertain' } }]);
  save(file, submission);
  const invoke = (...flags) => spawnSync(process.execPath, [fileURLToPath(new URL('./batch-ledger.mjs', import.meta.url)), 'submit', path, file, ...flags], { encoding: 'utf8' });
  let result = invoke(); assert.equal(result.status, 0, result.stderr); const summary = JSON.parse(result.stdout);
  assert.equal(summary.complete, true); assert.deepEqual(summary.changed.stackIds, ['s0']);
  assert.deepEqual(summary.appliedEventIds, [`delegate:${g.id}:1:1:0`]); assert.equal(summary.events, undefined);
  const stored = JSON.parse(readFileSync(path)); assert.equal(stored.stacks.s0.operations.pending.status, 'uncertain');
  result = invoke(); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).revision, stored.revision);
  assert.deepEqual(JSON.parse(result.stdout).changed.stackIds, []); assert.deepEqual(JSON.parse(readFileSync(path)), stored);
  result = invoke('--full'); assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), stored);
  save(file, { ...submission, events: [{ type: 'operation', stackId: 's0', value: { ...submission.events[0].value, kind: 'conflicting' } }] });
  result = invoke(); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.deepEqual(JSON.parse(readFileSync(path)), stored);
  save(file, submission); mkdirSync(`${path}.lock`);
  result = invoke(); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).status, 'busy'); assert.equal(JSON.parse(result.stdout).complete, false);
}));
