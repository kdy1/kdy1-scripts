import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initialize, applyEvent, ledgerSummary, schedulingSnapshot, resumeSummary } from './batch-ledger.mjs';
import { renderHandoff } from './render-handoff.mjs';
import { workerSettings } from './worker-settings.mjs';
import { save } from './helper-common.mjs';
const sha = 'a'.repeat(40), query = 'repo:o/r is:issue is:open';
const issue = { key: 'github.com/o/r/1', url: 'https://github.com/o/r/issues/1', canonicalOrder: 0 };
const input = { version: 1, batchId: 'cost', coordinator: 'root', query, repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix selected issues', inspectedSha: sha, selection: { complete: true, query, issues: [issue] } };
const cli = (dir, ...args) => spawnSync(process.execPath, [new URL('./batch-ledger.mjs', import.meta.url).pathname, ...args], { cwd: dir, encoding: 'utf8' });
function scratch(fn) { const dir = mkdtempSync(join(tmpdir(), 'batch-cost-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function assessment(l, id = `e${l.revision}`) { return { id, expectedRevision: l.revision, at: '2026-10-12T00:00:00Z', type: 'assessment', issueKey: issue.key, value: { classification: 'actionable', evidence: 'Observed bug ' + l.revision } }; }
function handoff(dir, overrides = {}) {
  return { version: 1, role: 'investigation', phase: 'prepare', mode: 'plan', ledger: initialize(input), assignment: {
    scope: 'Investigate selected issue', repositoryInstructions: '/repo/AGENTS.md', concurrency: 'One slot', estimateEvidence: 'One isolated function',
    requestHelper: '/skill/github-request.mjs', requestState: join(dir, 'api.json'), schedulerHelper: '/skill/batch-scheduler.mjs', timingState: join(dir, 'timing.json'),
    ledgerPath: join(dir, 'ledger.json'), checkout: '/repo/worker', inspectedSha: sha, issueKeys: [issue.key], ...overrides } };
}
function evidence(dir, data, fields = Object.keys(data)) {
  const path = join(dir, 'evidence.json'), bytes = JSON.stringify(data); writeFileSync(path, bytes);
  return { path, fields, summary: 'Full investigation evidence', sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('ledger CLI summarizes writes and reads; --full preserves complete storage and recovery contracts', () => scratch(dir => {
  const path = join(dir, 'ledger.json'), source = join(dir, 'input.json'); save(source, input);
  let r = cli(dir, 'init', path, source); assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(summary), ['version', 'complete', 'ledgerPath', 'revision', 'appliedEventIds', 'changed']);
  assert.deepEqual(summary.changed.issueIds, [issue.key]); assert.equal(summary.revision, 0);
  const initial = JSON.parse(readFileSync(path));
  for (const command of ['status', 'validate']) {
    r = cli(dir, command, path); assert.deepEqual(JSON.parse(r.stdout), ledgerSummary(path, initial));
    r = cli(dir, command, path, '--full'); assert.deepEqual(JSON.parse(r.stdout), initial);
  }
  const e = assessment(initial); save(source, e);
  r = cli(dir, 'apply', path, source, 'root'); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).appliedEventIds, [e.id]); assert.deepEqual(JSON.parse(r.stdout).changed.issueIds, [issue.key]);
  const next = JSON.parse(readFileSync(path)); assert.deepEqual(next, applyEvent(initial, e, 'root'));
  r = cli(dir, 'apply', path, source, 'root'); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).revision, 1);
  assert.deepEqual(JSON.parse(r.stdout).changed, { issueIds: [], groupIds: [], stackIds: [], assignmentIds: [] });
  r = cli(dir, 'apply', path, source, 'root', '--full'); assert.deepEqual(JSON.parse(r.stdout), next);
  save(source, { ...e, value: { ...e.value, evidence: 'Conflicting retry' } });
  r = cli(dir, 'apply', path, source, 'root'); assert.equal(r.status, 1); assert.equal(r.stdout, '');
  save(source, { ...assessment(next, 'wrong-revision'), expectedRevision: 0 });
  r = cli(dir, 'apply', path, source, 'root'); assert.equal(r.status, 1); assert.match(r.stderr, /revision conflict/);
  assert.deepEqual(JSON.parse(readFileSync(path)), next);
  r = cli(dir, 'resume', path); assert.deepEqual(JSON.parse(r.stdout), resumeSummary(next));
  save(source, next);
  r = cli(dir, 'import', join(dir, 'import.json'), source); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).revision, 1);
  r = cli(dir, 'import', join(dir, 'import-full.json'), source, '--full'); assert.deepEqual(JSON.parse(r.stdout), next);
  r = cli(dir, 'init', join(dir, 'bad.json'), source, '--invalid'); assert.equal(r.status, 1);
  const scheduler = { version: 1, capacity: 1, tasks: [] };
  const withScheduler = applyEvent(next, { id: 'schedule', expectedRevision: next.revision, at: e.at, type: 'scheduler', value: scheduler }, 'root'); save(path, withScheduler);
  r = cli(dir, 'snapshot', path); assert.deepEqual(JSON.parse(r.stdout), schedulingSnapshot(withScheduler));
}));

test('summary byte size stays bounded as historical evidence grows', () => scratch(dir => {
  let l = initialize(input);
  l = applyEvent(l, assessment(l), 'root');
  const smallFull = Buffer.byteLength(JSON.stringify(l)), small = Buffer.byteLength(JSON.stringify(ledgerSummary(join(dir, 'ledger.json'), l)));
  for (let i = 0; i < 100; i++) l = applyEvent(l, { ...assessment(l), value: { classification: 'actionable', evidence: 'Evidence '.repeat(250) } }, 'root');
  const large = Buffer.byteLength(JSON.stringify(ledgerSummary(join(dir, 'ledger.json'), l)));
  assert.ok(large <= small + 2); assert.ok(Buffer.byteLength(JSON.stringify(l)) > smallFull * 100);
  save(join(dir, 'ledger.json'), l);
  const r = cli(dir, 'status', join(dir, 'ledger.json')); assert.equal(r.status, 0); assert.doesNotMatch(r.stdout, /Evidence|events|assessments/);
}));

