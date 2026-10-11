import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export function check(ok, message) { if (!ok) throw new Error(message); }
export function object(value, name) { check(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${name}`); return value; }
export function version(value) { object(value, 'input'); check(value.version === 1, 'Unsupported version'); }
export function nonempty(value, name) { check(typeof value === 'string' && value.trim(), `Missing ${name}`); return value; }
export function sha(value) { check(typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value), 'Invalid exact SHA'); return value; }
export function absolute(value) { check(typeof value === 'string' && value.startsWith('/'), 'Expected absolute path'); return value; }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function load(path, initial) { try { return readJson(path); } catch (e) { if (e.code === 'ENOENT') return structuredClone(initial); throw e; } }
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function lock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(`${path}.lock`); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { writeFileSync(`${path}.lock/owner.json`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
  catch (e) { rmSync(`${path}.lock`, { recursive: true, force: true }); throw e; }
  return () => rmSync(`${path}.lock`, { recursive: true });
}
export function cli(meta, help, run) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(meta)) return;
  if (process.argv.includes('--help')) { process.stdout.write(`${help}\n`); return; }
  Promise.resolve().then(() => run(process.argv.slice(2))).then(result => {
    process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`);
    if (result?.complete === false || result?.status === 'blocked' || result?.status === 'uncertain') process.exitCode = 2;
  }).catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
