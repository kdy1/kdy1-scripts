#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import { check, version, nonempty, sha, absolute, readJson, load, save, lock, cli } from './helper-common.mjs';
import { emptyCheckpoints, checkpoint, validateCheckpoints } from './batch-checkpoints.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { rankTasks } from './batch-scheduler.mjs';
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
    inspectedSha: input.inspectedSha, context: structuredClone(input.context ?? {}), fixedIssues: structuredClone(input.selection.issues), groups: {}, stacks: {}, assignments: {}, assessments: {},
    events: [], checkpoints: emptyCheckpoints(), scheduler: null, maintenance: null, implementationEnded: false };
  validateLedger(ledger); return ledger;
}
export function validateLedger(ledger) {
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
    safeId(stack.id); sha(stack.baseSha); check(Array.isArray(stack.groups) && stack.groups.length && Array.isArray(stack.layers), 'Missing stack membership');
    check(['building', 'held', 'ready'].includes(stack.phase), 'Invalid stack phase');
    for (const id of stack.groups) { check(ledger.groups[id] && !assignedGroups.has(id), 'Missing or duplicated stack group'); assignedGroups.add(id); ledger.groups[id].requires.forEach(parent => check(stack.groups.includes(parent), 'Dependency crosses stacks')); }
    check(new Set(stack.layers.map(l => l.groupId)).size === stack.layers.length, 'Duplicate layer');
    stack.layers.forEach((layer, i) => {
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
    safeId(a.id); nonempty(a.taskId, 'assignment task id'); check(['investigation', 'preparation', 'implementation', 'publication', 'repair'].includes(a.lane), 'Invalid worker lane'); check(['reserved', 'active', 'uncertain', 'finished'].includes(a.status), 'Invalid assignment status');
    check(Number.isSafeInteger(a.slots) && a.slots >= (a.status === 'finished' ? 0 : 1), 'Missing occupied slots');
    if (a.status === 'finished') check(a.slots === 0 && a.evidence && ['succeeded', 'failed', 'cancelled'].includes(a.outcome), 'Missing assignment completion evidence/outcome');
  }
  check(new Set(ledger.events.map(e => e.id)).size === ledger.events.length && ledger.revision === ledger.events.length, 'Incomplete ledger event history');
  if (ledger.scheduler) { version(ledger.scheduler); rankTasks(ledger.scheduler.tasks); }
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
      const result = verifyPublication(event.verification); check(result.complete, result.errors.join('; '));
      for (const [i, layer] of s.layers.entries()) {
        if (layer.publication) check(isDeepStrictEqual(layer.publication.layer, expected.layers[i]), 'Published layer changed');
        layer.url = expected.layers[i].url; layer.publication = { complete: true, layer: expected.layers[i], observedAt: event.at };
      }
      if (s.publicationAttempt) s.publicationAttempt.reconciled = true;
      next.checkpoints = checkpoint(next.checkpoints, { type: 'enqueue', id: event.id, stackId: s.id, reason: 'publication', at: Date.parse(event.at) }); break;
    }
    case 'coordination':
      check(next.stacks[event.stackId], 'Unknown stack'); nonempty(event.value?.evidence, 'coordination verification');
      next.stacks[event.stackId].coordination = event.value; break;
    case 'ready': {
      const s = next.stacks[event.stackId]; check(s?.phase === 'building', 'Stack not building');
      check(!Object.values(next.assignments).some(a => a.stackId === s.id && a.status !== 'finished'), 'Active or uncertain stack assignment remains');
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
    case 'scheduler': next.scheduler = event.value; rankTasks(schedulingSnapshot(next).tasks); break;
    case 'checkpoint': next.checkpoints = checkpoint(next.checkpoints, event.value); break;
    case 'maintenance':
      if (ledger.maintenance?.automationId) check(event.value?.automationId === ledger.maintenance.automationId, 'Do not replace heartbeat blindly');
      next.maintenance = event.value; break;
    case 'implementation-ended':
      check(!Object.values(next.assignments).some(a => a.lane !== 'repair' && a.status !== 'finished'), 'Construction assignments remain active or uncertain');
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
  return { version: 1, revision: ledger.revision, fixedIssues: ledger.fixedIssues, stacks: ledger.stacks,
    assignments: Object.values(ledger.assignments).filter(a => a.status !== 'finished'), checkpoints: ledger.checkpoints, maintenance: ledger.maintenance,
    blockers: Object.values(ledger.stacks).filter(s => s.phase === 'held' || s.outstandingEffects).map(s => ({ stackId: s.id, reason: s.blocker ?? 'Unreconciled effects' })), mergeEvidenceReusable: false };
}
export function updateLedger(path, owner, event) {
  absolute(path); const release = lock(path); check(release, 'Ledger busy or interrupted; reconcile owner before retry');
  try { const next = applyEvent(readJson(path), event, owner); save(path, next); return next; } finally { release(); }
}
cli(import.meta.url, 'batch-ledger.mjs <init|import|validate|status|resume|snapshot|apply> ledger.json [input.json] [owner]', ([command, path, inputPath, owner]) => {
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
  if (command === 'apply') { check(inputPath && owner, 'Missing event or coordinator'); return updateLedger(path, owner, readJson(inputPath)); }
  const ledger = validateLedger(readJson(path));
  if (command === 'snapshot') return schedulingSnapshot(ledger);
  if (command === 'resume') return resumeSummary(ledger);
  check(['status', 'validate'].includes(command), 'Unknown ledger command'); return ledger;
});
