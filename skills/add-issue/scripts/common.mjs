import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function check(ok, message) { if (!ok) throw new Error(message); }
export function text(value, name) { check(typeof value === 'string' && value.trim(), `Missing ${name}`); return value; }
export function absolute(value) { check(isAbsolute(text(value, 'absolute path')), 'Expected absolute path'); return value; }
export function version(value) { check(value?.version === 1, 'Unsupported or missing version'); }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  check(value !== undefined && Number.isFinite(value) || value === null || typeof value === 'string' || typeof value === 'boolean', 'Non-JSON value');
  return JSON.stringify(value);
}
export function hash(value) { return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex'); }
export function same(a, b) { return canonical(a) === canonical(b); }
export function result(status, errors = [], extra = {}) { return { version: 1, status, complete: status === 'verified', errors, ...extra }; }
export function readJson(path) { return JSON.parse(readFileSync(absolute(path), 'utf8')); }
export function save(path, value) {
  absolute(path); mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function lock(path) {
  absolute(path); mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(`${path}.lock`); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  return () => rmSync(`${path}.lock`, { recursive: true });
}
function physical(path) {
  let current = resolve(path), suffix = [];
  for (;;) {
    try { return resolve(realpathSync(current), ...suffix); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const parent = dirname(current); check(parent !== current, 'Cannot resolve artifact path'); suffix.unshift(current.slice(parent.length + (parent === '/' ? 0 : 1))); current = parent; }
  }
}
export function outside(path, repo) { const rel = relative(physical(repo), physical(absolute(path))); check(rel.startsWith('..' + '/') || isAbsolute(rel), 'Private artifacts must be outside the investigated repository'); }
export function run(program, args, options = {}) {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options });
  const failureCode = r.error?.code === 'ETIMEDOUT' ? 'timeout' : /rate limit/i.test(r.stderr ?? '') ? 'rate-limit' : r.status !== 0 ? 'command-failed' : null;
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', code: r.status, error: r.error?.code ?? null, httpStatus: Number(r.stderr?.match(/HTTP (\d{3})/)?.[1]) || null, failureCode };
}
