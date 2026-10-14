import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPr } from '../stack-coordination.mjs';

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
  url = canonicalPr(url);
  const m = String(url).match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  assert(m, 'Expected an exact GitHub PR URL');
  return { url, host: m[1].toLowerCase(), repository: `${m[1]}/${m[2]}/${m[3]}`.toLowerCase(), slug: `${m[2]}/${m[3]}`, number: Number(m[4]) };
}
export const api = (host, endpoint) => json('gh', ['api', '--hostname', host, endpoint]);
export function readPR(pr) {
  const resolved = json('gh', ['pr', 'view', ...(pr ? [String(pr)] : []), '--json', 'url']);
  const identity = prIdentity(resolved.url);
  const url = identity.url;
  const data = api(identity.host, `repos/${identity.slug}/pulls/${identity.number}`);
  assert(prIdentity(data.html_url).url === url && data.head?.repo?.full_name && data.base?.repo?.full_name && /^[a-f0-9]{40,64}$/.test(data.head.sha ?? '') && /^[a-f0-9]{40,64}$/.test(data.base.sha ?? '') && typeof data.head.ref === 'string' && typeof data.base.ref === 'string' && ['open', 'closed'].includes(data.state), 'Incomplete or mismatched PR identity');
  assert(`${identity.host}/${data.base.repo.full_name}`.toLowerCase() === identity.repository, 'PR base repository mismatch');
  return { url, ...identity, state: data.state.toUpperCase(), headBranch: data.head.ref, headSha: data.head.sha,
    headRepository: `${identity.host}/${data.head.repo.full_name}`.toLowerCase(), baseBranch: data.base.ref,
    baseSha: data.base.sha, headSlug: data.head.repo.full_name };
}
export function readChecks(pr) {
  try {
    const identity = /^\d+$/.test(String(pr)) ? prIdentity(json('gh', ['pr', 'view', String(pr), '--json', 'url']).url) : prIdentity(pr);
    const endpoint = `repos/${identity.slug}/pulls/${identity.number}`;
    const before = api(identity.host, endpoint);
    assert(prIdentity(before.html_url).url === identity.url && /^[a-f0-9]{40}$/i.test(before.head?.sha ?? '') && /^[a-f0-9]{40}$/i.test(before.base?.sha ?? ''), 'Incomplete PR head or base before checks');
    const sha = before.head.sha;
    const runs = [], statuses = [];
    for (let page = 1, total = null; ; page++) {
      assert(page <= 10000, 'Check-run pagination limit exceeded');
      const data = api(identity.host, `repos/${identity.slug}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
      assert(Number.isSafeInteger(data.total_count) && Array.isArray(data.check_runs), 'Incomplete check-run page');
      assert(total === null || total === data.total_count, 'Check-run total changed during pagination');
      total = data.total_count;
      assert(runs.length + data.check_runs.length <= total, 'Check-run page exceeds reported total');
      runs.push(...data.check_runs);
      if (runs.length === total) break;
      assert(data.check_runs.length === 100, 'Missing check-run page');
    }
    for (let page = 1; ; page++) {
      assert(page <= 10000, 'Status pagination limit exceeded');
      const data = api(identity.host, `repos/${identity.slug}/statuses/${sha}?per_page=100&page=${page}`);
      assert(Array.isArray(data), 'Incomplete commit-status page');
      statuses.push(...data);
      if (data.length < 100) break;
    }
    const after = api(identity.host, endpoint);
    assert(prIdentity(after.html_url).url === identity.url && after.head?.sha === sha && after.base?.sha === before.base?.sha, 'PR head or base changed while reading checks');
    const latestRuns = new Map();
    for (const run of runs) {
      assert(typeof run.name === 'string' && run.name && Number.isSafeInteger(run.id) && typeof run.status === 'string', 'Incomplete check run');
      const key = `${run.app?.id ?? 'unknown'}:${run.name}`;
      if (!latestRuns.has(key) || latestRuns.get(key).id < run.id) latestRuns.set(key, run);
    }
    const latestStatuses = new Map();
    for (const status of statuses) {
      assert(typeof status.context === 'string' && status.context && typeof status.state === 'string'
        && Number.isSafeInteger(status.id) && Number.isFinite(Date.parse(status.created_at)), 'Incomplete commit status');
      const prior = latestStatuses.get(status.context);
      if (!prior || Date.parse(status.created_at) > Date.parse(prior.created_at) || (status.created_at === prior.created_at && status.id > prior.id)) latestStatuses.set(status.context, status);
    }
    const items = [
      ...[...latestRuns.values()].map(run => {
        const state = run.status === 'completed' ? run.conclusion : run.status;
        assert(typeof state === 'string' && state, 'Completed check run lacks a conclusion');
        return { name: run.name, state: state.toUpperCase(), bucket: checkBucket(state), link: run.details_url ?? run.html_url ?? null,
          workflow: null, startedAt: run.started_at ?? null, completedAt: run.completed_at ?? null, description: run.output?.title ?? null };
      }),
      ...[...latestStatuses.values()].map(status => ({ name: status.context, state: status.state.toUpperCase(), bucket: checkBucket(status.state),
        link: status.target_url ?? null, workflow: null, startedAt: status.created_at ?? null, completedAt: status.updated_at ?? null, description: status.description ?? null })),
    ];
    const exitCode = items.some(isFailingCheck) ? 1 : items.some(x => x.bucket === 'pending') ? 8 : 0;
    return { items, error: null, complete: true, exitCode };
  } catch (error) { return { items: [], error: error.message, complete: false, exitCode: 1 }; }
}
function checkBucket(state) {
  if (['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(state)) return 'fail';
  if (['queued', 'pending', 'in_progress', 'waiting', 'requested'].includes(state)) return 'pending';
  if (['skipped', 'neutral'].includes(state)) return 'skipping';
  if (state === 'success') return 'pass';
  throw new Error(`Unknown check state: ${state}`);
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
