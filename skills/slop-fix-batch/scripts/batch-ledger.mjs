#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import { check, version, nonempty, sha, absolute, readJson, load, save, lock, cli } from './helper-common.mjs';
import { emptyCheckpoints, checkpoint, validateCheckpoints } from './batch-checkpoints.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { ledgerRuntime, matchRuntime, runtimeName } from './runtime.mjs';
import { rankTasks } from './batch-scheduler.mjs';
import { delegationSafeBoundary, validateDelegation, grantDelegation, authorizeSubmission, authorizeEvent, closeGrants, unresolvedOperations } from './batch-delegation.mjs';
const safeId = value => { nonempty(value, 'id'); check(!['__proto__', 'constructor', 'prototype'].includes(value), 'Unsafe id'); return value; };
export function initialize(input) {
  version(input); nonempty(input.batchId, 'batch id'); nonempty(input.coordinator, 'coordinator'); nonempty(input.query, 'exact query');
  check(input.selection?.complete === true && Array.isArray(input.selection.issues), 'Complete fixed selection required');
  check(input.selection.query === input.query, 'Selection query mismatch');
  check(input.selection.host === undefined || `${input.selection.host}/${input.selection.repository}`.toLowerCase() === input.repository.toLowerCase(), 'Selection repository mismatch');
  sha(input.inspectedSha); check(/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(input.repository), 'Expected host/owner/repository');
  nonempty(input.baseBranch, 'base branch'); nonempty(input.remote, 'remote'); nonempty(input.authorization, 'original authorization');
  const ledger = { version: 1, revision: 0, batchId: input.batchId, coordinator: input.coordinator, query: input.query,
    repository: input.repository, baseBranch: input.baseBranch, remote: input.remote, authorization: input.authorization,
    inspectedSha: input.inspectedSha, context: { ...structuredClone(input.context ?? {}), runtime: runtimeName(input.context?.runtime) }, fixedIssues: structuredClone(input.selection.issues), groups: {}, stacks: {}, assignments: {}, assessments: {},
    events: [], checkpoints: emptyCheckpoints(), scheduler: null, maintenance: null, implementationEnded: false };
  validateLedger(ledger); return ledger;
}
export function validateLedger(ledger) {
  const runtime = ledgerRuntime(ledger);
  version(ledger); check(Number.isSafeInteger(ledger.revision) && ledger.revision >= 0, 'Invalid ledger revision');
  for (const key of ['batchId', 'coordinator', 'query', 'repository', 'baseBranch', 'remote', 'authorization']) nonempty(ledger[key], key);
  sha(ledger.inspectedSha);
  check(Array.isArray(ledger.fixedIssues) && new Set(ledger.fixedIssues.map(i => i.key)).size === ledger.fixedIssues.length, 'Invalid fixed list');
  ledger.fixedIssues.forEach((issue, i) => { nonempty(issue.key, 'issue identity'); nonempty(issue.url, 'issue URL'); check(issue.canonicalOrder === i, 'Canonical order changed'); });
  for (const key of ['groups', 'stacks', 'assignments', 'assessments']) check(ledger[key] && typeof ledger[key] === 'object' && !Array.isArray(ledger[key]), `Missing ${key}`);
  check(Array.isArray(ledger.events) && ledger.checkpoints && typeof ledger.implementationEnded === 'boolean', 'Missing ledger recovery state');
  validateCheckpoints(ledger.checkpoints);
  const assignedIssues = new Set();
  for (const group of Object.values(ledger.groups)) {
    safeId(group.id); nonempty(group.acceptance, 'group acceptance'); nonempty(group.dependencyEvidence, 'dependency evidence'); check(group.confirmed === true, 'Unconfirmed group'); check(Array.isArray(group.issues) && group.issues.length && Array.isArray(group.requires), 'Missing group scope');
    for (const issue of group.issues) {
      check(ledger.fixedIssues.some(i => i.key === issue) && !assignedIssues.has(issue), 'Issue outside fixed list or assigned twice'); assignedIssues.add(issue);
    }
    for (const dependency of group.requires) check(ledger.groups[dependency], 'Missing group prerequisite');
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) { check(!visiting.has(id), 'Group dependency cycle'); if (visited.has(id)) return; visiting.add(id); ledger.groups[id].requires.forEach(visit); visiting.delete(id); visited.add(id); }
  Object.keys(ledger.groups).forEach(visit);
  const assignedGroups = new Set();
  for (const stack of Object.values(ledger.stacks)) {
    if (stack.publicationAttempt?.preparedPrefix) verifyPublication(stack.publicationAttempt.preparedPrefix, runtime);
    safeId(stack.id); sha(stack.baseSha); check(Array.isArray(stack.groups) && stack.groups.length && Array.isArray(stack.layers), 'Missing stack membership');
    check(['building', 'held', 'ready'].includes(stack.phase), 'Invalid stack phase');
    for (const id of stack.groups) { check(ledger.groups[id] && !assignedGroups.has(id), 'Missing or duplicated stack group'); assignedGroups.add(id); ledger.groups[id].requires.forEach(parent => check(stack.groups.includes(parent), 'Dependency crosses stacks')); }
    check(new Set(stack.layers.map(l => l.groupId)).size === stack.layers.length, 'Duplicate layer');
    stack.layers.forEach((layer, i) => {
      if (layer.publication) matchRuntime(layer.publication.runtime, runtime);
      check(stack.groups.includes(layer.groupId), 'Layer outside stack scope'); check(layer.requirementsSatisfied === true, 'Incomplete implementation requirements'); sha(layer.headSha); sha(layer.workerSha);
      check(layer.checks?.length && layer.checks.every(c => c.status === 'passed' && c.sha === layer.workerSha && c.command), 'Missing passing worker checks at original SHA');
      check(layer.realWorldValidation === 'not-performed', 'Missing skipped validation disclosure');
      check(typeof layer.integrationChanged === 'boolean', 'Missing integration-change observation');
      if (layer.integrationChanged) check(layer.integrationChecks?.length && layer.integrationChecks.every(c => c.status === 'passed' && c.sha === layer.headSha && c.command), 'Missing integration-change checks');
      for (const parent of ledger.groups[layer.groupId].requires) check(stack.layers.slice(0, i).some(l => l.groupId === parent), 'Layer before prerequisite');
    });
    if (stack.phase === 'ready') check(stack.layers.length === stack.groups.length && stack.layers.every(l => l.publication?.complete === true) && stack.readyEvidence && stack.coordination?.phase === 'ready' && stack.detachedSha === stack.layers.at(-1).headSha, 'Incomplete ready handoff');
  }
  for (const a of Object.values(ledger.assignments)) {
    safeId(a.id); nonempty(a.taskId, 'assignment task id'); check(['investigation', 'preparation', 'implementation', 'publication', 'repair', 'maintenance', 'inventory'].includes(a.lane), 'Invalid worker lane'); check(['reserved', 'active', 'uncertain', 'finished'].includes(a.status), 'Invalid assignment status');
    check(Number.isSafeInteger(a.slots) && a.slots >= (a.status === 'finished' ? 0 : 1), 'Missing occupied slots');
    if (a.status === 'finished') check(a.slots === 0 && a.evidence && ['succeeded', 'failed', 'cancelled'].includes(a.outcome), 'Missing assignment completion evidence/outcome');
  }
  check(new Set(ledger.events.map(e => e.id)).size === ledger.events.length && ledger.revision === ledger.events.length, 'Incomplete ledger event history');
  if (ledger.scheduler) { version(ledger.scheduler); rankTasks(ledger.scheduler.tasks); }
  validateDelegation(ledger);
  return ledger;
}
export function applyEvent(ledger, event, owner) {
  validateLedger(ledger); check(owner === ledger.coordinator, 'Only recorded coordinator may write ledger');
  safeId(event.id); check(Number.isFinite(Date.parse(event.at)), 'Missing event timestamp');
  const previous = ledger.events.find(e => e.id === event.id);
  if (previous) { check(isDeepStrictEqual(previous, event), 'Conflicting duplicate event'); return ledger; }
  check(event.expectedRevision === ledger.revision, 'Ledger revision conflict');
  check(!ledger.events.length || Date.parse(event.at) >= Date.parse(ledger.events.at(-1).at), 'Event time moved backwards');
  const next = structuredClone(ledger);
  switch (event.type) {
    case 'delegation-enable':
      check(!ledger.delegation, 'Delegation is already enabled'); delegationSafeBoundary(ledger, event.evidence);
      check(Number.isSafeInteger(event.capacity) && event.capacity > 0, 'Missing actual runtime capacity');
      check(!ledger.scheduler || ledger.scheduler.capacity === event.capacity, 'Capacity differs from scheduler');
      next.delegation = { version: 1, capacity: event.capacity, grants: {}, receipts: {}, activationEvidence: event.evidence }; break;
    case 'delegation-grant':
      safeId(event.value?.id); grantDelegation(next, event.value); break;
    case 'delegation-children': {
      const g = next.delegation?.grants[event.grantId]; check(g?.status === 'active' && g.role === 'maintenance', 'Active maintenance grant required');
      check(Array.isArray(event.childAssignmentIds) && g.childAssignmentIds.every(id => event.childAssignmentIds.includes(id)), 'Cannot drop allocated child accounting');
      g.childAssignmentIds = event.childAssignmentIds; validateDelegation(next); break;
    }
    case 'delegation-revoke': {
      const g = next.delegation?.grants[event.grantId]; check(g && g.status === 'active', 'No active grant');
      check(event.ownerStopped === true && event.operationsClear === true && event.remoteReconciled === true, 'Revoke requires stopped-owner and reconciliation proof');
      nonempty(event.evidence, 'revocation evidence');
      check(!g.stackIds.some(id => unresolvedOperations(next.stacks[id]) || next.stacks[id].outstandingEffects || next.stacks[id].alignmentPending || next.stacks[id].ownershipActive), 'Reconcile operation attempts and stack effects before revocation');
      check(!g.childAssignmentIds.some(id => next.assignments[id].status !== 'finished'), 'Reconcile allocated children before revocation');
      const a = next.assignments[g.assignmentId]; a.status = 'finished'; a.slots = 0; a.outcome = 'cancelled'; a.evidence = event.evidence;
      if (next.checkpoints.active?.ownerGrant === g.id) check(false, 'Finish/reconcile inventory pass before revocation');
      g.status = 'revoked'; g.revocationEvidence = event.evidence; break;
    }
    case 'operation': {
      const s = next.stacks[event.stackId]; check(s, 'Unknown operation stack');
      const op = event.value; safeId(op?.id); sha(op.headSha); nonempty(op.kind, 'operation kind'); nonempty(op.owner, 'operation owner');
      check(['uncertain', 'verified', 'rejected'].includes(op.status), 'Invalid operation status');
      s.operations ??= {}; const previous = s.operations[op.id];
      if (!previous) { check(op.status === 'uncertain', 'Record attempt before effects'); check(!unresolvedOperations(s), 'Reconcile previous operation before another attempt'); }
      else { check(previous.status === 'uncertain' && previous.kind === op.kind && previous.owner === op.owner && previous.headSha === op.headSha, 'Operation identity changed or already reconciled'); check((event.progress === true && op.status === 'uncertain' && event.evidence) || (op.status !== 'uncertain' && event.reconciled === true && event.evidence), 'Operation outcome requires reconciliation');
        if (previous.catalogToken) check(op.catalogToken === previous.catalogToken, 'Catalog token changed');
        if (previous.commandStarted) check(op.commandStarted === true, 'Command-start evidence cannot disappear'); }
      s.operations[op.id] = { ...op, evidence: event.evidence }; break;
    }
    case 'assessment':
      check(ledger.fixedIssues.some(i => i.key === event.issueKey), 'Issue outside fixed list');
      check(['already-closed', 'already-resolved', 'existing-pr', 'actionable', 'blocked'].includes(event.value?.classification), 'Invalid issue assessment');
      nonempty(event.value.evidence, 'assessment evidence'); next.assessments[event.issueKey] = event.value; break;
    case 'groups':
      check(!Object.keys(ledger.stacks).length && !Object.keys(ledger.assignments).length, 'Group replacement requires untouched construction state');
      check(Array.isArray(event.groups), 'Missing groups'); next.groups = {};
      for (const group of event.groups) { safeId(group.id); nonempty(group.acceptance, 'group acceptance'); nonempty(group.dependencyEvidence, 'dependency evidence'); check(group.confirmed === true, 'Unconfirmed group'); check(!next.groups[group.id], 'Duplicate group'); nonempty(group.acceptance, 'acceptance requirements'); nonempty(group.dependencyEvidence, 'dependency/independence evidence'); check(group.confirmed === true, 'Unconfirmed group'); next.groups[group.id] = group; } break;
    case 'group': {
      const g = event.value; safeId(g?.id);
      check(!Object.values(ledger.stacks).some(s => s.groups.includes(g.id)), 'Constructed group scope cannot change');
      check(g.confirmed === true, 'Unconfirmed group'); nonempty(g.acceptance, 'acceptance requirements'); nonempty(g.dependencyEvidence, 'dependency evidence');
      next.groups[g.id] = g; break;
    }
    case 'stack': {
      const s = event.value; safeId(s?.id); check(!next.stacks[s.id], 'Stack already exists');
      check(s.phase === 'building' && Array.isArray(s.layers) && !s.layers.length, 'New stack must start building without layers');
      nonempty(s.revalidationEvidence, 'fresh base revalidation'); nonempty(s.fetchedAt, 'base fetch time'); absolute(s.worktree);
      next.stacks[s.id] = s; break;
    }
    case 'layer': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'building', 'Stack is protected or handed off');
      check(!unresolvedOperations(s), 'Uncertain operation blocks integration');
      check(!s.publicationAttempt || s.publicationAttempt.reconciled === true, 'Uncertain or active publication blocks integration');
      check(!s.layers.some(l => l.publication && !l.publication.complete), 'Uncertain publication blocks integration');
      const old = s.layers.findIndex(l => l.groupId === event.value.groupId);
      check(old === -1 || (old === s.layers.length - 1 && !s.layers[old].publication), 'Published or lower layer cannot change');
      if (old === -1) { check(!s.layers.length || s.layers.at(-1).publication?.complete === true, 'Verify published prefix before integrating next layer'); s.layers.push(event.value); } else s.layers[old] = event.value; break;
    }
    case 'publication-attempt': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'building', 'Only building stack may publish');
      if (s.publicationAttempt && !s.publicationAttempt.reconciled) check(event.reconciled === true && event.evidence, 'Reconcile previous publication attempt first');
      nonempty(event.value?.id, 'publication attempt id');
      s.publicationAttempt = { ...event.value, reconciled: event.reconciled === true, evidence: event.evidence }; break;
    }
    case 'publication': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'building', 'Only construction may record publication');
      const expected = event.verification?.expected;
      check(expected?.baseBranch === ledger.baseBranch, 'Publication bottom base differs from selected target');
      check(expected?.stackId === s.id && expected.layers.length === s.layers.length, 'Publication must cover current prefix');
      s.layers.forEach((layer, i) => {
        check(expected.layers[i].headSha === layer.headSha && expected.layers[i].groupId === layer.groupId, 'Publication differs from integration ledger');
        const closes = ledger.groups[layer.groupId].issues.map(key => ledger.fixedIssues.find(issue => issue.key === key).url).sort();
        check(isDeepStrictEqual([...expected.layers[i].closes].sort(), closes), 'Publication must close every group member');
      });
      const result = verifyPublication(event.verification, ledgerRuntime(ledger)); check(result.complete, result.errors.join('; '));
      for (const [i, layer] of s.layers.entries()) {
        if (layer.publication) check(isDeepStrictEqual(layer.publication.layer, expected.layers[i]), 'Published layer changed');
        layer.url = expected.layers[i].url; layer.publication = { complete: true, runtime: result.runtime, attachmentStatus: result.attachmentStatus, layer: expected.layers[i], observedAt: event.at };
      }
      if (s.publicationAttempt) s.publicationAttempt.reconciled = true;
      next.checkpoints = checkpoint(next.checkpoints, { type: 'enqueue', id: event.id, stackId: s.id, reason: 'publication', at: Date.parse(event.at) }); break;
    }
    case 'coordination':
      check(next.stacks[event.stackId], 'Unknown stack'); nonempty(event.value?.evidence, 'coordination verification');
      next.stacks[event.stackId].coordination = event.value; break;
    case 'ready': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'building', 'Stack not building');
      check(!unresolvedOperations(s), 'Uncertain operation blocks ready');
      check(!Object.values(next.assignments).some(a => a.stackId === s.id && a.status !== 'finished' && a.id !== event.delegated?.assignmentId), 'Active or uncertain stack assignment remains');
      nonempty(event.evidence, 'clean worktree/detach and ready evidence'); sha(event.detachedSha);
      check(!s.publicationAttempt || s.publicationAttempt.reconciled === true, 'Publication effects not reconciled');
      s.phase = 'ready'; s.readyEvidence = event.evidence; s.detachedSha = event.detachedSha;
      next.checkpoints = checkpoint(next.checkpoints, { type: 'enqueue', id: event.id, stackId: s.id, reason: 'ready', at: Date.parse(event.at) }); break;
    }
    case 'assignment': {
      const a = event.value; safeId(a?.id); const old = ledger.assignments[a.id];
      if (old) {
        check(old.status !== 'finished', 'Assignment already terminal');
        check(old.taskId === a.taskId && old.lane === a.lane && old.stackId === a.stackId, 'Assignment scope changed');
        if (old.startSha) check(old.startSha === a.startSha, 'Assignment starting SHA changed');
        if (old.worktree) check(old.worktree === a.worktree, 'Assignment checkout changed');
        if (old.status === 'uncertain' && a.status !== 'uncertain') check(event.reconciled === true && event.evidence, 'Uncertain assignment needs reconciliation before transition');
        check(old.slots === a.slots || a.status === 'finished', 'Occupied slots cannot be silently changed');
        check(old.status === a.status || (old.status === 'reserved' && ['active', 'uncertain', 'finished'].includes(a.status)) || (old.status === 'active' && ['uncertain', 'finished'].includes(a.status)) || old.status === 'uncertain', 'Illegal assignment transition');
        if (old.worker) check(old.worker === a.worker, 'Worker identity changed');
      } else check(a.status === 'reserved', 'Persist reservation before start');
      if (a.status === 'active') { nonempty(a.worker, 'actual worker identity'); absolute(a.worktree); sha(a.startSha); }
      next.assignments[a.id] = a; break;
    }
    case 'scheduler':
      check(!next.delegation || event.value.capacity === next.delegation.capacity, 'Delegation capacity differs from scheduler');
      next.scheduler = event.value; rankTasks(schedulingSnapshot(next).tasks); break;
    case 'checkpoint':
      next.checkpoints = checkpoint(next.checkpoints, event.value);
      if (event.value.type === 'start' && event.delegated) next.checkpoints.active.ownerGrant = event.delegated.grantId;
      break;
    case 'maintenance':
      if (ledger.maintenance?.automationId) check(event.value?.automationId === ledger.maintenance.automationId, 'Do not replace heartbeat blindly');
      next.maintenance = event.value; break;
    case 'implementation-ended':
      check(!Object.values(next.assignments).some(a => !['repair', 'maintenance', 'inventory'].includes(a.lane) && a.status !== 'finished'), 'Construction assignments remain active or uncertain');
      check(Object.values(next.stacks).every(s => ['ready', 'held'].includes(s.phase)), 'Construction stacks still building');
      next.implementationEnded = true;
      next.checkpoints = checkpoint(next.checkpoints, { type: 'enqueue', id: event.id, reason: 'final', at: Date.parse(event.at) }); break;
    case 'stack-observation': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'ready', 'Maintenance observations require ready stack');
      nonempty(event.value?.evidence, 'fresh maintenance observation evidence');
      if (s.outstandingEffects && event.value.outstandingEffects === false) check(event.reconciled === true && event.evidence, 'Reconcile remote effects first');
      s.maintenance = event.value;
      for (const key of ['outstandingEffects', 'alignmentPending', 'ownershipActive']) { check(typeof event.value[key] === 'boolean', `Missing ${key}`); s[key] = event.value[key]; }
      break;
    }
    case 'resume-stack': check(next.stacks[event.stackId]?.phase === 'held', 'Only held construction stack may resume'); nonempty(event.evidence, 'reconciliation evidence'); next.stacks[event.stackId].phase = 'building'; delete next.stacks[event.stackId].blocker; break;
    case 'closure':
      check(ledger.fixedIssues.some(i => i.key === event.issueKey), 'Issue outside fixed list'); sha(event.value?.targetSha);
      check(event.value.state === 'CLOSED' && event.value.stateReason === 'COMPLETED', 'Closure not verified'); nonempty(event.value.commentUrl, 'verified evidence comment URL'); nonempty(event.value.evidence, 'closure evidence');
      next.assessments[event.issueKey] = { ...next.assessments[event.issueKey], closure: event.value }; break;
    case 'hold': check(next.stacks[event.stackId]?.phase === 'building', 'Cannot hold maintenance-owned stack from construction'); nonempty(event.evidence, 'blocker'); next.stacks[event.stackId].phase = 'held'; next.stacks[event.stackId].blocker = event.evidence; break;
    default: throw new Error('Unknown ledger event');
  }
  closeGrants(next);
  next.events.push(event); next.revision++; return validateLedger(next);
}
export function schedulingSnapshot(ledger) {
  check(ledger.scheduler, 'Missing coordinator scheduling observations'); const s = structuredClone(ledger.scheduler); version(s);
  check(Array.isArray(s.tasks), 'Missing scheduling tasks');
  // Assignment state, including uncertain/nested reservations, cannot disappear from accounting.
  let other = 0;
  for (const a of Object.values(ledger.assignments)) {
    const task = s.tasks.find(t => t.id === a.taskId);
    if (task) { task.status = a.status === 'finished' ? (a.outcome === 'succeeded' ? 'done' : 'blocked') : a.status; task.eligible = false; task.slots = a.slots; }
    else if (a.status !== 'finished') other += a.slots;
  }
  s.otherOccupiedSlots = (s.otherOccupiedSlots ?? 0) + other;
  return s;
}
export function resumeSummary(ledger) {
  validateLedger(ledger);
  return { version: 1, runtime: ledgerRuntime(ledger), revision: ledger.revision, fixedIssues: ledger.fixedIssues, stacks: ledger.stacks,
    delegation: ledger.delegation ?? { status: 'legacy-coordinator-only' },
    assignments: Object.values(ledger.assignments).filter(a => a.status !== 'finished'), checkpoints: ledger.checkpoints, maintenance: ledger.maintenance,
    blockers: Object.values(ledger.stacks).filter(s => s.phase === 'held' || s.outstandingEffects).map(s => ({ stackId: s.id, reason: s.blocker ?? 'Unreconciled effects' })), mergeEvidenceReusable: false };
}
export function submitEvents(ledger, input) {
  version(input); validateLedger(ledger); const { grant, duplicate } = authorizeSubmission(ledger, input);
  if (duplicate) return ledger;
  let next = structuredClone(ledger);
  const at = new Date(Math.max(Date.parse(input.at), Date.parse(ledger.events.at(-1)?.at ?? input.at))).toISOString();
  input.events.forEach((payload, index) => {
    authorizeEvent(next, grant, payload);
    check(next.delegation.grants[grant.id].status === 'active', 'Terminal assignment must be last in submission');
    const e = { ...payload, id: `delegate:${grant.id}:${grant.generation}:${input.sequence}:${index}`, expectedRevision: next.revision, at,
      delegated: { grantId: grant.id, assignmentId: grant.assignmentId, worker: input.worker, generation: input.generation, sequence: input.sequence } };
    next = applyEvent(next, e, next.coordinator);
  });
  next.delegation.grants[grant.id].sequence = input.sequence;
  next.delegation.receipts[`${grant.id}:${input.sequence}`] = { input: structuredClone(input), revision: next.revision };
  return validateLedger(next);
}
export function submitLedger(path, input) {
  absolute(path); const release = lock(path);
  if (!release) return { version: 1, complete: false, status: 'busy', reason: 'Ledger busy or interrupted; no network operation started' };
  try { const next = submitEvents(readJson(path), input); save(path, next); return next; } finally { release(); }
}
export function updateLedger(path, owner, event) {
  absolute(path); const release = lock(path); check(release, 'Ledger busy or interrupted; reconcile owner before retry');
  try { const next = applyEvent(readJson(path), event, owner); save(path, next); return next; } finally { release(); }
}
cli(import.meta.url, 'batch-ledger.mjs <init|import|validate|status|resume|snapshot|apply|submit> ledger.json [input.json] [owner]', ([command, path, inputPath, owner]) => {
  absolute(path);
  if (command === 'init' || command === 'import') {
    check(inputPath, 'Missing input file'); const release = lock(path); check(release, 'Ledger busy or interrupted');
    try {
      check(load(path, null) === null, 'Ledger already exists; do not replace it');
      let ledger;
      try { ledger = command === 'init' ? initialize(readJson(inputPath)) : validateLedger(readJson(inputPath)); }
      catch (e) { if (command === 'import') return { version: 1, complete: false, status: 'blocked', reason: `Import requires explicit recovery: ${e.message}` }; throw e; }
      save(path, ledger); return ledger;
    } finally { release(); }
  }
  if (command === 'submit') { check(inputPath, 'Missing submission file'); return submitLedger(path, readJson(inputPath)); }
  if (command === 'apply') { check(inputPath && owner, 'Missing event or coordinator'); return updateLedger(path, owner, readJson(inputPath)); }
  const ledger = validateLedger(readJson(path));
  if (command === 'snapshot') return schedulingSnapshot(ledger);
  if (command === 'resume') return resumeSummary(ledger);
  check(['status', 'validate'].includes(command), 'Unknown ledger command'); return ledger;
});
