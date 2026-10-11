import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rankTasks, plan, publicationCeiling, recordEvent, writeEvent } from './batch-scheduler.mjs';

const task = (id, lane = 'implementation', extra = {}) => ({ id, stack: id, lane, status: 'pending', eligible: true, requires: [], estimate: 'short', ...extra });
const snapshot = (tasks, extra = {}) => ({ version: 1, capacity: 4, tasks, ...extra });
const initial = () => ({ version: 1, events: [], attempts: {} });
const event = (id, type, second, extra = {}) => ({ id, attempt: 'attempt-a', type, at: `2026-10-11T00:00:${String(second).padStart(2, '0')}Z`, ...extra });

test('remaining path includes CI/review and merge rather than own implementation alone', () => {
  const ranked = rankTasks([
    task('a'), task('a-ci', 'external', { eligible: false, requires: ['a'], estimate: 'long' }),
    task('a-merge', 'merge', { eligible: false, requires: ['a-ci'] }), task('b', 'implementation', { estimate: 'medium' }),
  ]);
  assert.equal(ranked[0].id, 'a');
  assert.deepEqual(ranked[0].path, ['a', 'a-ci', 'a-merge']);
  assert.equal(ranked[0].remainingMs, 11 * 60000);
});

test('parallel tails join once; completed work has zero cost', () => {
  const ranked = rankTasks([
    task('root'), task('left', 'external', { eligible: false, requires: ['root'], estimate: 'long' }),
    task('right', 'external', { eligible: false, requires: ['root'], estimate: 'medium' }),
    task('merge', 'merge', { eligible: false, requires: ['left', 'right'] }),
    task('finished', 'implementation', { status: 'done', eligible: false, estimate: 'long' }),
  ]);
  const root = ranked.find(t => t.id === 'root');
  assert.equal(root.remainingMs, 11 * 60000);
  assert.equal(root.downstream.length, 3);
  assert.equal(ranked.find(t => t.id === 'finished').remainingMs, 0);
});

test('malformed/cyclic graphs fail and unknown costs remain uncertain', () => {
  assert.throws(() => rankTasks([task('a', 'implementation', { requires: ['missing'] })]), /Unknown dependency/);
  assert.throws(() => rankTasks([task('a', 'implementation', { requires: ['b'] }), task('b', 'implementation', { requires: ['a'] })]), /cycle/);
  assert.throws(() => rankTasks([task('a'), task('a')]), /duplicate/);
  assert.equal(rankTasks([task('unknown', 'implementation', { estimate: undefined })])[0].uncertainEstimate, true);
});

test('human priority outranks latency; gates and external waits never create worker assignments', () => {
  const result = plan(snapshot([
    task('high', 'implementation', { priority: 1 }), task('slow', 'implementation', { estimate: 'long' }),
    task('blocked', 'implementation', { eligible: false, status: 'blocked' }),
    task('pending-ci', 'external', { eligible: false, status: 'waiting', estimate: 'long' }),
    task('dependent', 'implementation', { requires: ['pending-ci'] }),
  ], { capacity: 1 }));
  assert.deepEqual(result.allocations.map(t => t.id), ['high']);
  assert.equal(result.schedulingOnly, true);
});

test('repairs precede publications; uncertain/nested slots and same-stack exclusion are retained', () => {
  const result = plan(snapshot([
    task('running', 'implementation', { status: 'uncertain', eligible: false, slots: 2 }),
    task('repair', 'repair'), task('pub', 'publication'), task('impl'),
  ], { capacity: 4 }));
  assert.deepEqual(result.allocations.map(t => t.id), ['repair', 'pub']);
  assert.equal(result.accounting.used, 2);
  assert.throws(() => plan(snapshot([task('bad', 'repair', { status: 'reserved', eligible: false })])), /slots/);
  const sameStack = plan(snapshot([
    task('running-pub', 'publication', { stack: 's', status: 'uncertain', eligible: false, slots: 1 }),
    task('queued-pub', 'publication', { stack: 's' }), task('queued-repair', 'repair', { stack: 's' }), task('other'),
  ]));
  assert.deepEqual(sameStack.allocations.map(t => t.id), ['other']);
});

test('one publication per stack and whole-stack completion priority', () => {
  const result = plan(snapshot([
    task('pub-a', 'publication', { stack: 's', estimate: 'long' }),
    task('pub-b', 'publication', { stack: 's', finishesStack: true }), task('pub-c', 'publication'),
  ], { publicationPolicy: { explicitLimit: 1 } }));
  assert.deepEqual(result.allocations.map(t => t.id), ['pub-b']);
});

