import { assert, git, head, readPR, run, prIdentity } from './common.mjs';
import { preflight } from './preflight.mjs';
import { loadSession, saveSession, verifySession, ancestor, validations } from './session.mjs';

export function currentContext(s) {
  const check = preflight(s.pr.url, s.stack);
  assert(check.ready, check.blockers.join('; '));
  const p = check.pr;
  assert(p.url === s.pr.url && p.headRepository === s.pr.headRepository && p.headBranch === s.branch && p.repository === s.pr.repository && p.baseBranch === s.pr.baseBranch, 'PR identity or base changed; reconcile before writing');
  assert(check.baseRemote === s.baseRemote && check.pushRemote === s.pushRemote && check.mode === s.mode, 'Remote or stack membership changed');
  if (s.stack) assert(check.stack?.id === s.stack.id && check.stack.lock?.token === s.stack.token && check.stack.lock?.owner === s.stack.owner, 'Stack token is no longer held');
  return check;
}
export function publish(file) {
  const s = loadSession(file), result = verifySession(s, true);
  assert(s.mode === 'ordinary', 'Stack publication belongs to manage-stacked-prs');
  const check = currentContext(s), remote = check.pr.headSha, target = result.headSha;
  if (s.publication) {
    assert(s.publication.targetSha === target, 'Head changed after publication started');
    if (remote === target) { s.publication.state = s.publication.state === 'noop' ? 'noop' : 'verified'; saveSession(file, s); return s.publication; }
    throw new Error('Previous push was failed or uncertain; reconcile remote effects before another attempt');
  }
  assert(remote === s.pr.headSha, 'Remote PR head changed since session initialization');
  if (target === s.startSha) {
    s.publication = { state: 'noop', targetSha: target, expectedRemoteSha: remote }; saveSession(file, s); return s.publication;
  }
  ancestor(remote, target);
  // Check the actual push destination as well as GitHub before a normal push.
  const refs = run('git', ['ls-remote', '--heads', git('remote', 'get-url', '--push', s.pushRemote), `refs/heads/${s.branch}`]).stdout.trim().split(/\s+/);
  assert(refs[0] === remote && refs[1] === `refs/heads/${s.branch}`, 'Push destination does not match expected remote head');
  s.publication = { state: 'attempting', targetSha: target, expectedRemoteSha: remote, attemptedAt: new Date().toISOString() };
  saveSession(file, s);
  const r = run('git', ['-c', 'push.followTags=false', 'push', '--no-follow-tags', '--recurse-submodules=no', s.pushRemote, `${target}:refs/heads/${s.branch}`], true);
  s.publication.exitCode = r.status;
  s.publication.error = r.status === 0 ? null : r.stderr.trim() || r.signal || `Push exit ${r.status}`;
  try {
    const actual = readPR(s.pr.url);
    assert(actual.headRepository === s.pr.headRepository && actual.headBranch === s.branch, 'PR identity changed after push');
    s.publication.observedRemoteSha = actual.headSha;
    s.publication.state = actual.headSha === target ? 'verified' : r.status === 0 ? 'uncertain' : 'failed';
  } catch (error) { s.publication.state = 'uncertain'; s.publication.verificationError = error.message; }
  saveSession(file, s);
  assert(s.publication.state === 'verified', `Publication ${s.publication.state}: ${s.publication.error ?? s.publication.verificationError ?? 'remote head mismatch'}`);
  return s.publication;
}
export function verifyPublication(s) {
  verifySession(s, true);
  const check = currentContext(s);
  assert(check.pr.headSha === head(), 'Final local head is not published');
  if (s.mode === 'ordinary') {
    if (!s.publication && head() === s.startSha && check.pr.headSha === s.pr.headSha) s.publication = { state: 'noop', targetSha: head() };
    assert(s.publication && ['verified', 'noop'].includes(s.publication.state) && s.publication.targetSha === head(), 'Publish or reconcile the final push before thread writes');
  } else {
    const publication = s.stackPublication;
    assert(publication?.complete === true && Array.isArray(publication.layers) && publication.layers.length === s.stack.initialLayers.length, 'Record complete stack publication before thread writes');
    for (let i = 0; i < publication.layers.length; i++) {
      const l = publication.layers[i], before = s.stack.initialLayers[i];
      assert(l.pr === before.pr && l.headRepository === before.headRepository && l.branch === before.branch, 'Stack publication membership/order changed');
      const actual = readPR(l.pr), identity = prIdentity(l.pr);
      assert(actual.state === 'OPEN' && actual.headRepository === l.headRepository && actual.headBranch === l.branch && actual.headSha === l.headSha && actual.baseBranch === l.baseBranch, 'Stack remote head or base chain is not verified');
      assert(l.baseBranch === (i ? publication.layers[i - 1].branch : before.baseBranch), 'Stack base chain differs from recorded boundaries');
      if (i) { assert(identity.repository === publication.layers[i - 1].headRepository, 'Stack parent repository mismatch'); ancestor(publication.layers[i - 1].headSha, l.headSha); }
      if (l.headSha !== before.headSha) validations(publication.validation?.filter(v => v.revision === l.headSha), l.headSha);
    }
  }
  return check;
}
