import { readFileSync } from 'node:fs';
import { api, assert, prIdentity, readJSON, run } from './common.mjs';
import { loadSession, saveSession } from './session.mjs';
import { verifyPublication } from './publish.mjs';

function readBody(s, targetSha) {
  const pr = api(s.pr.host, `repos/${s.pr.slug}/pulls/${s.pr.number}`);
  assert(prIdentity(pr.html_url).url === s.pr.url && pr.state === 'open'
    && pr.head?.sha === targetSha && pr.head?.ref === s.branch
    && `${s.pr.host}/${pr.head?.repo?.full_name}`.toLowerCase() === s.pr.headRepository
    && pr.base?.ref === s.pr.baseBranch, 'PR identity or head changed during body update');
  assert(pr.body === null || typeof pr.body === 'string', 'Incomplete PR body read');
  return pr.body ?? '';
}

export function updateBody(file, bodyFile, snapshotFile) {
  const s = loadSession(file);
  const check = verifyPublication(s);
  const targetSha = check.pr.headSha;
  const body = readFileSync(bodyFile, 'utf8');
  const snapshot = readJSON(snapshotFile);
  assert(body.trim(), 'PR body must not be empty');
  assert(prIdentity(snapshot.url).url === s.pr.url && (snapshot.body === null || typeof snapshot.body === 'string'), 'Expected a body snapshot for this PR');
  const before = snapshot.body ?? '';
  const actual = readBody(s, targetSha);
  if (s.bodyUpdate) {
    assert(s.bodyUpdate.body === body && s.bodyUpdate.before === before && s.bodyUpdate.targetSha === targetSha, 'Body update inputs changed; reconcile the recorded attempt');
    if (actual === body) {
      s.bodyUpdate.state = s.bodyUpdate.state === 'noop' ? 'noop' : 'verified';
      saveSession(file, s);
      return s.bodyUpdate;
    }
    throw new Error('Previous body update differs from GitHub; reconcile effects before another attempt');
  }
  if (actual === body) {
    s.bodyUpdate = { state: 'noop', body, before, targetSha };
    saveSession(file, s);
    return s.bodyUpdate;
  }
  assert(actual === before, 'PR body changed since the snapshot; reread it and preserve concurrent edits');
  s.bodyUpdate = { state: 'attempting', body, before, targetSha, attemptedAt: new Date().toISOString() };
  saveSession(file, s);
  try {
    // Pass the loaded text as an argument so shell syntax and newlines stay literal.
    const r = run('gh', ['api', '--hostname', s.pr.host, '--method', 'PATCH', '-f', `body=${body}`, `repos/${s.pr.slug}/pulls/${s.pr.number}`], true);
    s.bodyUpdate.exitCode = r.status;
    if (r.status !== 0) s.bodyUpdate.error = r.stderr.trim() || r.signal || `Body update exit ${r.status}`;
    s.bodyUpdate.state = readBody(s, targetSha) === body ? 'verified' : 'uncertain';
  } catch (error) {
    s.bodyUpdate.state = 'uncertain';
    s.bodyUpdate.error = error.message;
  }
  saveSession(file, s);
  assert(s.bodyUpdate.state === 'verified', 'PR body update is uncertain; reconcile the saved attempt and GitHub body');
  return s.bodyUpdate;
}
