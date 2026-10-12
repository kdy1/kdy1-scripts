import { existsSync } from 'node:fs';
import { check, hash, lock, outside, readJson, save, same, result, version, text } from './common.mjs';
import { validatePayload, executionGate, expectedValue } from './payload.mjs';
import { preflight } from './preflight.mjs';
import { GitHub } from './github.mjs';

const editable = new Set(['action','issueUrl','title','body','comment','imageComment','allowedActions','duplicate','metadata','omissions','images','recordPermission']);
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
const imageRouting = new Set(['destination','surfaceUrl','attachmentUrl']);

// Coordinator judgments are supplied from trusted session context; this helper only
// checks invariants, reads current GitHub state, and updates the private ledger.
export function refresh(input, { client = new GitHub(input.payload.target) } = {}) {
  version(input);
  const { previousPayload: previous, payload: next, statePath, review, context } = input;
  validatePayload(previous); validatePayload(next);
  text(review?.candidateId, 'review candidate'); text(review?.reason, 'semantic review reason');
  check(context?.trustedAuthorization === true && context?.duplicateReview?.confirmed === true, 'Trusted coordinator duplicate review required');
  text(context.duplicateReview.evidence, 'trusted review provenance');
  check(same(without(previous, new Set(['candidates'])), without(next, new Set(['candidates']))), 'Cannot change run, repository, or account');
  check(same(previous.candidates.map(c => c.id), next.candidates.map(c => c.id)), 'Cannot add, remove, or reorder candidates');
  for (const c of previous.candidates) outside(statePath, c.workspace.baseline.repo);
  const old = previous.candidates.find(c => c.id === review.candidateId);
  const candidate = next.candidates.find(c => c.id === review.candidateId);
  check(old && candidate, 'Unknown review candidate');
  const ctx = { ...context, ...(context.candidates?.[old.id] ?? {}) };
  const gate = executionGate({ ...next, candidates: [candidate] }, ctx);
  if (!gate.complete) return gate;
  for (const c of previous.candidates) {
    const updated = next.candidates.find(x => x.id === c.id);
    check(c.id === old.id ? same(without(c, editable), without(updated, editable)) : same(c, updated), 'Cannot change investigation or another candidate');
  }
  check(same(old.images.map(i => without(i, imageRouting)), candidate.images.map(i => without(i, imageRouting))), 'Cannot change approved images');
  check(same(old.duplicate.query, candidate.duplicate.query) && old.duplicate.limit === candidate.duplicate.limit, 'Retain bounded duplicate query');
  for (const m of candidate.metadata) {
    const prior = old.metadata.find(x => x.id === m.id);
    check(prior && same(without(prior, new Set(['destination','observed','permission'])), without(m, new Set(['destination','observed','permission']))), 'Cannot expand audited metadata');
  }
  const release = lock(statePath);
  if (!release) return result('blocked', ['Recording ledger is locked']);
  try {
    const oldHash = hash(previous), newHash = hash(next);
    const ledger = existsSync(statePath) ? readJson(statePath) : { version: 1, payloadHash: oldHash, candidates: {} };
    version(ledger);
    // A lost refresh response may be recovered by repeating the identical request.
    if (ledger.payloadHash === newHash && ledger.history?.some(x => x.previousHash === oldHash && x.payloadHash === newHash && same(x.review, review))) return result('verified', [], { payloadHash: newHash });
    check(ledger.payloadHash === oldHash, 'Ledger belongs to another payload');
    const state = ledger.candidates[old.id] ?? { ops: {}, omissions: [], issueUrl: old.issueUrl, imageRoutes: {}, attachments: {} };
    check(Object.values(state.ops).every(op => ['verified','omitted'].includes(op.status)), 'Reconcile uncertain or failed writes with the previous payload before refresh');
    const hasOperations = Object.keys(state.ops).length > 0;
    if (hasOperations) check(same(without(old, new Set(['duplicate'])), without(candidate, new Set(['duplicate']))), 'Completed operations retain their target, content, metadata, and images');
    const observed = preflight(previous, old, client, ctx, state);
    if (observed.status !== 'needs-review') return observed.complete ? result('blocked', ['No duplicate change to review']) : observed;
    if (!same(review.observations, observed.duplicateReview)) return observed;
    const updatedState = structuredClone(state);
    if (!hasOperations) {
      updatedState.issueUrl = candidate.issueUrl;
      updatedState.omissions = [];
      delete updatedState.preserved; delete updatedState.preservedFields; delete updatedState.outcome;
    }
    const flight = preflight(next, candidate, client, ctx, updatedState);
    if (!flight.complete) return flight;
    // Required metadata can disappear from a no-write handoff only when already satisfied.
    for (const m of old.metadata.filter(m => m.required && !candidate.metadata.some(x => x.id === m.id))) {
      check(candidate.issueUrl && same(client.metadata({ ...m, destination: m.kind.startsWith('project-') ? m.destination : candidate.issueUrl }, candidate.issueUrl).value, expectedValue(m)), 'Cannot drop unsatisfied required metadata');
    }
    if (hasOperations && updatedState.preserved && flight.issue) {
      for (const key of ['title','body']) updatedState.preserved[key] = flight.issue[key];
    }
    ledger.history ??= [];
    ledger.history.push({ previousHash: oldHash, payloadHash: newHash, previousPayload: previous, review, provenance: context.duplicateReview.evidence });
    ledger.payloadHash = newHash;
    ledger.candidates[old.id] = updatedState;
    save(statePath, ledger);
    return result('verified', [], { payloadHash: newHash, candidateId: old.id, action: candidate.action, issueUrl: updatedState.issueUrl });
  } finally { release(); }
}
