#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { check, version, nonempty, absolute, readJson, save, lock, cli } from './helper-common.mjs';
import { validateLedger, applyEvent, schedulingSnapshot } from './batch-ledger.mjs';
import { checkpointPlan } from './batch-checkpoints.mjs';
import { plan } from './batch-scheduler.mjs';
import { packHandoff, renderHandoff } from './render-handoff.mjs';
import { workerSettings } from './worker-settings.mjs';
import { ledgerRuntime } from './runtime.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const pointer = (path, field) => ({ path, field });
const laneFor = role => role === 'stack-execution' ? 'publication' : role;
// Observation timestamps and evidence locations may refresh without a state change.
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['readAt', 'observedAt', 'checkedAt', 'fetchedAt', 'at', 'evidence', 'source'].includes(k)).map(([k, v]) => [k, semantic(v)]));
}
const remoteLanes = new Set(['merge', 'maintenance', 'repair', 'publication', 'inventory', 'investigation', 'preparation']);

// This returns a tool wait duration; it never sleeps or polls on its own.
export function waitPolicy({ at, nextCheckAt = null, unchanged = 0, process = false, actionable = false }) {
  check(Number.isFinite(at) && Number.isSafeInteger(unchanged) && unchanged >= 0, 'Invalid wait input');
  check(nextCheckAt === null || Number.isFinite(nextCheckAt), 'Invalid next check time');
  check(typeof process === 'boolean' && typeof actionable === 'boolean', 'Invalid wait flags');
  const duration = process ? Math.min(30000, 10000 * (1 + Math.min(unchanged, 2))) : 30000;
  return actionable ? 0 : Math.max(0, Math.min(duration, nextCheckAt === null ? duration : nextCheckAt - at));
}

function requestStatus(path, at) {
  if (!path) return { known: false, reason: 'Missing requestState path', retryAt: null };
  try {
    absolute(path); const state = readJson(path); version(state);
    check(state.cooldowns && typeof state.cooldowns === 'object' && !Array.isArray(state.cooldowns), 'Invalid cooldown state');
    const times = Object.values(state.cooldowns); check(times.every(Number.isFinite), 'Invalid cooldown deadline');
    // Resource is not known until a remote command is selected. Defer remote hints
    // conservatively; the shared request helper still enforces its resource policy.
    return { known: true, retryAt: Math.max(at, ...times) > at ? Math.max(...times) : null,
      uncertainWrites: Object.entries(state.writes ?? {}).filter(([, w]) => w.status === 'uncertain').map(([id, w]) => ({ id, ...pick(w, ['status', 'method', 'url']), evidence: pointer(path, `writes.${id}`) })) };
  } catch (error) { return { known: false, reason: error.message, retryAt: null }; }
}

