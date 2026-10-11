import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function run(command, args, allowFailure = false) {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (!allowFailure) assert(r.status === 0, `${command} failed: ${r.stderr.trim() || r.stdout.trim() || r.signal || r.status}`);
  return r;
}
export function json(command, args) {
  const result = JSON.parse(run(command, args).stdout);
  assert(!result?.errors?.length, `GraphQL error: ${JSON.stringify(result.errors)}`);
  return result;
}
export const git = (...args) => run('git', args).stdout.trim();
export const head = () => git('rev-parse', 'HEAD');
export function repoFromUrl(value) {
  const text = String(value ?? '');
  const m = text.match(/^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?)([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    ?? text.match(/^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}
export function prIdentity(url) {
  const m = String(url).match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  assert(m, 'Expected an exact GitHub PR URL');
  return { host: m[1].toLowerCase(), repository: `${m[1]}/${m[2]}/${m[3]}`.toLowerCase(), slug: `${m[2]}/${m[3]}`, number: Number(m[4]) };
}
export const api = (host, endpoint) => json('gh', ['api', '--hostname', host, endpoint]);
export function readPR(pr) {
  const { url } = json('gh', ['pr', 'view', ...(pr ? [String(pr)] : []), '--json', 'url']);
  const identity = prIdentity(url);
  const data = api(identity.host, `repos/${identity.slug}/pulls/${identity.number}`);
  assert(data.html_url === url && data.head?.repo?.full_name && data.base?.repo?.full_name && data.head.sha && data.base.sha, 'Incomplete or mismatched PR identity');
  assert(`${identity.host}/${data.base.repo.full_name}`.toLowerCase() === identity.repository, 'PR base repository mismatch');
  return { url, ...identity, state: data.state.toUpperCase(), headBranch: data.head.ref, headSha: data.head.sha,
    headRepository: `${identity.host}/${data.head.repo.full_name}`.toLowerCase(), baseBranch: data.base.ref,
    baseSha: data.base.sha, headSlug: data.head.repo.full_name };
}
export function readChecks(pr) {
  const r = run('gh', ['pr', 'checks', pr, '--json', 'bucket,completedAt,description,link,name,startedAt,state,workflow'], true);
  let items;
  try { items = JSON.parse(r.stdout); assert(Array.isArray(items) && items.every(x => x && typeof x === 'object' && typeof x.name === 'string' && typeof x.bucket === 'string'), 'Expected a check array'); }
  catch (error) { return { items: [], error: r.stderr.trim() || `Could not parse gh pr checks JSON: ${error.message}`, complete: false, exitCode: r.status }; }
  // gh uses 1 for failed checks and 8 for pending checks. Other errors remain incomplete.
  const complete = r.status === 0 || (r.status === 1 && items.some(isFailingCheck)) || (r.status === 8 && items.some(x => x.bucket === 'pending'));
  return { items, error: complete ? null : r.stderr.trim() || `Unexpected gh pr checks exit ${r.status}`, complete, exitCode: r.status };
}
export function isFailingCheck(x) {
  return ['fail', 'failing', 'cancel'].includes(String(x.bucket).toLowerCase()) || ['failure', 'failed', 'error', 'cancelled', 'timed_out'].includes(String(x.state).toLowerCase());
}
export function canonicalPath(path) {
  path = resolve(path);
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), path.slice(dirname(path).length + 1));
}
export function outsideSource(path) {
  const file = canonicalPath(path);
  const root = canonicalPath(git('rev-parse', '--show-toplevel'));
  const common = canonicalPath(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (r !== '..' && !r.startsWith('../') && !r.startsWith('/')); };
  assert(!inside(root, file) || inside(common, file), 'Store repair artifacts outside source, preferably under the Git common directory');
  return file;
}
export const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
export function saveJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
export function withSessionLock(file, fn) {
  file = outsideSource(file);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Session locked: ${lock}; reconcile the previous process before removing this lock`); throw e; }
  try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 }); return fn(file); }
  finally { rmSync(lock, { recursive: true }); }
}
export function parseOptions(args, allowed) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h') args[i] = '--help';
    assert(args[i].startsWith('--'), `Unexpected argument: ${args[i]}`);
    const [key, ...value] = args[i].slice(2).split('=');
    assert(allowed.includes(key) && !Object.hasOwn(o, key), `Unknown or duplicate option: --${key}`);
    if (['help', 'json'].includes(key)) { assert(!value.length, `--${key} takes no value`); o[key] = true; }
    else { o[key] = value.length ? value.join('=') : args[++i]; assert(o[key] && !o[key].startsWith('--'), `Missing --${key} value`); }
  }
  return o;
}
