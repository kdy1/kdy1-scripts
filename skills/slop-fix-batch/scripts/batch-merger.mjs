#!/usr/bin/env node
import { resolve } from 'node:path';
import { check, version, absolute, readJson, cli } from './helper-common.mjs';
import { validateLedger } from './batch-ledger.mjs';
import { unresolvedOperations, verifiedAutoMergeWait } from './batch-delegation.mjs';

// Local ledger reads only. The queue orders the merger's targeted GitHub reads;
// it never proves a gate, replaces fresh whole-stack reads or authorizes a merge.
const terminal = state => state === 'MERGED' || state === 'CLOSED';
const maxWaitMs = 30000;
const stackOf = e => e.stackId ?? e.value?.stackId;

function lastEvents(ledger) {
  const merger = new Set(Object.values(ledger.delegation?.grants ?? {}).filter(g => g.role === 'merger').map(g => g.id));
  const observed = {}, foreign = {};
  ledger.events.forEach((e, i) => {
    const id = stackOf(e);
    if (typeof id !== 'string') return;
    if (e.type === 'stack-observation') observed[id] = i;
    // Results of repairs, ready handoffs and invalidations make the stack due again.
    else if (!merger.has(e.delegated?.grantId)) foreign[id] = i;
  });
  return { observed, foreign };
}

function stackStatus(ledger, s) {
  const prs = s.layers.map(l => ({ url: l.url, state: s.maintenance?.prs?.find(p => p.url === l.url)?.state ?? null }));
  const open = prs.filter(p => !terminal(p.state)).map(p => p.url);
  const wait = verifiedAutoMergeWait(s);
  if (unresolvedOperations(s) || s.alignmentPending || (s.publicationAttempt && !s.publicationAttempt.reconciled)
    || ((s.outstandingEffects || s.ownershipActive) && !wait)) return { status: 'effects', open };
  if (!open.length) return { status: 'merged', open };
  if (Object.values(ledger.assignments).some(a => a.lane === 'repair' && a.stackId === s.id && a.status !== 'finished')) return { status: 'repairing', open };
  if (wait) return { status: 'auto-merge-wait', open };
  return { status: s.maintenance?.blocked === true ? 'blocked' : 'waiting', open };
}

export function mergeQueue(ledger, at, ledgerPath = null) {
  validateLedger(ledger); check(Number.isFinite(at), 'Invalid queue time');
  const state = ledger.maintenance?.state ?? null, stopped = state === 'stopped';
  const { observed, foreign } = lastEvents(ledger);
  const stacks = [];
  Object.values(ledger.stacks).forEach((s, order) => {
    if (s.phase !== 'ready') return;
    const { status, open } = stackStatus(ledger, s);
    const nextCheckAt = Number.isFinite(s.maintenance?.nextCheckAt) ? s.maintenance.nextCheckAt : null;
    const changed = (foreign[s.id] ?? -1) > (observed[s.id] ?? -1);
    let due;
    if (status === 'effects') due = true;
    else if (['merged', 'repairing'].includes(status)) due = false;
    // A stop permits only reconciliation and cancellation of batch-owned requests.
    else if (stopped) due = status === 'auto-merge-wait';
    else if (observed[s.id] === undefined || changed) due = true;
    else if (status === 'blocked') due = nextCheckAt !== null && nextCheckAt <= at;
    else due = nextCheckAt === null || nextCheckAt <= at;
    stacks.push({ id: s.id, status, due, order, openPrs: open, mergeablePrCount: s.maintenance?.mergeablePrCount ?? 0, nextCheckAt,
      reason: s.maintenance?.blocker ?? null, ...(ledgerPath ? { evidence: { path: ledgerPath, field: `stacks.${s.id}` } } : {}) });
  });
  // Reconcile effects first, then the stack with the most mergeable PRs.
  const rank = (a, b) => (b.status === 'effects') - (a.status === 'effects') || b.mergeablePrCount - a.mergeablePrCount || a.order - b.order;
  const due = stacks.filter(x => x.due).sort(rank);
  const pending = stacks.filter(x => x.status !== 'merged');
  const building = Object.values(ledger.stacks).filter(s => s.phase !== 'ready').map(s => s.id);
  let finish;
  if (pending.some(x => ['effects', 'auto-merge-wait'].includes(x.status)) && (stopped || state === 'completed')) finish = { allowed: false, reason: 'Reconcile or cancel batch-owned merge effects first' };
  else if (stopped) finish = { allowed: true, reason: 'Management stopped' };
  else if (state === 'completed') finish = { allowed: true, reason: 'Management completed' };
  else if (!ledger.implementationEnded) finish = { allowed: false, reason: 'Construction can still publish PRs' };
  else if (building.length) finish = { allowed: false, reason: 'Some stacks are not ready' };
  else if (pending.length) finish = { allowed: false, reason: 'Some ready stacks have open PRs' };
  else finish = { allowed: true, reason: 'Every batch PR is merged or closed' };
  const future = pending.filter(x => !x.due && x.nextCheckAt !== null).map(x => x.nextCheckAt);
  const nextCheckAt = due.length ? at : future.length ? Math.min(...future) : null;
  const waitMs = finish.allowed || due.length ? 0 : Math.max(0, Math.min(maxWaitMs, nextCheckAt === null ? maxWaitMs : nextCheckAt - at));
  return { version: 1, complete: true, schedulingOnly: true, mergeEvidenceReusable: false, management: state,
    implementationEnded: ledger.implementationEnded, due: due.map(x => x.id),
    stacks: stacks.filter(x => x.status !== 'merged').sort(rank), mergedStacks: stacks.filter(x => x.status === 'merged').map(x => x.id),
    buildingStacks: building, finish, nextCheckAt, waitMs };
}

// The coordinator starts one merger after the first verified publication and
// replaces it whenever none is active until the merger's finish rule allows.
export function mergerStatus(ledger, at) {
  const queue = mergeQueue(ledger, at);
  const assignments = Object.values(ledger.assignments).filter(a => a.role === 'merger');
  const actor = assignments.find(a => a.status !== 'finished');
  const published = Object.values(ledger.stacks).some(s => s.layers.some(l => l.publication?.complete === true));
  const generation = 1 + Object.values(ledger.delegation?.grants ?? {}).filter(g => g.role === 'merger').reduce((n, g) => Math.max(n, g.generation), 0);
  return { needed: Boolean(ledger.delegation) && ledger.maintenance?.state !== 'stopped' && published && !actor && !queue.finish.allowed,
    taskId: `merger-${assignments.length + 1}`, generation, mergeOwner: assignments[0]?.mergeOwner ?? `${ledger.batchId}:merger`,
    assignmentId: actor?.id ?? null, status: actor?.status ?? null, worker: actor?.worker ?? null,
    due: queue.due, finish: queue.finish };
}

cli(import.meta.url, 'batch-merger.mjs queue input.json', ([command, path, ...extra]) => {
  check(command === 'queue' && path && !extra.length, 'Expected queue and input file');
  const input = readJson(path); version(input); absolute(input.ledgerPath);
  const ledgerPath = resolve(input.ledgerPath);
  return mergeQueue(readJson(ledgerPath), input.at ?? Date.now(), ledgerPath);
});
