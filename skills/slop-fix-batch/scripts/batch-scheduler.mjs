#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const statuses = new Set(['pending', 'waiting', 'active', 'reserved', 'uncertain', 'done', 'blocked']);
const lanes = new Set(['merge', 'repair', 'publication', 'implementation', 'investigation', 'preparation', 'maintenance', 'inventory', 'external']);
const occupied = new Set(['active', 'reserved', 'uncertain']);
const costs = { short: 1, medium: 3, long: 9 };
function check(condition, message) { if (!condition) throw new Error(message); }
function integer(value, name, min = 0) {
  check(Number.isSafeInteger(value) && value >= min, `Invalid ${name}`);
  return value;
}

// This graph estimates latency. It never establishes review, CI or ownership gates.
export function rankTasks(tasks) {
  check(Array.isArray(tasks), 'tasks must be an array');
  const byId = new Map();
  for (const task of tasks) {
    check(typeof task.id === 'string' && task.id && !byId.has(task.id), 'Missing or duplicate task id');
    check(statuses.has(task.status) && lanes.has(task.lane), `Invalid task ${task.id}`);
    check(Array.isArray(task.requires), `Missing requires for ${task.id}`);
    check(typeof task.stack === 'string' && task.stack, `Missing stack for ${task.id}`);
    check(typeof task.eligible === 'boolean', `Missing eligibility for ${task.id}`);
    check(!(task.eligible && (task.status !== 'pending' || task.lane === 'external')), `Invalid eligibility for ${task.id}`);
    integer(task.slots ?? 0, 'slots');
    if (occupied.has(task.status) && !['merge', 'external'].includes(task.lane)) {
      integer(task.slots, 'occupied worker slots', 1);
    }
    if (task.remainingMs !== undefined) check(Number.isFinite(task.remainingMs) && task.remainingMs >= 0 && task.estimateEvidence, `Missing estimate evidence for ${task.id}`);
    if (task.priority !== undefined) check(Number.isFinite(task.priority), 'Invalid priority');
    byId.set(task.id, task);
  }
  const children = new Map(tasks.map(t => [t.id, []]));
  for (const task of tasks) for (const parent of new Set(task.requires)) {
    check(byId.has(parent), `Unknown dependency ${parent}`);
    children.get(parent).push(task.id);
  }
  const visiting = new Set(), memo = new Map();
  function walk(id) {
    check(!visiting.has(id), `Dependency cycle at ${id}`);
    if (memo.has(id)) return memo.get(id);
    visiting.add(id);
    const task = byId.get(id);
    const own = task.status === 'done' ? 0 : (task.remainingMs ?? (costs[task.estimate] ?? costs.medium) * 60000);
    let tail = { remainingMs: 0, path: [] };
    const downstream = new Set();
    for (const child of children.get(id)) {
      const result = walk(child);
      if (byId.get(child).status !== 'done') downstream.add(child);
      for (const descendant of result.downstream) downstream.add(descendant);
      if (result.remainingMs > tail.remainingMs) tail = result;
    }
    const result = { remainingMs: own + tail.remainingMs, ownMs: own, path: [id, ...tail.path], downstream: [...downstream] };
    visiting.delete(id); memo.set(id, result); return result;
  }
  for (const task of tasks) walk(task.id);
  const rows = tasks.map(task => ({ ...task, ...memo.get(task.id), uncertainEstimate: task.remainingMs === undefined && !costs[task.estimate] }));
  return rows.sort(compare);
}

function compare(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0) || b.remainingMs - a.remainingMs ||
    b.downstream.length - a.downstream.length || a.ownMs - b.ownMs ||
    (a.completionOrder ?? Number.MAX_SAFE_INTEGER) - (b.completionOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.canonicalOrder ?? Number.MAX_SAFE_INTEGER) - (b.canonicalOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
}

