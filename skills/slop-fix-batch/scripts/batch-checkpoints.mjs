#!/usr/bin/env node
import { check, version, nonempty, readJson, cli } from './helper-common.mjs';
export const emptyCheckpoints = () => ({ pending: [], active: null, nextFullAt: 0, refresh: {}, candidates: { repair: [], merge: [] }, inventory: null });
export function checkpoint(state, event) {
  validateCheckpoints(state);
  const next = structuredClone(state); nonempty(event.type, 'checkpoint action');
  switch (event.type) {
    case 'enqueue':
      nonempty(event.id, 'checkpoint id');
      if (!next.pending.some(e => e.id === event.id) && !next.active?.events.some(e => e.id === event.id)) next.pending.push(event);
      if (event.stackId) next.refresh[event.stackId] = 0;
      break;
    case 'start':
      check(Number.isFinite(event.at), 'Missing pass start time');
      check(!next.active, 'Checkpoint pass already active'); nonempty(event.passId, 'pass id');
      check(Array.isArray(event.prs) && new Set(event.prs).size === event.prs.length, 'Invalid captured PR set');
      next.active = { id: event.passId, events: next.pending, prs: event.prs, startedAt: event.at }; next.pending = []; break;
    case 'finish': {
      check(next.active?.id === event.passId, 'Pass identity mismatch');
      check(Number.isFinite(event.at) && event.at >= next.active.startedAt, 'Invalid pass finish time');
      const inventory = event.inventory;
      check(inventory && Array.isArray(inventory.prs), 'Missing pass inventory');
      const expected = [...next.active.prs].sort();
      const actual = inventory.prs.map(pr => pr.url).sort();
      const complete = inventory.complete === true && JSON.stringify(expected) === JSON.stringify(actual) && inventory.prs.every(pr => pr.readComplete === true && ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) && /^[a-f0-9]{40}$/i.test(pr.headSha ?? '') && /^[a-f0-9]{40}$/i.test(pr.baseSha ?? '') && Number.isFinite(pr.readAt) && pr.readAt >= next.active.startedAt && pr.readAt <= event.at) && !next.active.invalidated;
      next.inventory = { ...inventory, complete, capturedPrs: next.active.prs, passId: event.passId };
      if (event.full === true && complete) {
        check(Number.isFinite(event.nextFullAt) && event.nextFullAt > event.at, 'Missing next full scan time'); next.nextFullAt = event.nextFullAt;
      }
      for (const [stack, at] of Object.entries(event.refresh ?? {})) { check(Number.isFinite(at), 'Invalid refresh time'); next.refresh[stack] = at; }
      // Events arriving after start always win over refresh deadlines from this pass.
      for (const pending of next.pending) if (pending.stackId) next.refresh[pending.stackId] = 0;
      for (const stack of next.active.invalidatedStacks ?? []) next.refresh[stack] = 0;
      next.active = null; break;
    }
    case 'invalidate':
      nonempty(event.stackId, 'stack id'); next.refresh[event.stackId] = 0;
      if (next.active) { next.active.invalidated = true; next.active.invalidatedStacks = [...new Set([...(next.active.invalidatedStacks ?? []), event.stackId])]; }
      next.inventory = next.inventory ? { ...next.inventory, complete: false } : null;
      for (const queue of Object.values(next.candidates)) for (const candidate of queue) if (candidate.stackId === event.stackId) candidate.stale = true;
      break;
    case 'candidate':
      check(['repair', 'merge'].includes(event.queue), 'Invalid candidate queue');
      nonempty(event.stackId, 'stack id'); nonempty(event.evidence, 'candidate observation source');
      check(Array.isArray(event.prs) && event.prs.length, 'Missing candidate membership');
      next.candidates[event.queue] = [...next.candidates[event.queue].filter(c => c.stackId !== event.stackId), { ...event, hintOnly: true }]; break;
    default: throw new Error('Unknown checkpoint action');
  }
  return validateCheckpoints(next);
}
export function validateCheckpoints(c) {
  check(c && Array.isArray(c.pending) && c.refresh && Number.isFinite(c.nextFullAt) && c.candidates && Array.isArray(c.candidates.repair) && Array.isArray(c.candidates.merge), 'Invalid checkpoint recovery state');
  check(c.active === null || (c.active && Array.isArray(c.active.events) && Array.isArray(c.active.prs) && Number.isFinite(c.active.startedAt)), 'Invalid active pass');
  check(Object.values(c.refresh).every(Number.isFinite), 'Invalid refresh deadlines');
  return c;
}
export function checkpointPlan(ledger, at) {
  version(ledger); check(Number.isFinite(at), 'Invalid planning time'); const c = validateCheckpoints(ledger.checkpoints);
  const urls = Object.values(ledger.stacks).flatMap(s => s.layers.map(l => l.url).filter(Boolean));
  const inventory = c.inventory;
  const complete = inventory?.complete === true && inventory.prs.every(pr => pr.readComplete === true && /^[a-f0-9]{40}$/i.test(pr.headSha ?? '') && /^[a-f0-9]{40}$/i.test(pr.baseSha ?? '') && Number.isFinite(pr.readAt)) && JSON.stringify([...urls].sort()) === JSON.stringify(inventory.prs.map(p => p.url).sort());
  const active = Object.values(ledger.assignments).some(a => ['active', 'reserved', 'uncertain'].includes(a.status));
  const protectedStacks = Object.values(ledger.stacks).some(s => s.phase !== 'ready' || s.outstandingEffects || s.alignmentPending || s.ownershipActive);
  const terminal = complete && inventory.prs.every(p => ['CLOSED', 'MERGED'].includes(p.state));
  return { version: 1, schedulingOnly: true, activePass: c.active, fullDue: at >= c.nextFullAt,
    dueStacks: Object.entries(c.refresh).filter(([, due]) => due <= at).map(([stack]) => stack), candidates: c.candidates,
    complete: Boolean(complete), stop: Boolean(ledger.implementationEnded && terminal && !active && !protectedStacks && !c.active && !c.pending.length) };
}
cli(import.meta.url, 'batch-checkpoints.mjs plan ledger.json [epoch-ms]', ([command, path, at]) => {
  check(command === 'plan' && path, 'Use ledger events to mutate checkpoint state'); return checkpointPlan(readJson(path), at ? Number(at) : Date.now());
});