export function coordinatorView(ledger, { ledgerPath, requestState, at }) {
  validateLedger(ledger); check(Number.isFinite(at), 'Invalid observation time');
  const cp = checkpointPlan(ledger, at), api = requestStatus(requestState, at);
  const remoteAllowed = api.known && api.retryAt === null;
  const stopped = ledger.maintenance?.state === 'stopped';
  let scheduling = { allocations: [], mergeCandidates: [], accounting: null }, schedulerError = null, snapshot = null;
  try {
    check(ledger.scheduler, 'Missing coordinator scheduling observations');
    snapshot = schedulingSnapshot(ledger);
    if (!remoteAllowed || stopped) snapshot.tasks = snapshot.tasks.map(t => ({ ...t, eligible: t.eligible && !stopped && !remoteLanes.has(t.lane) }));
    scheduling = plan(snapshot);
  } catch (error) { schedulerError = error.message; }
  const future = [ledger.checkpoints.nextFullAt, ...Object.values(ledger.checkpoints.refresh)].filter(t => t > at);
  if (api.retryAt !== null) future.push(api.retryAt);
  const refreshDue = cp.fullDue || cp.dueStacks.length > 0 || ledger.checkpoints.pending.length > 0;
  const managementStarted = Boolean(ledger.maintenance) || Object.values(ledger.stacks).some(s => s.layers.some(l => l.publication?.complete === true));
  const remoteRunnable = managementStarted && !stopped && remoteAllowed && refreshDue && !cp.activePass;
  const actionable = !stopped && (scheduling.allocations.length > 0 || scheduling.mergeCandidates.length > 0 || remoteRunnable);
  const nextCheckAt = actionable ? at : future.length ? Math.min(...future) : null;
  const assignments = Object.fromEntries(Object.entries(ledger.assignments).map(([id, a]) => [id, {
    ...pick(a, ['id', 'taskId', 'role', 'lane', 'status', 'slots', 'worker', 'stackId', 'worktree', 'startSha', 'outcome', 'delivery']),
    evidence: pointer(ledgerPath, `assignments.${id}`),
  }]));
  const stacks = Object.fromEntries(Object.entries(ledger.stacks).map(([id, s]) => [id, {
    ...pick(s, ['id', 'phase', 'baseSha', 'blocker', 'outstandingEffects', 'alignmentPending', 'ownershipActive']),
    coordination: pick(s.coordination, ['phase', 'owner', 'token', 'mode']),
    buildRepair: s.buildRepair ? { ...pick(s.buildRepair, ['assignmentId', 'pr', 'buildOwner', 'reservationOwner']), stateHash: hash(semantic(s.buildRepair)), evidence: pointer(ledgerPath, `stacks.${id}.buildRepair`) } : null,
    publicationAttempt: s.publicationAttempt && !s.publicationAttempt.reconciled ? { ...pick(s.publicationAttempt, ['id', 'status', 'owner']), stateHash: hash(semantic(s.publicationAttempt)) } : null,
    layers: s.layers.map(l => ({ ...pick(l, ['groupId', 'url', 'headSha', 'workerSha']), published: l.publication?.complete === true })),
    uncertainOperations: Object.values(s.operations ?? {}).filter(o => o.status === 'uncertain').map(o => pick(o, ['id', 'kind', 'owner', 'headSha', 'status'])),
    observationHash: hash(semantic(s.maintenance ?? null)), evidence: pointer(ledgerPath, `stacks.${id}`),
  }]));
  const tasks = Object.fromEntries((ledger.scheduler?.tasks ?? []).map(t => [t.id, pick(t, ['id', 'stack', 'lane', 'status', 'eligible', 'requires', 'mergeablePrCount', 'blocker', 'reason'])]));
  const control = {
    implementationEnded: ledger.implementationEnded, management: pick(ledger.maintenance, ['state', 'management']),
    schedulerError, planEvidence: pointer(join(dirname(ledgerPath), 'coordinator-plan.json'), 'plan'), allocations: scheduling.allocations, mergeCandidates: scheduling.mergeCandidates,
    accounting: scheduling.accounting, api,
    checkpoints: { fullDue: cp.fullDue, dueStacks: cp.dueStacks, pending: ledger.checkpoints.pending.map(e => e.id),
      activePass: cp.activePass ? pick(cp.activePass, ['id', 'ownerGrant', 'invalidated']) : null,
      nextFullAt: ledger.checkpoints.nextFullAt, refresh: ledger.checkpoints.refresh, candidatesHash: hash(semantic(cp.candidates)) },
    remoteRefreshRunnable: remoteRunnable, terminalAccountingCandidate: cp.stop,
  };
  return { planning: { snapshot, plan: scheduling, schedulerError }, assignments, stacks, tasks, control, timing: { nextCheckAt, waitMs: waitPolicy({ at, nextCheckAt, actionable }) } };
}

