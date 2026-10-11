import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { absolute, check, hash, run, same, version, result } from './common.mjs';

function git(repo, args) {
  const r = run('git', ['--no-optional-locks', '-C', repo, ...args]);
  check(r.ok, `Cannot collect workspace: git ${args[0]}`); return r.stdout;
}
export function snapshot(repo, { originalRef = null, repairLedger = [], inventory = [] } = {}) {
  absolute(repo);
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const names = new Set([...git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean), ...inventory]);
  const files = [...names].sort().map(path => {
    check(!path.startsWith('/') && !path.split('/').includes('..'), 'Invalid inventory path');
    try {
      const full = join(root, path), stat = lstatSync(full);
      if (stat.isDirectory()) {
        check(git(full, ['rev-parse','--show-toplevel']).trim() === full, 'Inventory directories must be initialized submodule repositories; list ignored files individually');
        const nested = snapshot(full); return { path, kind: 'repository', mode: stat.mode & 0o777, hash: nested.ref, baseline: nested };
      }
      return { path, kind: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other', mode: stat.mode & 0o777,
        hash: stat.isSymbolicLink() ? hash(readlinkSync(full)) : stat.isFile() ? hash(readFileSync(full)) : null };
    } catch (e) { if (e.code === 'ENOENT') return { path, kind: 'missing' }; throw e; }
  });
  const data = { version: 1, repo: root, head: git(root, ['rev-parse', 'HEAD']).trim(),
    branch: git(root, ['branch', '--show-current']).trim() || null,
    status: git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    staged: git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached']),
    unstaged: git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary']), files, inventory,
    originalRef, repairLedger };
  return { ...data, ref: hash(data) };
}
export function validateBaseline(baseline) {
  version(baseline); const { ref, ...data } = baseline;
  check(ref === hash(data), 'Baseline reference mismatch');
  check(/^[a-f\d]{40,64}$/i.test(baseline.head) && Array.isArray(baseline.files), 'Invalid baseline');
}
export function compare(baseline, observed = snapshot(baseline.repo, baseline)) {
  validateBaseline(baseline); validateBaseline(observed);
  const errors = ['repo', 'head', 'branch', 'status', 'staged', 'unstaged', 'files', 'inventory', 'originalRef', 'repairLedger']
    .filter(key => !same(baseline[key], observed[key])).map(key => `Workspace ${key} changed`);
  return result(errors.length ? 'blocked' : 'verified', errors, { baselineRef: baseline.ref, observedRef: observed.ref });
}
