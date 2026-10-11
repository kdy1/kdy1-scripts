import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assert, git, head, readJSON, saveJSON, outsideSource, canonicalPath, readPR } from './common.mjs';
import { preflight } from './preflight.mjs';

export function loadSession(file) {
  const s = readJSON(outsideSource(file));
  assert(s.version === 1 && s.id && Array.isArray(s.problems) && Array.isArray(s.finalValidation) && s.pr?.url && s.startSha && s.root && s.commonDir, 'Unsupported or corrupt repair session');
  assert(s.root === canonicalPath(git('rev-parse', '--show-toplevel')) && s.commonDir === canonicalPath(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'Session belongs to another checkout or Git common directory');
  assert(s.threadOutcomes && typeof s.threadOutcomes === 'object' && !Array.isArray(s.threadOutcomes), 'Invalid thread outcomes');
  s.threadOutcomes = Object.assign(Object.create(null), s.threadOutcomes);
  return s;
}
export function saveSession(file, s) { s.updatedAt = new Date().toISOString(); saveJSON(file, s); }
function sha(value) { assert(typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value), 'Expected a full commit SHA'); return git('rev-parse', '--verify', `${value}^{commit}`); }
export function ancestor(a, b) { assert(git('merge-base', a, b) === a, `${a} is not an ancestor of ${b}`); }
export function validations(values, revision = null) {
  assert(Array.isArray(values) && values.length > 0, 'Validation records are required');
  for (const v of values) {
    assert(typeof v.command === 'string' && v.command.trim() && ['passed', 'failed', 'skipped'].includes(v.result), 'Invalid validation record');
    sha(v.revision);
    if (revision) assert(v.revision === revision && v.result === 'passed', 'Validation must pass at the covered revision');
  }
}
export function initSession(file, pr, stackFile) {
  assert(!existsSync(file), 'Session already exists; reconcile it instead of initializing again');
  const ownership = stackFile ? readJSON(stackFile) : null;
  const check = preflight(pr, ownership);
  assert(check.ready, check.blockers.join('; '));
  assert(check.headSha === check.pr.headSha, 'Initial local head must match the remote PR head; reconcile pre-existing commits');
  let stack = null;
  if (check.stack) {
    assert(ownership?.owner && ownership.token && ownership.snapshotPath, 'Stack initialization requires held owner/token and pre-change snapshotPath');
    assert(check.stack.lock?.owner === ownership.owner && check.stack.lock?.token === ownership.token, 'Acquire or claim the stack token before session initialization');
    const snapshotPath = outsideSource(ownership.snapshotPath);
    const snapshot = readJSON(snapshotPath);
    assert(Array.isArray(snapshot.layers) && snapshot.layers.length === check.stack.layers.length, 'Snapshot must contain every registered stack layer');
    for (let i = 0; i < snapshot.layers.length; i++) {
      const l = snapshot.layers[i], registered = check.stack.layers[i];
      assert(l.pr === registered.pr && l.branch === registered.branch && l.headRepository === registered.headRepository && typeof l.baseBranch === 'string', 'Snapshot identity/order mismatch');
      sha(l.headSha);
      const actual = readPR(l.pr);
      assert(actual.state === 'OPEN' && actual.headSha === l.headSha && actual.headRepository === l.headRepository && actual.headBranch === l.branch && actual.baseBranch === l.baseBranch, 'Snapshot remote identity/head/base mismatch');
      if (i > 0) { sha(l.inheritedBoundary); ancestor(l.inheritedBoundary, l.headSha); }
    }
    assert(snapshot.layers.find(l => l.pr === check.pr.url)?.headSha === check.headSha, 'Snapshot target head is stale');
    stack = { id: check.stack.id, root: check.commonDir, owner: ownership.owner, token: ownership.token, snapshotPath, initialLayers: snapshot.layers };
  } else assert(!ownership, 'Stack ownership supplied for an ordinary PR');
  const s = { version: 1, id: randomUUID(), root: check.root, commonDir: check.commonDir, pr: check.pr,
    startSha: check.headSha, branch: check.branch, baseRemote: check.baseRemote, pushRemote: check.pushRemote,
    mode: check.mode, stack, problems: [], finalValidation: [], validationHistory: [], publication: null, threadOutcomes: {}, createdAt: new Date().toISOString() };
  saveSession(file, s); return s;
}
export function verifySession(s, final = false) {
  assert(Array.isArray(s.problems) && Array.isArray(s.finalValidation) && s.threadOutcomes && ['ordinary', 'stack'].includes(s.mode), 'Invalid session structure');
  sha(s.startSha);
  assert(git('symbolic-ref', '--short', 'HEAD') === s.branch, 'Current branch differs from session');
  const current = head(), ids = new Set(), commits = new Set(), threads = new Set();
  const replay = s.stackPublication?.repairCommits ?? [];
  assert(Array.isArray(replay), 'Invalid replay mapping');
  assert(new Set(replay.map(x => x.problemId)).size === replay.length, 'Duplicate replay mapping');
  for (const mapping of replay) assert(s.problems.some(p => p.id === mapping.problemId && p.commit), 'Unknown repair in replay mapping');
  for (const p of s.problems) {
    assert(typeof p.id === 'string' && p.id.trim() && !ids.has(p.id), 'Duplicate or missing problem id'); ids.add(p.id);
    assert(['merge', 'review', 'ci'].includes(p.kind) && typeof p.evidence === 'string' && p.evidence.trim(), 'Problem requires kind and evidence');
    assert(Array.isArray(p.threads), 'Problem threads must be an array');
    if (p.commit) {
      sha(p.commit); assert(!commits.has(p.commit), 'Independent problems cannot share a commit'); commits.add(p.commit);
      validations(p.validation, p.commit);
    } else assert(p.kind === 'review', 'Merge/CI repairs require a commit');
    for (const t of p.threads) {
      assert(typeof t.id === 'string' && t.id.trim() && !threads.has(t.id), 'Duplicate or invalid thread id'); threads.add(t.id);
      assert(['fixed', 'incorrect', 'blocked'].includes(t.disposition) && typeof t.evidence === 'string' && t.evidence.trim(), 'Thread requires disposition and evidence');
      if (t.disposition === 'fixed') assert(p.commit, 'Fixed thread requires a repair commit');
      if (t.findingCommentId) assert(typeof t.findingCommentId === 'string' && t.findingCommentId.trim(), 'Invalid finding comment id');
      if (t.replyBodyFile) assert(t.disposition === 'incorrect' && typeof t.replyBodyFile === 'string', 'Only incorrect findings may have optional reply files');
    }
    if (p.commit) {
      const mapped = replay.find(x => x.problemId === p.id)?.commit ?? p.commit;
      sha(mapped); ancestor(mapped, current);
      if (!s.stackPublication) ancestor(s.startSha, mapped);
    }
  }
  if (s.mode === 'ordinary' || !s.stackPublication) {
    ancestor(s.startSha, current);
    const actual = git('rev-list', '--first-parent', `${s.startSha}..${current}`).split('\n').filter(Boolean);
    assert(actual.length === commits.size && actual.every(c => commits.has(c)), 'Unrecorded or missing repair commits');
  } else {
    // Restacking can replace target history. Compare both versions with the saved
    // layer boundary; the stack workflow supplies the per-problem SHA mapping.
    assert(s.stack && s.stackPublication.complete === true, 'Incomplete stack publication');
    const layer = s.stack.initialLayers.find(l => l.pr === s.pr.url);
    const boundary = sha(s.stackPublication.targetBoundary);
    ancestor(boundary, current);
    const original = layer.inheritedBoundary ?? s.stackPublication.targetBoundary;
    const ownCount = git('rev-list', '--first-parent', `${original}..${s.startSha}`).split('\n').filter(Boolean).length;
    const actual = git('rev-list', '--first-parent', `${boundary}..${current}`).split('\n').filter(Boolean);
    assert(actual.length === ownCount + commits.size, 'Restack dropped or added target commits; reconcile ranges');
    for (const p of s.problems.filter(p => p.commit)) {
      const mapped = replay.find(x => x.problemId === p.id)?.commit ?? p.commit;
      assert(actual.includes(mapped), 'Mapped repair is outside the target layer');
    }
    if (boundary !== original) assert(replay.length === commits.size, 'Restacked target requires a mapping for every repair commit');
    assert(new Set(replay.map(x => x.commit)).size === replay.length, 'Independent repairs share a replayed commit');
  }
  for (const v of s.finalValidation) { validations([v]); assert(v.revision === current, 'Final validation revision differs from current head'); }
  if (final) { assert(!git('status', '--porcelain'), 'Worktree is not clean'); validations(s.finalValidation, current); }
  return { valid: true, headSha: current, problems: ids.size, commits: commits.size, threads: threads.size };
}
export function recordSession(file, input) {
  const s = loadSession(file);
  assert(!s.publication && !Object.keys(s.threadOutcomes).length, 'Reconcile pending publication/thread writes before changing records');
  assert(Object.keys(input).length === 1, 'Record exactly one problem, validation, or stackPublication');
  if (input.problem) { s.problems.push(input.problem); s.finalValidation = []; }
  else if (input.validation) {
    s.validationHistory ??= []; s.validationHistory.push(input.validation);
    s.finalValidation = s.finalValidation.filter(v => v.command !== input.validation.command);
    s.finalValidation.push(input.validation);
  }
  else if (input.stackPublication) { assert(s.mode === 'stack', 'Stack results require a stack session'); s.stackPublication = input.stackPublication; s.finalValidation = []; }
  else throw new Error('Expected problem, validation, or stackPublication');
  // Recording one problem must not demand that later unrecorded repairs already
  // have entries, but all recorded data is validated before accepting it.
  verifySession(s);
  saveSession(file, s); return s;
}