export function observe(input, forceRecovery = false) {
  version(input); absolute(input.ledgerPath);
  const path = resolve(input.ledgerPath), cursorPath = join(dirname(path), 'coordinator-cursor.json');
  const release = lock(cursorPath);
  if (!release) return { version: 1, complete: false, status: 'busy', reason: 'Coordinator cursor busy; no remote work started' };
  try {
    const ledger = validateLedger(readJson(path)), at = input.at ?? Date.now();
    const requestState = input.requestState ?? ledger.context?.requestState;
    const { planning, ...view } = coordinatorView(ledger, { ledgerPath: path, requestState, at });
    save(join(dirname(path), 'coordinator-plan.json'), { version: 1, batchId: ledger.batchId, revision: ledger.revision, ...planning });
    let previous = null, reason = forceRecovery ? 'explicit-resume' : 'missing-or-invalid-cursor';
    try {
      const c = readJson(cursorPath); version(c);
      check(c.batchId === ledger.batchId && c.ledgerPath === path && c.repository === ledger.repository, 'Cursor identity differs');
      check(Number.isSafeInteger(c.revision) && c.revision <= ledger.revision && c.revision >= 0, 'Ledger rolled back');
      check(c.eventHash === hash(ledger.events.slice(0, c.revision)), 'Ledger history diverged');
      check(c.viewHash === hash(c.view) && c.view.assignments && c.view.stacks && c.view.tasks && c.view.control, 'Corrupt cursor view');
      if (!forceRecovery) { previous = c.view; reason = null; }
    } catch { /* A cursor is disposable, never an authorization or ledger repair. */ }
    const delta = {};
    for (const kind of ['assignments', 'stacks', 'tasks']) {
      delta[kind] = Object.fromEntries(Object.entries(view[kind]).filter(([id, v]) => previous ? !isDeepStrictEqual(previous[kind][id], v) : (kind !== 'assignments' || v.status !== 'finished') && (kind !== 'tasks' || v.status !== 'done')));
      if (previous) for (const id of Object.keys(previous[kind])) if (!(id in view[kind])) delta[kind][id] = null;
    }
    if (!previous || !isDeepStrictEqual(previous.control, view.control)) delta.control = view.control;
    const changed = Object.values(delta).some(v => Object.keys(v).length > 0);
    const result = { version: 1, complete: true, schedulingOnly: true, mergeEvidenceReusable: false,
      ledgerPath: path, revision: ledger.revision, cursorPath, mode: previous ? 'delta' : 'recovery', changed,
      changes: delta, ...view.timing };
    if (!previous) result.recovery = { reason, batchId: ledger.batchId, runtime: ledgerRuntime(ledger),
      authorization: ledger.authorization, query: ledger.query, fixedIssueCount: ledger.fixedIssues.length,
      fixedScope: pointer(path, 'fixedIssues'), constraints: pointer(path, 'context'),
      delegation: pointer(path, 'delegation'), maintenance: pointer(path, 'maintenance'),
      uncertainEffects: pointer(path, 'stacks'), requestState: requestState ?? null };
    save(cursorPath, { version: 1, batchId: ledger.batchId, repository: ledger.repository, ledgerPath: path,
      revision: ledger.revision, eventHash: hash(ledger.events), view, viewHash: hash(view) });
    return result;
  } finally { release(); }
}