test('handoff validates full referenced evidence without echoing it; preserves scope and settings', () => scratch(dir => {
  const findings = 'Verified function evidence. '.repeat(1000), ref = evidence(dir, { findings });
  const i = handoff(dir, { evidenceRefs: [ref], complexity: 'simple', complexityReason: 'Clear isolated function and known test' });
  const rendered = renderHandoff(i), rawBytes = Buffer.byteLength(JSON.stringify({ ...i.assignment, findings }, null, 2));
  assert.ok(rendered.includes(ref.path)); assert.ok(rendered.includes(ref.sha256)); assert.ok(rendered.includes(sha)); assert.ok(rendered.includes(issue.key));
  assert.ok(rendered.includes(i.assignment.scope)); assert.doesNotMatch(rendered, /Verified function evidence/);
  assert.deepEqual(JSON.parse(rendered.match(/```json\n([\s\S]*?)\n```/)[1]), workerSettings('investigation', 'codex', 'simple'));
  assert.ok(Buffer.byteLength(rendered) < rawBytes / 3);
  assert.throws(() => renderHandoff(handoff(dir, { findings })), /requires an evidence reference/);
  writeFileSync(ref.path, '{"findings":"Changed after preparation"}'); assert.throws(() => renderHandoff(i), /SHA-256 mismatch/);
  rmSync(ref.path); assert.throws(() => renderHandoff({ ...i, phase: 'start' }), /ENOENT/);
}));

test('evidence rejects missing fields, malformed data, placeholder facts, identity overrides and escaped paths', () => scratch(dir => {
  let ref = evidence(dir, { findings: 'Good findings' });
  for (const altered of [{ ...ref, fields: ['missing'] }, { ...ref, fields: ['checkout'] }, { ...ref, fields: ['findings', 'findings'] }, { ...ref, sha256: 'bad' }]) {
    assert.throws(() => renderHandoff(handoff(dir, { evidenceRefs: [altered] })));
  }
  assert.throws(() => renderHandoff(handoff(dir, { evidenceRefs: [ref], findings: 'Conflicting inline' })), /Conflicting inline/);
  ref = evidence(dir, { findings: '' }); assert.throws(() => renderHandoff(handoff(dir, { evidenceRefs: [ref] })), /Empty evidence/);
  ref = evidence(dir, { findings: 'TODO' }); assert.throws(() => renderHandoff(handoff(dir, { evidenceRefs: [ref] })), /placeholder/);
  writeFileSync(ref.path, '{malformed'); ref.sha256 = createHash('sha256').update(readFileSync(ref.path)).digest('hex');
  assert.throws(() => renderHandoff(handoff(dir, { evidenceRefs: [ref] })), SyntaxError);
  mkdirSync(join(dir, 'batch'));
  ref = evidence(dir, { findings: 'Outside the batch' });
  assert.throws(() => renderHandoff(handoff(join(dir, 'batch'), { evidenceRefs: [ref] })), /outside batch/);
  symlinkSync(ref.path, join(dir, 'batch', 'link.json'));
  assert.throws(() => renderHandoff(handoff(join(dir, 'batch'), { evidenceRefs: [{ ...ref, path: join(dir, 'batch', 'link.json') }] })), /outside batch/);
}));

test('START binds complexity to recorded creation settings in Codex and Claude, including legacy defaults', () => scratch(dir => {
  for (const runtime of ['codex', 'claude-code']) {
    const i = handoff(dir, { assignmentId: 'a', worker: 'agent', complexity: 'simple', complexityReason: 'One isolated function and test' });
    i.mode = 'execution'; i.phase = 'start'; i.ledger.context.runtime = runtime;
    const a = { id: 'a', taskId: 'investigate', lane: 'investigation', role: 'investigation', status: 'reserved', slots: 1, worker: 'agent', worktree: '/repo/worker', complexity: 'simple', complexityReason: i.assignment.complexityReason };
    i.ledger = applyEvent(i.ledger, { id: 'reserve', expectedRevision: 0, at: '2026-10-12T00:00:00Z', type: 'assignment', value: a }, 'root');
    assert.deepEqual(JSON.parse(renderHandoff(i).match(/```json\n([\s\S]*?)\n```/)[1]), workerSettings(i.role, runtime, 'simple'));
    assert.throws(() => renderHandoff({ ...i, assignment: { ...i.assignment, complexity: 'standard' } }), /complexity differs/);
    assert.throws(() => renderHandoff({ ...i, assignment: { ...i.assignment, complexityReason: 'Different reason' } }), /complexity differs/);
    assert.throws(() => applyEvent(i.ledger, { id: 'alter', expectedRevision: 1, at: '2026-10-12T00:00:00Z', type: 'assignment', value: { ...a, complexity: 'standard' } }, 'root'), /complexity changed/);
    assert.throws(() => renderHandoff({ ...i, assignment: { ...i.assignment, checkout: '/other' } }), /checkout differs/);
  }
  assert.deepEqual(JSON.parse(renderHandoff(handoff(dir)).match(/```json\n([\s\S]*?)\n```/)[1]), workerSettings('investigation'));
  assert.throws(() => renderHandoff(handoff(dir, { complexity: 'simple' })), /complexity reason/);
}));
