import { isDeepStrictEqual } from 'node:util';
import { check, nonempty, sha } from './helper-common.mjs';

export const roleEvents = {
  'stack-execution': ['layer', 'publication-attempt', 'publication', 'coordination', 'ready', 'hold', 'operation', 'assignment', 'checkpoint'],
  maintenance: ['stack-observation', 'coordination', 'operation', 'assignment', 'checkpoint'],
  inventory: ['checkpoint', 'assignment'],
};
export const occupied = a => a.status !== 'finished';
export const unresolvedOperations = s => Object.values(s.operations ?? {}).some(o => o.status === 'uncertain');
export function delegationSafeBoundary(ledger, evidence) {
  check(!Object.values(ledger.assignments).some(occupied) && !ledger.checkpoints.active, 'Delegation activation requires idle assignments and inventory');
  check(Object.values(ledger.stacks).every(s => !s.outstandingEffects && !s.alignmentPending && !s.ownershipActive && !unresolvedOperations(s) && (!s.publicationAttempt || s.publicationAttempt.reconciled)), 'Reconcile effects and ownership before delegation activation');
  check(evidence?.operationsClear === true && evidence?.ownersReconciled === true, 'Missing safe-boundary proof');
  nonempty(evidence.summary, 'safe-boundary evidence');
}
export function validateDelegation(ledger) {
  const d = ledger.delegation;
  if (!d) return;
  check(d.version === 1 && Number.isSafeInteger(d.capacity) && d.capacity > 0 && d.grants && d.receipts, 'Invalid delegation state');
  const busyStacks = new Set(); let inventory = false;
  for (const g of Object.values(d.grants)) {
    nonempty(g.id, 'grant id'); check(!['__proto__', 'constructor', 'prototype'].includes(g.id), 'Unsafe grant id'); nonempty(g.worker, 'grant worker');
    check(roleEvents[g.role] && Number.isSafeInteger(g.generation) && g.generation > 0, 'Invalid grant role/generation');
    check(['active', 'finished', 'revoked'].includes(g.status), 'Invalid grant status');
    check(Number.isSafeInteger(g.sequence) && g.sequence >= 0, 'Invalid grant sequence');
    check(Array.isArray(g.stackIds) && g.stackIds.length && new Set(g.stackIds).size === g.stackIds.length && g.stackIds.every(id => ledger.stacks[id]), 'Invalid grant stacks');
    check(g.role === 'inventory' || g.stackIds.length === 1, 'Execution grant must cover exactly one stack');
    check(Array.isArray(g.allowedEvents) && g.allowedEvents.length && g.allowedEvents.every(t => roleEvents[g.role].includes(t)), 'Invalid grant event permissions');
    const a = ledger.assignments[g.assignmentId];
    check(a && a.worker === g.worker && a.role === g.role, 'Grant assignment identity mismatch');
    check(a.lane === ({ 'stack-execution': 'publication', maintenance: 'maintenance', inventory: 'inventory' })[g.role], 'Grant lane mismatch');
    check(g.stackIds.includes(a.stackId) || g.role === 'inventory', 'Grant assignment stack mismatch');
    if (g.role === 'stack-execution') check(ledger.stacks[a.stackId].groups.includes(a.groupId), 'Missing assigned execution group');
    check(Array.isArray(g.childAssignmentIds) && (g.role === 'maintenance' || g.childAssignmentIds.length === 0), 'Invalid child allocation');
    for (const id of g.childAssignmentIds) {
      const child = ledger.assignments[id];
      check(child?.lane === 'repair' && g.stackIds.includes(child.stackId) && child.parentAssignmentId === a.id, 'Child must be a coordinator-reserved repair in the assigned stack');
    }
    if (g.status !== 'active') continue;
    check(a.status !== 'finished', 'Active grant has terminal assignment');
    if (g.role === 'inventory') { check(!inventory, 'Only one inventory owner permitted'); inventory = true; continue; }
    for (const id of g.stackIds) { check(!busyStacks.has(id), 'Stack has another execution owner'); busyStacks.add(id); }
  }
  const used = Object.values(ledger.assignments).filter(occupied).reduce((n, a) => n + a.slots, 0) + (ledger.scheduler?.otherOccupiedSlots ?? 0);
  check(used <= d.capacity, 'Assignments exceed delegated runtime capacity');
}
export function grantDelegation(ledger, value) {
  check(ledger.delegation, 'Enable delegation explicitly before granting work');
  check(value && !ledger.delegation.grants[value.id], 'Grant id already used');
  const a = ledger.assignments[value.assignmentId];
  check(a && ['reserved', 'active'].includes(a.status) && a.worker === value.worker && a.role === value.role, 'Persist actual assignment identity before grant');
  check((value.role === 'inventory' || value.stackIds?.includes(a.stackId)), 'Grant scope differs from assignment');
  check(value.stackIds?.every(id => ledger.stacks[id] && !unresolvedOperations(ledger.stacks[id]) && !ledger.stacks[id].outstandingEffects && !ledger.stacks[id].alignmentPending && !ledger.stacks[id].ownershipActive), 'Reconcile prior stack effects before assigning a new actor');
  if (value.role === 'stack-execution') check(ledger.stacks[a.stackId]?.phase === 'building', 'Execution requires building stack');
  if (value.role === 'maintenance') check(ledger.stacks[a.stackId]?.phase === 'ready', 'Maintenance requires ready stack');
  check(Object.values(ledger.delegation.grants).filter(g => g.role === value.role && g.stackIds.some(id => value.stackIds.includes(id))).every(g => value.generation > g.generation), 'Grant generation must advance on replacement');
  ledger.delegation.grants[value.id] = { ...value, status: 'active', sequence: 0, childAssignmentIds: value.childAssignmentIds ?? [] };
  validateDelegation(ledger);
}
export function authorizeSubmission(ledger, input) {
  check(ledger.delegation, 'Legacy ledger permits coordinator writes only');
  const g = ledger.delegation.grants[input.grantId];
  check(g && g.worker === input.worker && g.generation === input.generation, 'Delegated identity/generation mismatch');
  const receipt = ledger.delegation.receipts[`${g.id}:${input.sequence}`];
  if (receipt) { check(isDeepStrictEqual(receipt.input, input), 'Conflicting duplicate delegated submission'); return { grant: g, duplicate: true }; }
  check(g.status === 'active' && ledger.assignments[g.assignmentId].status === 'active', 'Delegated START requires active recorded worker; grant is stopped or preparing');
  check(input.sequence === g.sequence + 1, 'Delegated sequence conflict');
  check(Number.isFinite(Date.parse(input.at)), 'Missing submission timestamp');
  check(Array.isArray(input.events) && input.events.length && input.events.every(e => e && typeof e === 'object'), 'Missing delegated events');
  return { grant: g, duplicate: false };
}
export function authorizeEvent(ledger, g, e) {
  check(g.allowedEvents.includes(e.type), 'Event outside delegated permissions');
  check(!('expectedRevision' in e) && !('id' in e) && !('at' in e) && !('delegated' in e), 'Event metadata is assigned by submission helper');
  if (e.type === 'assignment') {
    const a = ledger.assignments[e.value?.id];
    check(a && (a.id === g.assignmentId || g.childAssignmentIds.includes(a.id)), 'Cannot modify unallocated assignment');
    // Slots, scope and identity cannot be redirected by an actor. The coordinator reserves children.
    const candidate = { ...e.value, status: a.status, slots: a.slots, worker: a.worker, evidence: a.evidence, outcome: a.outcome };
    const original = { ...a, evidence: a.evidence, outcome: a.outcome };
    for (const key of ['worker', 'worktree', 'startSha', 'startAuthorization', 'delivery', 'reservation']) {
      if (g.childAssignmentIds.includes(a.id) && a.status === 'reserved' && !a[key]) { delete candidate[key]; delete original[key]; }
    }
    check(isDeepStrictEqual(candidate, original), 'Assignment scope/identity/slots cannot change');
    if (a.id === g.assignmentId && e.value.status === 'finished') {
      check(!g.stackIds.some(id => unresolvedOperations(ledger.stacks[id]) || ledger.stacks[id].outstandingEffects || ledger.stacks[id].alignmentPending || ledger.stacks[id].ownershipActive || (ledger.stacks[id].publicationAttempt && !ledger.stacks[id].publicationAttempt.reconciled)), 'Unreconciled effects retain actor slot');
      check(!g.childAssignmentIds.some(id => ledger.assignments[id].status !== 'finished'), 'Allocated repair children must be reconciled before parent completion');
      check(ledger.checkpoints.active?.ownerGrant !== g.id, 'Finish inventory pass before returning slot');
    }
    if (g.childAssignmentIds.includes(a.id) && a.worker) check(e.value.worker === a.worker, 'Recorded child identity cannot change');
    return;
  }
  if (e.type === 'checkpoint') {
    const c = e.value;
    if (g.role === 'inventory') {
      check(['start', 'finish'].includes(c?.type), 'Inventory owner only starts/finishes its captured pass');
      const urls = g.stackIds.flatMap(id => ledger.stacks[id].layers.map(l => l.url).filter(Boolean));
      if (c.type === 'start') check(Array.isArray(c.prs) && c.prs.every(url => urls.includes(url)), 'Inventory includes unassigned PR');
      else check(ledger.checkpoints.active?.ownerGrant === g.id && c.passId === ledger.checkpoints.active.id, 'Cannot finish another inventory pass');
    } else {
      check(['enqueue', 'invalidate', 'candidate'].includes(c?.type) && g.stackIds.includes(c.stackId), 'Checkpoint outside assigned stack');
      if (c.type === 'candidate') check(Array.isArray(c.prs) && c.prs.every(p => ledger.stacks[c.stackId].layers.some(l => l.url === (typeof p === 'string' ? p : p.url))), 'Candidate contains unassigned PR');
    }
    return;
  }
  check(g.stackIds.includes(e.stackId), 'Event outside assigned stack');
  const s = ledger.stacks[e.stackId];
  if (g.role === 'stack-execution') {
    check(s.phase === 'building', 'Construction grant cannot mutate ready/held stack');
    if (e.type === 'layer') check(e.value?.groupId === ledger.assignments[g.assignmentId].groupId, 'Layer differs from assigned group');
  } else check(g.role === 'maintenance' && s.phase === 'ready', 'Maintenance grant cannot mutate building/held stack');
  if (e.type === 'coordination') check(e.value?.phase === (g.role === 'maintenance' ? 'ready' : e.value?.phase) && ['building', 'ready'].includes(e.value?.phase), 'Invalid delegated coordination phase');
  if (e.type === 'operation') { nonempty(e.value?.id, 'operation id'); sha(e.value?.headSha); }
}
export function closeGrants(ledger) {
  if (!ledger.delegation) return;
  for (const g of Object.values(ledger.delegation.grants)) if (g.status === 'active' && ledger.assignments[g.assignmentId].status === 'finished') g.status = 'finished';
}
