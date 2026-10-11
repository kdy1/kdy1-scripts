import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { content, choose, preserve, GitHub } from './core.mjs';
import { publish, reconcile, verify } from './create-pr.mjs';

const sha = 'a'.repeat(40);
const plan = () => ({ version: 1, host: 'github.com', repository: 'owner/repo', headRepository: 'owner/repo', headBranch: 'codex/change', baseBranch: 'main', headSha: sha, title: 'fix: handle input', draft: false, language: 'English', issues: [{ repository: 'owner/repo', number: 12, kind: 'closes' }], requiredText: ['Validation: not performed.'], attachments: [] });
const body = 'Handle input.\n\nValidation: not performed.\n\nCloses #12\n';
const pr = p => ({ ...p, url: 'https://github.com/owner/repo/pull/1', state: 'OPEN', body });
function fake(p, { partial = false, initial = null } = {}) {
  let actual = initial, writes = 0; const commands = [];
  return { commands, get writes() { return writes; }, repository: () => ({ full_name: p.repository, default_branch: 'main' }), remoteHead: () => sha,
    comparison: () => ({ files: [{ filename: 'a.mjs' }] }),
    matches: () => actual ? [actual] : [], pr: () => actual, issue: () => ({}),
    command(args) { commands.push(args); if (args.includes('--help')) return { ok: true, stdout: 'Usage\n  --attach string\n' };
      writes++; if (args[1] === 'ready') { actual.draft = args.includes('--undo'); return { ok: true, code: 0 }; }
      actual = { ...pr(p), draft: initial?.draft ?? p.draft, body: readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') };
      return { ok: !partial, code: partial ? 1 : 0, stderr: partial ? 'upload failed after create' : '' };
    } };
}
test('references inside code cannot satisfy closing requirements; conflicts are rejected', () => {
  const p = plan();
  for (const fenced of ['```md\nCloses #12\n```', '~~~~\nCloses #12\n~~~\n~~~~', '    Closes #12']) assert.equal(content(p, 'Validation: not performed.\n' + fenced).status, 'mismatch');
  assert.equal(content(p, body).status, 'verified');
  assert.equal(content(p, body + 'Refs owner/repo#12\n').status, 'mismatch');
});
test('existing unrelated references/images survive edits but explicit classification can change', () => {
  const p = plan(), image = '![Screen](https://github.com/user-attachments/assets/abc)';
  assert.deepEqual(preserve(p, `Refs #12\nRefs #13\n${image}`, `${body}\nRefs #13\n${image}`), []);
  assert.equal(preserve(p, `Refs #13\n${image}`, body).length, 2);
});
test('candidate ambiguity/base mismatch stops and recorded closed PR is returned without replacement', () => {
  const p = plan();
  assert.throws(() => choose(p, { matches: () => [pr(p), pr(p)] }), /Multiple/);
  assert.throws(() => choose(p, { matches: () => [{ ...pr(p), baseBranch: 'other' }] }), /mismatch/);
  p.prUrl = pr(p).url;
  assert.equal(choose(p, { pr: () => ({ ...pr(p), state: 'MERGED' }), matches: () => { throw Error('must not search'); } }).status, 'stopped');
});
test('REST list filters the exact head repository and branch', () => {
  const p = plan();
  const raw = repository => ({ html_url: pr(p).url, state: 'open', draft: false, title: p.title, body, base: { ref: 'main', repo: { full_name: p.repository } }, head: { ref: p.headBranch, sha, repo: { full_name: repository } } });
  const client = new GitHub(p, () => ({ ok: true, stdout: JSON.stringify([raw('another/repo'), raw(p.repository)]) }));
  assert.equal(client.matches().length, 1);
});
test('partial CLI failure observes created PR, never retries, and journal prevents duplicate publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-pr-test-'));
  try {
    const p = plan(), client = fake(p, { partial: true }), path = join(dir, 'journal.json');
    assert.equal(publish(p, body, path, client).status, 'verified');
    assert.equal(client.writes, 1);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(journal.attempts[0].ok, false);
    assert.equal(reconcile(journal, client).status, 'verified');
    assert.equal(client.writes, 1);
    assert.throws(() => publish(p, body, path, client), /Journal already exists/);
    assert.equal(client.writes, 1);
  } finally { rmSync(dir, { recursive: true }); }
});
test('existing PR draft transition edits once then verifies ready result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-pr-test-'));
  try {
    const p = plan(), client = fake(p, { initial: { ...pr(p), draft: true } });
    assert.equal(publish(p, body, join(dir, 'journal.json'), client).status, 'verified');
    assert.equal(client.writes, 2);
    assert.equal(client.commands.some(x => x[1] === 'create'), false);
  } finally { rmSync(dir, { recursive: true }); }
});
test('verification detects wrong revision and changed prose; optional missing screenshots retain text result', () => {
  const p = plan();
  assert.equal(verify(p, body, { ...pr(p), headSha: 'b'.repeat(40) }).status, 'mismatch');
  assert.equal(verify(p, body, { ...pr(p), body: body.replace('Handle input.', 'Other claim.') }).status, 'mismatch');
  const result = verify(p, body, pr(p), { defaultBranch: 'release', attachments: [{ path: '/missing.png', alt: 'Screen', omitted: 'File missing' }] });
  assert.equal(result.status, 'verified'); assert.equal(result.attachments[0].omitted, 'File missing'); assert.equal(result.automaticClosure, false);
});
test('no diff or a changed pushed revision prevents writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-pr-test-'));
  try {
    const p = plan(), client = fake(p);
    client.comparison = () => ({ files: [] });
    assert.equal(publish(p, body, join(dir, 'empty.json'), client).status, 'stopped');
    assert.equal(client.writes, 0);
    client.remoteHead = () => 'b'.repeat(40);
    assert.throws(() => publish(p, body, join(dir, 'changed.json'), client), /not pushed/);
    assert.equal(client.writes, 0);
  } finally { rmSync(dir, { recursive: true }); }
});
test('read failure after a write retains an attempt journal and blocks another publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-pr-test-'));
  try {
    const p = plan(), client = fake(p), matches = client.matches, path = join(dir, 'journal.json');
    client.matches = () => { if (client.writes) throw Error('network unavailable'); return matches(); };
    assert.throws(() => publish(p, body, path, client), /network unavailable/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).attempts.length, 1);
    assert.throws(() => publish(p, body, path, client), /Journal already exists/);
    assert.equal(client.writes, 1);
    client.matches = matches;
    assert.equal(reconcile(JSON.parse(readFileSync(path, 'utf8')), client).status, 'verified');
  } finally { rmSync(dir, { recursive: true }); }
});
