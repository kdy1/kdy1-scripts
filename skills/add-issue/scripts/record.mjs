import { existsSync } from 'node:fs';
import { check, hash, lock, outside, readJson, save, same, result, version } from './common.mjs';
import { validatePayload, executionGate, issueNumber, apiCreationRequired } from './payload.mjs';
import { preflight, expectedValue } from './preflight.mjs';
import { verifyRecording, exactText, reconcileImages } from './verify-recording.mjs';
import { GitHub } from './github.mjs';

function verifyOperation(p, c, client, state, id, op) {
  if (id.startsWith('metadata:')) {
    const m = c.metadata.find(x => `metadata:${x.id}` === id);
    return !!m && !!state.issueUrl && same(client.metadata(m, state.issueUrl).value, expectedValue(m));
  }
  if (!op.receipt) return false;
  if (id === 'create') {
    issueNumber(op.receipt, p.target); const issue = client.issue(op.receipt);
    if (issue.author !== p.account || issue.title !== c.title || !exactText(c.body, issue.body, c.images, p.target.host)) return false;
    state.issueUrl = op.receipt; return true;
  }
  if (id.startsWith('attachments:')) {
    const surface = id.slice('attachments:'.length);
    if (op.receipt !== op.browser?.target) return false;
    const observed = surface === 'body' ? { url: state.issueUrl, body: client.issue(state.issueUrl).body } : client.comments(state.issueUrl).find(x => x.url === op.receipt);
    if (!observed) return false;
    const expected = surface === 'body' ? c.body : surface === 'comment' ? c.comment : c.imageComment;
    if (!exactText(expected, observed.body, c.images, p.target.host)) return false;
    return reconcileImages({ images: op.browser.images }, { body: { url: state.issueUrl, body: client.issue(state.issueUrl).body }, [surface]: observed }, p.target.host, state.imageRoutes).complete;
  }
  if (id === 'comment' || id === 'image-comment') {
    const expected = id === 'comment' ? c.comment : c.imageComment;
    return client.comments(state.issueUrl).some(x => x.url === op.receipt && x.author === p.account && exactText(expected, x.body, c.images, p.target.host));
  }
  return false;
}
export function record(input, { client = new GitHub(input.payload.target), afterJournal = () => {} } = {}) {
  version(input); const p = input.payload; validatePayload(p);
  const gate = executionGate({ ...p, candidates: [] }, input.context); if (!gate.complete) return gate;
  for (const c of p.candidates) outside(input.statePath, c.workspace.baseline.repo);
  const release = lock(input.statePath);
  if (!release) return result('blocked', ['Recording ledger is locked; never steal a lock from an active or unverified recorder']);
  try {
    const payloadHash = hash(p);
    const ledger = existsSync(input.statePath) ? readJson(input.statePath) : { version: 1, payloadHash, candidates: {} };
    version(ledger); check(ledger.payloadHash === payloadHash, 'Ledger belongs to another payload');
    const persist = () => save(input.statePath, ledger);
    const outcomes = [];
    for (const c of p.candidates) {
      const state = ledger.candidates[c.id] ??= { ops: {}, omissions: [], issueUrl: c.issueUrl, imageRoutes: {}, attachments: {} };
      const context = { ...input.context, ...(input.context.candidates?.[c.id] ?? {}) };
      const candidateGate = executionGate({ ...p, candidates: [c] }, context);
      if (!candidateGate.complete) { outcomes.push({ ...candidateGate, candidateId: c.id }); continue; }
      if (Object.values(state.ops).some(x => x.status === 'failed')) { outcomes.push(result('failed', ['Required write was explicitly rejected; retain the surviving record'], { candidateId: c.id, issueUrl: state.issueUrl, operations: state.ops })); continue; }
      // Reconcile uncertain prior writes before preflight. Receipts are hints, never proof.
      let unresolved = false;
      for (const [id, op] of Object.entries(state.ops)) {
        if (op.status === 'verified' || op.status === 'omitted') continue;
        const supplied = context.receipts?.[id];
        if (supplied) {
          check(supplied.payloadHash === payloadHash && supplied.operationId === `${c.id}/${id}` && supplied.evidence, 'Receipt lacks reconciliation provenance');
          if (op.receipt) check(op.receipt === supplied.url, 'Cannot replace a retained receipt');
          op.receipt = supplied.url;
        }
        try {
          if (verifyOperation(p, c, client, state, id, op)) op.status = 'verified';
          else unresolved = true;
        } catch { unresolved = true; }
      }
      persist();
      if (unresolved) { outcomes.push(result('uncertain', ['Prior write needs verified reconciliation; no retry'], { candidateId: c.id, issueUrl: state.issueUrl, operations: state.ops })); continue; }
      const flight = preflight(p, c, client, context, state);
      if (!flight.complete) { outcomes.push({ ...flight, candidateId: c.id, issueUrl: state.issueUrl }); continue; }
      state.omissions = [...new Map([...state.omissions, ...flight.metadata.omissions].map(x => [x.id, x])).values()];
      if (c.action !== 'new issue' && flight.issue && !state.preserved) { state.preserved = flight.issue; state.preservedFields = client.preservedFields(c, flight.issue.url); }
      const doWrite = (id, fn, browser = null) => {
        const op = state.ops[id];
        if (op?.status === 'verified' || op?.status === 'omitted') return true;
        check(!op, 'Prior write must be reconciled before another attempt');
        state.ops[id] = { status: 'uncertain', startedAt: new Date().toISOString(), receipt: null };
        persist(); afterJournal(`${c.id}/${id}`);
        if (browser) {
          state.ops[id].browser = browser; if (browser.appendImagesOnly) state.ops[id].receipt = browser.target; persist(); return false;
        }
        try {
          state.ops[id].receipt = fn(); state.ops[id].finishedAt = new Date().toISOString(); persist();
          check(verifyOperation(p, c, client, state, id, state.ops[id]), 'Recorded operation not verified');
          state.ops[id].status = 'verified'; persist(); return true;
        } catch (e) {
          state.ops[id].finishedAt ??= new Date().toISOString();
          // Only an explicit HTTP rejection proves no mutation. Lost responses stay uncertain.
          if (id.startsWith('metadata:') && e.definite) {
            const m = c.metadata.find(x => `metadata:${x.id}` === id);
            if (m.required) state.ops[id].status = 'failed';
            if (!m.required) { state.ops[id].status = 'omitted'; state.omissions.push({ id: m.id, reason: e.message }); persist(); return true; }
          }
          state.ops[id].error = e.message; persist(); return false;
        }
      };
      const pending = c.images.filter(i => i.destination !== 'existing' && !state.attachments[i.id]);
      let bodyImages = pending.filter(i => i.destination === 'body');
      const typeNeedsApi = apiCreationRequired(c, flight.capabilities);
      if (bodyImages.length && (!flight.capabilities.create.attach || typeNeedsApi)) {
        for (const i of bodyImages) state.imageRoutes[i.id] = 'image-comment';
        bodyImages = [];
      }
      persist();
      let stopped = false;
      if (c.action === 'new issue' && !state.issueUrl) {
        const creationMetadata = flight.metadata.apply.filter(m => ['label','type','assignee','milestone'].includes(m.kind));
        if (!doWrite('create', () => client.create(c, creationMetadata, bodyImages))) stopped = true;
      }
      if (!stopped && c.action === 'duplicate comment') {
        const attached = pending.filter(i => i.destination === 'comment');
        const browser = attached.length && !flight.capabilities.comment.attach ? { target: state.issueUrl, body: c.comment, images: attached, surface: 'comment' } : null;
        if (!doWrite('comment', () => client.comment(state.issueUrl, c.comment, attached), browser)) stopped = true;
      }
      if (!stopped) {
        // Membership must precede project fields, regardless of audit entry ordering.
        const ordered = [...flight.metadata.apply].sort((a,b) => Number(b.kind === 'project-membership') - Number(a.kind === 'project-membership'));
        for (const m of ordered) {
          // Creation may already have applied a subset of audited metadata.
          try { if (same(client.metadata(m, state.issueUrl).value, expectedValue(m))) continue; }
          catch (e) { state.error = e.message; stopped = true; break; }
          if (!doWrite(`metadata:${m.id}`, () => { client.writeMetadata(m, state.issueUrl); return state.issueUrl; })) { stopped = true; break; }
        }
      }
      const commentImages = pending.filter(i => (state.imageRoutes[i.id] ?? i.destination) === 'image-comment');
      if (!stopped && commentImages.length && !state.outcome) {
        const browser = !flight.capabilities.comment.attach ? { target: state.issueUrl, body: c.imageComment, images: commentImages, surface: 'image-comment' } : null;
        if (!doWrite('image-comment', () => client.comment(state.issueUrl, c.imageComment, commentImages), browser)) stopped = true;
      }
      if (!stopped && state.outcome?.status === 'failed' && pending.length) {
        const groups = new Map();
        for (const image of pending) { const surface = state.imageRoutes[image.id] ?? image.destination; if (!groups.has(surface)) groups.set(surface, []); groups.get(surface).push(image); }
        for (const [surface, list] of groups) {
          const target = surface === 'body' ? state.issueUrl : state.ops[surface]?.receipt;
          check(target, 'No retained image surface for attachment recovery');
          if (!doWrite(`attachments:${surface}`, () => {}, { target, images: list, surface, appendImagesOnly: true })) { stopped = true; break; }
        }
      }
      if (stopped) {
        const browser = Object.values(state.ops).find(x => x.browser && x.status === 'uncertain');
        outcomes.push(result(browser ? 'blocked' : Object.values(state.ops).some(x => x.status === 'failed') ? 'failed' : 'uncertain', [browser ? 'Recorder must perform the reserved native browser operation and return its receipt' : 'Recording stopped; reconcile retained operations before continuation'], { candidateId: c.id, issueUrl: state.issueUrl, operations: state.ops, omissions: state.omissions, payloadHash }));
        continue;
      }
      const verified = verifyRecording(p, c, client, state, state.omissions);
      state.attachments = verified.attachments; state.outcome = verified; persist();
      outcomes.push({ ...verified, candidateId: c.id });
    }
    const status = outcomes.every(x => x.complete) ? 'verified' : outcomes.some(x => x.status === 'uncertain') ? 'uncertain' : outcomes.some(x => x.status === 'failed') ? 'failed' : outcomes.some(x => x.status === 'blocked') ? 'blocked' : 'needs-review';
    return result(status, [], { payloadHash, outcomes });
  } finally { release(); }
}
