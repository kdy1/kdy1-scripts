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

test('sync-base fast-forwards a clean main and leaves an existing stack anchor unchanged', () => fixture(({ source, writer, initial }) => {
  git(source, 'branch', 'pinned-stack-base', initial);
  const next = commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');

  const result = syncBase(input(source));
  assert.equal(result.baseSha, next);
  assert.equal(result.previousSha, initial);
  assert.equal(result.updated, true);
  assert.equal(git(source, 'rev-parse', 'main'), next);
  assert.equal(git(source, 'rev-parse', 'pinned-stack-base'), initial);
  assert.equal(git(source, 'status', '--porcelain'), '');

  const again = syncBase(input(source));
  assert.equal(again.updated, false);
  assert.equal(again.baseSha, next);
}));

test('sync-base leaves a dirty source checkout unchanged', () => fixture(({ source, writer, initial }) => {
  commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');
  writeFileSync(join(source, 'untracked.txt'), 'work in progress');
  assert.throws(() => syncBase(input(source)), /must be clean/);
  assert.equal(git(source, 'rev-parse', 'main'), initial);
}));

test('sync-base leaves a checkout on another branch unchanged', () => fixture(({ source, writer, initial }) => {
  commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');
  git(source, 'switch', '-c', 'other-work');
  assert.throws(() => syncBase(input(source)), /must be on main/);
  assert.equal(git(source, 'rev-parse', 'main'), initial);
}));

test('sync-base leaves a diverged main unchanged', () => fixture(({ source, writer }) => {
  const local = commit(source, 'local-change');
  commit(writer, 'remote-change');
  git(writer, 'push', 'origin', 'main');
  assert.throws(() => syncBase(input(source)), /ahead of or diverged/);
  assert.equal(git(source, 'rev-parse', 'main'), local);
}));

test('sync-base leaves a main ahead of origin unchanged', () => fixture(({ source }) => {
  const local = commit(source, 'local-change');
  assert.throws(() => syncBase(input(source)), /ahead of or diverged/);
  assert.equal(git(source, 'rev-parse', 'main'), local);
}));