test('two consecutive repair displacements earn exactly one construction slot', () => {
  let result = plan(snapshot([task('pub', 'publication'), task('r1', 'repair')], { capacity: 1, boundary: 1 }));
  assert.equal(result.displaced.pub.count, 1);
  result = plan(snapshot([task('pub', 'publication'), task('r2', 'repair')], { capacity: 1, boundary: 2, displaced: result.displaced }));
  assert.equal(result.displaced.pub.count, 2);
  result = plan(snapshot([task('pub', 'publication'), task('r3', 'repair')], { capacity: 1, boundary: 3, displaced: result.displaced }));
  assert.deepEqual(result.allocations.map(t => t.id), ['pub']);
  assert.equal(result.progressException, 'pub');
  assert.deepEqual(result.displaced, {});
});

test('adaptive limit can exceed four; explicit limits and API cooldown remain binding', () => {
  assert.equal(publicationCeiling({ previousCeiling: 4, healthy: true, completedSinceAdjustment: 3 }, 8, 8).ceiling, 5);
  assert.equal(publicationCeiling({ previousCeiling: 4, healthy: false, completedSinceAdjustment: 3 }, 8, 8).ceiling, 4);
  assert.equal(publicationCeiling({ previousCeiling: 6, pressure: true }, 8, 8).ceiling, 3);
  assert.equal(publicationCeiling({ explicitLimit: 7, pressure: true }, 8, 8).ceiling, 7);
  const result = plan(snapshot([task('pub', 'publication'), task('impl')], { publicationPolicy: { explicitLimit: 7, cooldown: true } }));
  assert.deepEqual(result.allocations.map(t => t.id), ['impl']);
});

test('growth sees active plus queued independent publications and never adds slots', () => {
  const tasks = [task('active-pub', 'publication', { status: 'active', eligible: false, slots: 1 }),
    ...Array.from({ length: 4 }, (_, i) => task(`pub-${i}`, 'publication'))];
  const result = plan(snapshot(tasks, { capacity: 6, publicationPolicy: { previousCeiling: 4, healthy: true, completedSinceAdjustment: 3 } }));
  assert.equal(result.publicationPolicy.ceiling, 5);
  assert.equal(result.allocations.length, 4);
  assert.ok(result.accounting.used + result.accounting.allocated <= 6);
});

test('timing events are idempotent, count waits, and reject terminal or backward transitions', () => {
  const start = event('e1', 'started', 0, { task: 'publish', lane: 'publication' });
  let state = recordEvent(initial(), start);
  assert.deepEqual(recordEvent(state, { ...start }), state);
  assert.throws(() => recordEvent(state, { ...start, task: 'another' }), /Conflicting/);
  state = recordEvent(state, event('e2', 'waiting', 2, { reason: 'catalog busy' }));
  state = recordEvent(state, event('e3', 'resumed', 7));
  state = recordEvent(state, event('e4', 'finished', 9, { outcome: 'succeeded' }));
  assert.equal(state.attempts['attempt-a'].waitMs, 5000);
  assert.equal(state.attempts['attempt-a'].elapsedMs, 9000);
  assert.throws(() => recordEvent(state, event('e5', 'resumed', 10)), /terminal/);
});

test('unknown effects need reconciliation evidence before release or completion', () => {
  let state = recordEvent(initial(), event('e1', 'started', 0, { task: 'merge', lane: 'merge' }));
  state = recordEvent(state, event('e2', 'uncertain', 3));
  assert.throws(() => recordEvent(state, event('e3', 'finished', 4, { outcome: 'failed' })), /reconciliation/);
  assert.throws(() => recordEvent(state, event('e3', 'finished', 2, { outcome: 'failed', reconciled: true, evidence: 'read' })), /backwards/);
  state = recordEvent(state, event('e3', 'finished', 4, { outcome: 'succeeded', reconciled: true, evidence: 'verified mergedAt and commit' }));
  assert.equal(state.attempts['attempt-a'].status, 'finished');
});

test('atomic timing writes persist and an existing lock is never stolen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-scheduler-'));
  try {
    const path = join(dir, 'timing.json');
    writeEvent(path, event('e1', 'started', 0, { task: 'impl', lane: 'implementation' }));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).events.length, 1);
    mkdirSync(`${path}.lock`);
    assert.throws(() => writeEvent(path, event('e2', 'finished', 1, { outcome: 'succeeded' })), /busy or interrupted/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).events.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects incomplete commands without creating timing files', () => {
  const result = spawnSync(process.execPath, [new URL('./batch-scheduler.mjs', import.meta.url).pathname, 'record'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
});