// Files are staged before one atomic ledger save. The final event holds the
// receipt, so a crash cannot leave committed authority without its retry identity.
export function dispatch(phase, input) {
  version(input); check(['prepare', 'start'].includes(phase), 'Invalid dispatch phase');
  check(input.mode === 'execution', 'Dispatch only records execution assignments');
  absolute(input.ledgerPath); nonempty(input.requestId, 'dispatch request id'); nonempty(input.coordinator, 'coordinator');
  check(Number.isFinite(Date.parse(input.at)), 'Missing dispatch timestamp');
  const path = resolve(input.ledgerPath), release = lock(path);
  if (!release) return { version: 1, complete: false, status: 'busy', reason: 'Ledger busy; no dispatch or remote operation started' };
  try {
    let ledger = validateLedger(readJson(path));
    check(input.coordinator === ledger.coordinator, 'Only recorded coordinator may dispatch');
    check(ledger.maintenance?.state !== 'stopped', 'Management is stopped');
    const key = hash([ledger.batchId, phase, input.requestId]), fingerprint = hash(input);
    const receiptEvent = ledger.events.find(e => e.coordinatorDispatch?.key === key);
    if (receiptEvent) {
      const receipt = receiptEvent.coordinatorDispatch;
      check(receipt.fingerprint === fingerprint, 'Conflicting duplicate dispatch');
      const a = ledger.assignments[receipt.assignmentId];
      check(a && a.status === (phase === 'prepare' ? 'reserved' : 'active'), 'Dispatch already advanced or stopped; reconcile current assignment');
      const packed = readJson(receipt.handoffPath);
      check(hash(packed) === receipt.handoffHash && hash(readJson(receipt.result.messagePath)) === receipt.messageHash, 'Dispatch artifact changed; reconcile before delivery');
      check(ledgerRuntime(packed.ledger) === ledgerRuntime(ledger), 'Dispatch runtime changed');
      renderHandoff({ ...packed, ledger }); // Recheck evidence and current grant before recovery.
      return { ...receipt.result, replayed: true, delivery: 'reconcile-before-send' };
    }
    check(input.expectedRevision === ledger.revision, 'Ledger revision conflict');
    const a = input.assignment;
    check(a && a.ledgerPath === path, 'Handoff ledger path mismatch'); nonempty(a.assignmentId, 'assignment id');
    const settings = workerSettings(input.role, ledgerRuntime(ledger), a.complexity ?? 'standard');
    const old = ledger.assignments[a.assignmentId];
    const events = [];
    function event(type, value) {
      const e = { id: `coordinator:${key}:${events.length}`, expectedRevision: ledger.revision, at: input.at, type, value };
      ledger = applyEvent(ledger, e, input.coordinator); events.push(e);
    }
    if (phase === 'prepare') {
      check(!old, 'Assignment already exists; recover its recorded dispatch');
      const r = input.reservation;
      check(r?.id === a.assignmentId && r.role === input.role && r.lane === laneFor(input.role), 'Reservation identity/role mismatch');
      check(r.status === 'reserved' && !r.worker && !a.worker, 'Preparation requires an unstarted reservation');
      check(r.worktree === a.checkout && r.startSha === a.startSha && r.stackId === a.stackId && r.groupId === a.groupId, 'Reservation scope/checkout/SHA mismatch');
      check((r.complexity ?? 'standard') === (a.complexity ?? 'standard') && r.complexityReason === a.complexityReason, 'Reservation settings mismatch');
      event('assignment', r);
    } else {
      check(old?.status === 'reserved', 'START requires a reserved assignment');
      nonempty(a.worker, 'actual worker'); absolute(a.checkout);
      check(old.role === input.role && old.lane === laneFor(input.role), 'START role mismatch');
      check(old.worktree === a.checkout && old.startSha === a.startSha && old.stackId === a.stackId && old.groupId === a.groupId, 'START scope/checkout/SHA mismatch');
      const prep = ledger.events.find(e => e.coordinatorDispatch?.phase === 'prepare' && e.coordinatorDispatch.assignmentId === a.assignmentId);
      check(prep, 'Missing coordinator preparation receipt; use existing legacy handoff procedure');
      const prior = readJson(prep.coordinatorDispatch.handoffPath);
      check(hash(prior) === prep.coordinatorDispatch.handoffHash, 'Prepared handoff changed');
      check(ledgerRuntime(prior.ledger) === ledgerRuntime(ledger), 'Prepared runtime changed');
      for (const field of ['scope', 'acceptance', 'issueKeys', 'branch', 'commits', 'coordinationId', 'stackOwner', 'complexity', 'complexityReason']) {
        check(isDeepStrictEqual(prior.assignment[field], a[field]), `START changed prepared ${field}`);
      }
      event('assignment', { ...old, worker: a.worker, status: 'active' });
      if (input.grant) {
        check(input.grant.assignmentId === a.assignmentId && input.grant.worker === a.worker && input.grant.role === input.role && input.grant.id === a.grantId && input.grant.generation === a.generation, 'Grant identity mismatch');
        event('delegation-grant', input.grant);
      }
    }
    if (ledger.scheduler) plan(schedulingSnapshot(ledger)); // Reject oversubscription in legacy ledgers too.
    const packed = packHandoff({ version: 1, mode: input.mode, phase, role: input.role, ledger, assignment: a });
    const rendered = renderHandoff(readJson(packed.handoffPath));
    const messagePath = join(dirname(path), `coordinator-${key}-message.json`);
    save(messagePath, { message: rendered });
    const result = { version: 1, complete: true, phase, assignmentId: a.assignmentId, revision: ledger.revision,
      settings, handoffPath: packed.handoffPath, messagePath, evidencePaths: packed.evidencePaths,
      delivery: 'not-sent-by-helper', replayed: false };
    const last = ledger.events.at(-1);
    last.coordinatorDispatch = { key, fingerprint, phase, assignmentId: a.assignmentId, handoffPath: packed.handoffPath, handoffHash: hash(readJson(packed.handoffPath)), messageHash: hash({ message: rendered }), result };
    validateLedger(ledger); save(path, ledger);
    return result;
  } finally { release(); }
}

cli(import.meta.url, 'batch-coordinator.mjs <observe|resume|prepare|start|wait> input.json', ([command, path, ...extra]) => {
  check(path && !extra.length, 'Expected command and input file');
  const input = readJson(path);
  if (command === 'observe' || command === 'resume') return observe(input, command === 'resume');
  if (command === 'prepare' || command === 'start') return dispatch(command, input);
  check(command === 'wait', 'Unknown coordinator command'); version(input);
  return { version: 1, waitMs: waitPolicy(input) };
});
