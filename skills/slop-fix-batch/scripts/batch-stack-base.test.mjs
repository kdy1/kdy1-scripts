import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBase, runCommand } from './batch-stack.mjs';

function git(checkout, ...args) { return runCommand('git', args, checkout); }
function commit(checkout, name) {
  writeFileSync(join(checkout, `${name}.txt`), name);
  git(checkout, 'add', `${name}.txt`);
  git(checkout, 'commit', '-m', name);
  return git(checkout, 'rev-parse', 'HEAD');
}
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-stack-base-'));
  try {
    const remote = join(dir, 'remote.git'), source = join(dir, 'source'), writer = join(dir, 'writer');
    runCommand('git', ['init', '--bare', remote], dir);
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    runCommand('git', ['clone', remote, source], dir);
    git(source, 'switch', '-c', 'main');
    for (const checkout of [source]) {
      git(checkout, 'config', 'user.name', 'Batch Test');
      git(checkout, 'config', 'user.email', 'batch@example.test');
    }
    const initial = commit(source, 'initial');
    git(source, 'push', '-u', 'origin', 'main');
    runCommand('git', ['clone', remote, writer], dir);
    git(writer, 'config', 'user.name', 'Batch Test');
    git(writer, 'config', 'user.email', 'batch@example.test');
    return fn({ source, writer, initial });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const input = source => ({ version: 1, checkout: source, remote: 'origin', targetBranch: 'main' });

// The user's checkout must keep its branch, HEAD, local main, index and files.
function snapshot(source) {
  return {
    branch: git(source, 'branch', '--show-current'),
    head: git(source, 'rev-parse', 'HEAD'),
    main: git(source, 'rev-parse', 'refs/heads/main'),
    status: git(source, 'status', '--porcelain'),
  };
}

test('sync-base pins fetched main without moving local main or an existing stack anchor', () => fixture(({ source, writer, initial }) => {
  git(source, 'branch', 'pinned-stack-base', initial);
  const next = commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');
  const before = snapshot(source);

  const result = syncBase(input(source));
  assert.equal(result.baseSha, next);
  assert.equal(result.remoteRef, 'refs/remotes/origin/main');
  assert.equal(git(source, 'rev-parse', 'origin/main'), next);
  assert.deepEqual(snapshot(source), before);
  assert.equal(before.main, initial);
  assert.equal(git(source, 'rev-parse', 'pinned-stack-base'), initial);
  assert.equal(syncBase(input(source)).baseSha, next);
}));

test('sync-base leaves a dirty checkout on another branch untouched', () => fixture(({ source, writer }) => {
  const next = commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');
  git(source, 'switch', '-c', 'other-work');
  writeFileSync(join(source, 'untracked.txt'), 'work in progress');
  writeFileSync(join(source, 'initial.txt'), 'modified');
  const before = snapshot(source);

  assert.equal(syncBase(input(source)).baseSha, next);
  assert.deepEqual(snapshot(source), before);
}));

test('sync-base pins fetched main when local main is ahead or diverged', () => fixture(({ source, writer }) => {
  const local = commit(source, 'local-change');
  const next = commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');

  assert.equal(syncBase(input(source)).baseSha, next);
  assert.equal(git(source, 'rev-parse', 'main'), local);
  assert.equal(git(source, 'status', '--porcelain'), '');
}));

test('sync-base pins another target branch without checking it out', () => fixture(({ source, writer }) => {
  git(writer, 'switch', '-c', 'release');
  const release = commit(writer, 'release-change');
  git(writer, 'push', 'origin', 'release');
  const before = snapshot(source);

  const result = syncBase({ ...input(source), targetBranch: 'release' });
  assert.equal(result.baseSha, release);
  assert.equal(result.remoteRef, 'refs/remotes/origin/release');
  assert.deepEqual(snapshot(source), before);
  assert.throws(() => git(source, 'rev-parse', '--verify', 'refs/heads/release'));
}));

test('sync-base rejects an invalid target branch before fetching', () => fixture(({ source }) => {
  for (const targetBranch of ['bad..name', '-main', 'main.lock', 'a/.b', 'main:other'])
    assert.throws(() => syncBase({ ...input(source), targetBranch }), /Invalid target branch/);
  assert.equal(git(source, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main'), git(source, 'rev-parse', 'main'));
}));