export function publicationCeiling(policy = {}, capacity, demand) {
  integer(capacity, 'capacity'); integer(demand, 'publication demand');
  if (policy.explicitLimit !== undefined) return { ceiling: integer(policy.explicitLimit, 'explicit publication limit', 1), paused: policy.cooldown === true, reason: 'human limit', resetSamples: false };
  let ceiling = integer(policy.previousCeiling ?? 3, 'previous publication ceiling', 1);
  let reason = 'retain measured ceiling', resetSamples = false;
  if (policy.cooldown === true) return { ceiling, paused: true, reason: 'shared API cooldown', resetSamples: false };
  if (policy.pressure === true) {
    ceiling = Math.max(1, Math.floor(ceiling / 2)); reason = 'API or catalog pressure'; resetSamples = true;
  } else if ((policy.completedSinceAdjustment ?? 0) >= 3 && policy.healthy === true && demand > ceiling && capacity > ceiling) {
    ceiling++; reason = 'healthy completed publications and independent backlog'; resetSamples = true;
  }
  // A smaller runtime budget prevents growth; it does not interrupt active workers.
  ceiling = Math.max(1, Math.min(ceiling, Math.max(1, capacity)));
  return { ceiling, reason, resetSamples };
}

export function plan(snapshot) {
  check(snapshot.version === 1, 'Unsupported scheduler snapshot');
  const capacity = integer(snapshot.capacity, 'capacity');
  const rows = rankTasks(snapshot.tasks);
  const used = integer(snapshot.otherOccupiedSlots ?? 0, 'other occupied slots') + rows
    .filter(t => occupied.has(t.status) && !['merge', 'external'].includes(t.lane)).reduce((sum, t) => sum + t.slots, 0);
  check(used <= capacity, 'Occupied slots exceed runtime capacity; reconcile before allocation');
  const byId = new Map(rows.map(t => [t.id, t]));
  const ready = rows.filter(t => t.eligible && t.status === 'pending' && t.requires.every(id => byId.get(id).status === 'done'));
  const busyPublication = new Set(rows.filter(t => occupied.has(t.status) && t.lane === 'publication').map(t => t.stack));
  const busyMaintenance = new Set(rows.filter(t => occupied.has(t.status) && t.lane === 'maintenance').map(t => t.stack));
  const busyRepair = new Set(rows.filter(t => occupied.has(t.status) && t.lane === 'repair').map(t => t.stack));
  const pubQueue = ready.filter(t => t.lane === 'publication' && !busyPublication.has(t.stack) && !busyRepair.has(t.stack) && !busyMaintenance.has(t.stack));
  const pubPolicy = publicationCeiling(snapshot.publicationPolicy, capacity, new Set([...busyPublication, ...pubQueue.map(t => t.stack)]).size);
  let pubRoom = pubPolicy.paused ? 0 : Math.max(0, pubPolicy.ceiling - busyPublication.size);
  let free = capacity - used;
  const allocations = [], selected = new Set(), displaced = {};
  const prior = snapshot.displaced ?? {};
  function pick(task) {
    if (!task || !free || selected.has(task.id)) return false;
    if (task.lane === 'publication' && (!pubRoom || busyPublication.has(task.stack) || busyRepair.has(task.stack) || busyMaintenance.has(task.stack))) return false;
    if (['repair', 'maintenance'].includes(task.lane) && (busyRepair.has(task.stack) || busyPublication.has(task.stack) || busyMaintenance.has(task.stack))) return false;
    allocations.push({ id: task.id, lane: task.lane, stack: task.stack, slots: 1 }); selected.add(task.id); free--;
    if (task.lane === 'publication') { pubRoom--; busyPublication.add(task.stack); }
    if (task.lane === 'repair') busyRepair.add(task.stack);
    if (task.lane === 'maintenance') busyMaintenance.add(task.stack);
    return true;
  }
  const pubSort = (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(!!b.finishesStack) - Number(!!a.finishesStack) || compare(a, b);
  pubQueue.sort(pubSort);
  const implementation = ready.filter(t => t.lane === 'implementation');
  const tracked = [pubQueue.find(t => pubRoom > 0), implementation[0]].filter(Boolean);
  const earned = tracked.filter(t => (prior[t.id]?.count ?? 0) >= 2).sort((a, b) =>
    (prior[a.id].sinceBoundary ?? 0) - (prior[b.id].sinceBoundary ?? 0) || pubSort(a, b));
  // Delegated gate/merge work is real runtime work; dispatch it before repair allocations.
  for (const task of ready.filter(t => t.lane === 'maintenance')) pick(task);
  const exception = earned.find(pick)?.id ?? null;
  const repairs = ready.filter(t => t.lane === 'repair').sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) || Number(!!b.unblocksMerge) - Number(!!a.unblocksMerge) ||
    (a.layer ?? 0) - (b.layer ?? 0) || compare(a, b));
  for (const task of repairs) pick(task);
  for (const task of pubQueue) pick(task);
  for (const lane of ['implementation', 'inventory', 'investigation', 'preparation']) for (const task of ready.filter(t => t.lane === lane)) pick(task);
  const repairAllocated = allocations.some(t => t.lane === 'repair');
  const boundary = integer(snapshot.boundary ?? 0, 'boundary');
  for (const task of tracked) {
    // Loss of eligibility or dispatch resets counters. Only new repairs count as displacement.
    if (!selected.has(task.id) && repairAllocated && free === 0) displaced[task.id] = {
      count: (prior[task.id]?.count ?? 0) + 1, sinceBoundary: prior[task.id]?.sinceBoundary ?? boundary,
    };
  }
  return { version: 1, schedulingOnly: true, ranked: rows, mergeCandidates: ready.filter(t => t.lane === 'merge').map(t => t.id),
    allocations, progressException: exception, displaced, publicationPolicy: pubPolicy,
    accounting: { capacity, used, allocated: allocations.length, unused: free },
    unusedReason: free ? 'No eligible work within publication, dependency and stack limits' : null };
}

