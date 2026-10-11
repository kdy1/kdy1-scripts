import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export function check(ok, message) { if (!ok) throw new Error(message); }
export function run(program, args, options = {}) {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status, error: r.error?.message };
}
export function absolute(path) { check(typeof path === 'string' && isAbsolute(path), 'Expected absolute path'); return path; }
export function readJson(path) { return JSON.parse(readFileSync(absolute(path), 'utf8')); }
export function save(path, value) {
  absolute(path); mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function target(p) {
  check(p?.version === 1, 'Expected version 1');
  check(typeof p.host === 'string' && /^[a-zA-Z0-9.-]+$/.test(p.host), 'Invalid host');
  for (const field of ['repository', 'headRepository']) check(typeof p[field] === 'string' && /^[\w.-]+\/[\w.-]+$/.test(p[field]), `Invalid ${field}`);
  for (const field of ['headBranch', 'baseBranch']) check(typeof p[field] === 'string' && p[field] && !p[field].startsWith('-'), `Invalid ${field}`);
  if (p.prUrl) prNumber(p.prUrl, p);
}
export function prNumber(url, p) {
  const u = new URL(url), match = u.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/);
  check(u.protocol === 'https:' && u.host === p.host && match?.[1] === p.repository && !u.search && !u.hash, 'PR URL target mismatch');
  return Number(match[2]);
}
export function normalize(raw) {
  return { url: raw.html_url, repository: raw.base.repo.full_name, headRepository: raw.head.repo?.full_name ?? null,
    headBranch: raw.head.ref, headSha: raw.head.sha, baseBranch: raw.base.ref,
    state: raw.merged ? 'MERGED' : raw.state.toUpperCase(), draft: raw.draft,
    title: raw.title, body: raw.body ?? '' };
}
export class GitHub {
  constructor(p, transport = run) { target(p); this.p = p; this.transport = transport; }
  command(args) { return this.transport('gh', args, { env: { ...process.env, GH_HOST: this.p.host, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } }); }
  api(endpoint) {
    const r = this.command(['api', '--hostname', this.p.host, '--method', 'GET', endpoint]);
    check(r.ok, `GitHub read failed: ${endpoint}: ${r.stderr || r.error || r.code}`);
    return JSON.parse(r.stdout);
  }
  repository() { return this.api(`repos/${this.p.repository}`); }
  pr(url) { return normalize(this.api(`repos/${this.p.repository}/pulls/${prNumber(url, this.p)}`)); }
  matches() {
    const found = [], owner = this.p.headRepository.split('/')[0];
    for (let page = 1; page <= 100; page++) {
      const items = this.api(`repos/${this.p.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${this.p.headBranch}`)}&per_page=100&page=${page}`);
      check(Array.isArray(items), 'Invalid PR list');
      found.push(...items.map(normalize).filter(x => x.headRepository === this.p.headRepository && x.headBranch === this.p.headBranch));
      if (items.length < 100) return found;
    }
    throw new Error('PR pagination limit reached');
  }
  remoteHead() {
    return this.api(`repos/${this.p.headRepository}/git/ref/heads/${encodeURIComponent(this.p.headBranch)}`).object.sha;
  }
  comparison() {
    return this.api(`repos/${this.p.repository}/compare/${encodeURIComponent(this.p.baseBranch)}...${encodeURIComponent(this.p.headSha)}`);
  }
  issue(repo, number) {
    const issue = this.api(`repos/${repo}/issues/${number}`);
    check(!issue.pull_request && issue.number === number, 'Reference is not an issue'); return issue;
  }
}
export function choose(p, client) {
  const recorded = p.prUrl ? client.pr(p.prUrl) : null;
  if (recorded && recorded.state !== 'OPEN') return { status: 'stopped', pr: recorded, reason: 'Recorded PR is closed or merged' };
  const matches = client.matches();
  check(matches.length <= 1, 'Multiple matching PRs; resolve before publication');
  const pr = recorded ?? matches[0] ?? null;
  if (recorded) check(!matches.length || matches[0].url === recorded.url, 'Recorded PR differs from matching PR');
  if (pr) check(pr.repository === p.repository && pr.headRepository === p.headRepository && pr.headBranch === p.headBranch && pr.baseBranch === p.baseBranch, 'PR identity or base mismatch');
  return { status: 'ready', pr };
}

// Ignore fenced code, including indented fences and longer fence delimiters.
export function proseLines(body) {
  const lines = []; let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) { if (m && m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null; continue; }
    if (m) { fence = { char: m[1][0], length: m[1].length }; continue; }
    if (!/^ {4}|^\t/.test(line)) lines.push(line);
  }
  return lines;
}
export function references(body, repository) {
  return proseLines(body).flatMap(line => {
    const m = line.match(/^ *(Closes|Refs) +(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*) *$/);
    return m ? [{ kind: m[1], repository: m[2] ?? repository, number: Number(m[3]), line: line.trim() }] : [];
  });
}
export function issueLine(issue, repository) {
  check(['closes', 'refs'].includes(issue.kind) && /^[\w.-]+\/[\w.-]+$/.test(issue.repository) && Number.isSafeInteger(issue.number) && issue.number > 0, 'Invalid issue classification');
  return `${issue.kind === 'closes' ? 'Closes' : 'Refs'} ${issue.repository === repository ? '' : issue.repository}#${issue.number}`;
}
export function images(body) { return [...body.matchAll(/!\[[^\]]*\]\([^\s)]+\)/g)].map(m => m[0]); }
export function attachmentImages(body) { return images(body).filter(x => /https:\/\/(?:github\.com\/user-attachments\/assets\/|user-images\.githubusercontent\.com\/)/.test(x)); }
export function content(p, body) {
  target(p); const errors = [];
  check(typeof p.title === 'string' && typeof body === 'string' && body.trim(), 'Missing title/body');
  check(typeof p.draft === 'boolean' && typeof p.language === 'string' && p.language.trim(), 'Explicit draft and language required');
  check(Array.isArray(p.issues) && Array.isArray(p.requiredText) && Array.isArray(p.attachments), 'Explicit issues, requiredText, and attachments arrays required');
  check(/^[a-f0-9]{40,64}$/.test(p.headSha ?? ''), 'Expected published head SHA');
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: [^\r\n]+$/.test(p.title)) errors.push('Invalid Conventional Commits title');
  const refs = references(body, p.repository), seen = new Set();
  for (const ref of refs) { const key = `${ref.repository}#${ref.number}`; if (seen.has(key)) errors.push(`Duplicate or conflicting reference: ${key}`); seen.add(key); }
  const classified = new Set();
  for (const issue of p.issues) {
    const expected = issueLine(issue, p.repository), key = `${issue.repository}#${issue.number}`;
    check(!classified.has(key), 'Duplicate manifest issue'); classified.add(key);
    if (!refs.some(x => x.line === expected)) errors.push(`Missing standalone ${expected}`);
  }
  for (const fixed of p.requiredText) { check(typeof fixed === 'string' && fixed, 'Invalid requiredText'); if (!body.includes(fixed)) errors.push(`Missing required text: ${fixed}`); }
  if (/(?:file:\/\/|\/Users\/|\/home\/|[A-Za-z]:\\)/.test(body)) errors.push('Local path in published body');
  for (const image of p.attachments) { absolute(image.path); check(!image.path.includes('#'), 'Attachment paths cannot contain #'); check(typeof image.alt === 'string' && image.alt.trim() && !/[\r\n\[\]#]/.test(image.alt), 'Invalid attachment alt'); }
  return { status: errors.length ? 'mismatch' : 'verified', errors };
}
export function preserve(p, before, body) {
  const errors = [];
  for (const image of images(before)) if (!body.includes(image)) errors.push('Existing image removed or changed');
  for (const ref of references(before, p.repository)) {
    if (p.issues.some(x => x.repository === ref.repository && x.number === ref.number)) continue;
    if (!references(body, p.repository).some(x => x.line === ref.line)) errors.push(`Existing reference removed: ${ref.line}`);
  }
  return errors;
}