// The coordinator alone records these events, outside source. Unknown effects remain occupied.
export function recordEvent(state, event) {
  check(state.version === 1 && Array.isArray(state.events) && state.attempts && typeof state.attempts === 'object', 'Invalid timing state');
  check(typeof event.id === 'string' && event.id && typeof event.attempt === 'string' && event.attempt, 'Missing event/attempt id');
  check(!['__proto__', 'constructor', 'prototype'].includes(event.attempt), 'Invalid attempt id');
  check(Number.isFinite(Date.parse(event.at)), 'Invalid event time');
  const duplicate = state.events.find(e => e.id === event.id);
  if (duplicate) { check(isDeepStrictEqual(duplicate, event), 'Conflicting duplicate event'); return state; }
  const old = state.attempts[event.attempt];
  if (event.type === 'started') {
    check(!old && typeof event.task === 'string' && event.task && lanes.has(event.lane), 'Attempt already exists or missing task/lane');
  } else {
    check(old && old.status !== 'finished', 'Attempt missing or terminal');
    check(Date.parse(event.at) >= Date.parse(old.lastAt), 'Event time moved backwards');
    check(['waiting', 'resumed', 'uncertain', 'finished'].includes(event.type), 'Invalid event type');
    if (old.status === 'uncertain') check(event.reconciled === true && event.evidence, 'Uncertain effect needs reconciliation evidence');
    if (event.type === 'waiting') check(typeof event.reason === 'string' && event.reason, 'Missing wait reason');
    if (event.type === 'resumed') check(['waiting', 'uncertain'].includes(old.status), 'Attempt is not waiting');
    if (event.type === 'finished') check(['succeeded', 'failed', 'cancelled'].includes(event.outcome), 'Missing verified outcome');
  }
  const next = structuredClone(state);
  const prior = old ?? { task: event.task, lane: event.lane, startedAt: event.at, waitMs: 0 };
  const waitMs = prior.waitMs + (prior.status === 'waiting' ? Date.parse(event.at) - Date.parse(prior.lastAt) : 0);
  next.attempts[event.attempt] = { ...prior, status: event.type === 'resumed' ? 'active' : event.type === 'started' ? 'active' : event.type,
    lastAt: event.at, waitMs, ...(event.type === 'finished' ? { outcome: event.outcome, elapsedMs: Date.parse(event.at) - Date.parse(prior.startedAt) } : {}),
    ...(event.reason ? { reason: event.reason } : {}) };
  next.events.push(event); return next;
}

export function writeEvent(path, event) {
  path = resolve(path); mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Timing state busy or interrupted; reconcile its owner before retry'); throw error; }
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let state;
    try { state = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, events: [], attempts: {} };
    }
    const next = recordEvent(state, event);
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' }); renameSync(temp, path);
    return next.attempts[event.attempt];
  } finally { rmSync(temp, { force: true }); rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, input, statePath] = process.argv.slice(2);
    check(input && ['plan', 'record'].includes(command), 'Usage: batch-scheduler.mjs plan snapshot.json | record event.json timing-state.json');
    if (command === 'record') check(statePath, 'Missing timing state path');
    const data = JSON.parse(readFileSync(resolve(input), 'utf8'));
    process.stdout.write(`${JSON.stringify(command === 'plan' ? plan(data) : writeEvent(statePath, data), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
