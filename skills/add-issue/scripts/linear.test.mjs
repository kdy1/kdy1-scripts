import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './common.mjs';
import { snapshot } from './workspace.mjs';
import { Linear, validateLinearPayload, record, refresh, collect, preflight, normalizeText } from './linear.mjs';
import { Keychain, SERVICE, resolveToken } from './linear-auth.mjs';
import { auth, dispatch } from './linear-issue.mjs';

const TEAM = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const LABEL = '33333333-3333-4333-8333-333333333333';
const OTHER = '99999999-9999-4999-8999-999999999999';
const KEY = 'lin_api_' + 'x'.repeat(40);
const perm = { confirmed: true, evidence: 'Verified Linear member capability', credentialEvidence: 'Personal API key with write scope verified without exposing it' };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class FakeLinear {
  constructor() {
    this.issues = new Map(); this.comments = new Map(); this.next = 1; this.calls = []; this.uploads = 0;
    this.labels = new Map([[LABEL, { id: LABEL, name: 'bug', archivedAt: null, isGroup: false, team: null, description: '', parent: null }]]);
    this.rewrite = s => s;
  }
  addIssue(fields = {}) {
    const n = this.next++, id = fields.id ?? uuid(1000 + n);
    const x = { id, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}/slug`, title: 'Existing', description: 'existing body', priority: 0, estimate: null, archivedAt: null, trashed: false,
      creator: { id: VIEWER }, state: { id: uuid(1), type: 'backlog' }, team: { id: TEAM, key: 'ENG' }, project: null, cycle: null, assignee: null, labelIds: [], ...fields };
    this.issues.set(id, x); return x;
  }
  find(id) { return this.issues.get(id) ?? [...this.issues.values()].find(x => x.identifier === id) ?? null; }
  fetch = async (url, options) => {
    const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    const fail = message => ({ ok: true, status: 200, json: async () => ({ errors: [{ message }] }) });
    if (url.startsWith('https://storage.test/')) { this.calls.push({ op: 'put', headers: options.headers }); return { ok: true, status: 200, json: async () => ({}) }; }
    const { query, variables: v } = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, KEY);
    const op = ['viewer', 'issueCreate', 'issueUpdate', 'commentCreate', 'fileUpload', 'issuePriorityValues', 'issueLabels', 'issueLabel(', 'teams(first:100', 'teams(', 'comments(', 'comment(', 'issues(first', 'issue(']
      .find(name => query.includes(name)).replace(/\($/, '');
    this.calls.push({ op, v });
    if (this.authFail) return { ok: false, status: 401, json: async () => ({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }) };
    if (op === 'viewer') return ok({ viewer: { id: VIEWER, name: 'Tester', email: 't@example.invalid', active: true }, organization: { id: uuid(9), urlKey: 'acme', name: 'Acme' } });
    if (op === 'teams(first:100') return ok({ teams: { nodes: [{ id: TEAM, key: 'ENG', name: 'Engineering' }], pageInfo: { hasNextPage: false } } });
    if (op === 'teams') return ok({ teams: { nodes: v.key === 'ENG' ? [{ id: TEAM, key: 'ENG', name: 'Engineering', archivedAt: null, retiredAt: null, issueEstimationType: 'fibonacci', issueEstimationAllowZero: false, issueEstimationExtended: false }] : [] } });
    if (op === 'issuePriorityValues') return ok({ issuePriorityValues: [0, 1, 2, 3, 4].map(priority => ({ priority, label: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][priority] })) });
    if (op === 'issueLabel') return this.labels.has(v.id) ? ok({ issueLabel: this.labels.get(v.id) }) : fail('Entity not found: IssueLabel');
    if (op === 'comments') { const x = this.find(v.id); return ok({ issue: { comments: { nodes: [...this.comments.values()].filter(c => c.issue.id === x.id), pageInfo: { hasNextPage: false } } } }); }
    if (op === 'comment') return this.comments.has(v.id) ? ok({ comment: this.comments.get(v.id) }) : fail('Entity not found: Comment');
    if (op === 'issues(first') {
      const terms = v.filter.or.filter(x => x.title).map(x => x.title.containsIgnoreCase.toLowerCase());
      const nodes = [...this.issues.values()].filter(x => !['completed', 'canceled'].includes(x.state.type) && terms.some(t => x.title.toLowerCase().includes(t) || x.description.toLowerCase().includes(t)));
      return ok({ issues: { nodes: nodes.slice(0, v.first), pageInfo: { hasNextPage: nodes.length > v.first } } });
    }
    if (op === 'issue') { const x = this.find(v.id); return x ? ok({ issue: x }) : fail('Entity not found: Issue'); }
    if (op === 'fileUpload') { const n = ++this.uploads; return ok({ fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.test/put/${n}`, assetUrl: `https://uploads.linear.app/acme/asset-${n}`, headers: [{ key: 'x-goog-meta', value: 'm' }] } } }); }
    if (op === 'issueCreate') {
      if (this.rejectNext) { this.rejectNext = false; return fail('Argument Validation Error'); }
      const i = v.input; assert.ok(!this.issues.has(i.id), 'client ID reused for a second issue');
      const x = this.addIssue({ id: i.id, title: i.title, description: this.rewrite(i.description), labelIds: i.labelIds ?? [], priority: i.priority ?? 0 });
      if (this.loseNext) { this.loseNext = false; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
      return ok({ issueCreate: { success: true, issue: { id: x.id, url: x.url } } });
    }
    if (op === 'issueUpdate') {
      const x = this.find(v.id);
      if (v.input.addedLabelIds) x.labelIds = [...new Set([...x.labelIds, ...v.input.addedLabelIds])];
      if (v.input.priority !== undefined) x.priority = v.input.priority;
      return ok({ issueUpdate: { success: true } });
    }
    if (op === 'commentCreate') {
      const i = v.input, x = this.find(i.issueId);
      const c = { id: i.id, url: `${x.url}#comment-${i.id.slice(0, 8)}`, body: i.body, user: { id: VIEWER }, issue: { id: x.id } };
      this.comments.set(c.id, c); return ok({ commentCreate: { success: true, comment: { id: c.id, url: c.url } } });
    }
    throw new Error(`Unhandled fake query ${op}`);
  };
  count(op) { return this.calls.filter(c => c.op === op).length; }
}

function git(repo, ...args) { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'linear-test-')), repo = join(dir, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(repo, 'init', '--quiet'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'a'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '--quiet', '-m', 'init');
  const base = snapshot(repo);
  const c = { id: 'cand', classification: 'Task', readiness: 'ready', revision: base.head, evidence: 'Evidence at revision', environment: 'local',
    authorization: { kind: 'human', origin: 'current chat', request: 'Record on Linear', context: 'Direct human invocation' },
    restrictions: { draftOnly: false, diagnosisOnly: false, noRepair: false, noImplementation: true, noCodeChanges: true },
    workspace: { original: base, baseline: base, cleanupVerified: true }, logs: 'Not applicable', runtime: 'Not applicable',
    action: 'new issue', issueUrl: null, title: 'cli: keep flags stable', body: '## Summary\n* first point\n* second point', comment: '',
    allowedActions: ['new issue'], duplicate: { terms: ['flags stable'], limit: 20, complete: true, issues: [], evidence: 'No open issue covers this' },
    metadata: [], omissions: [], recordPermission: perm, images: [], noApprovedImages: true, ...overrides };
  const payload = { version: 1, tracker: 'linear', runId: 'run', target: { workspace: 'acme', team: 'ENG', teamId: TEAM }, account: VIEWER, candidates: [c] };
  const context = { mode: 'default', trustedAuthorization: true, recordingAuthorized: true, evidence: 'Trusted session', recordPermission: perm, permissions: { label: perm, priority: perm } };
  return { dir, repo, c, payload, context, statePath: join(dir, 'private', 'ledger.json') };
}
const label = (overrides = {}) => ({ id: 'label', kind: 'label', name: 'bug', value: LABEL, observed: false, definition: { id: LABEL, name: 'bug', teamId: null }, required: false, overwrite: false, rationale: 'Confirmed defect', permission: perm, omissionPolicy: 'skip-on-loss-or-conflict', ...overrides });
const priority = (overrides = {}) => ({ id: 'priority', kind: 'priority', name: 'Priority', value: 2, observed: null, definition: { name: 'Priority', values: [0, 1, 2, 3, 4].map(p => ({ priority: p, label: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][p] })) }, required: false, overwrite: false, rationale: 'Blocks releases', permission: perm, omissionPolicy: 'skip-on-loss-or-conflict', ...overrides });

test('validates the Linear payload contract', t => {
  const { payload, c } = setup(t);
  assert.match(validateLinearPayload(payload).payloadHash, /^[a-f\d]{64}$/);
  const bad = structuredClone(payload); bad.candidates[0].authorization = { ...c.authorization, kind: 'collect-review', runId: 'r', delegation: 'd', scope: 's' }; bad.candidates[0].classification = 'Bug';
  assert.throws(() => validateLinearPayload(bad), /Collect Review/);
  const other = structuredClone(payload); other.candidates[0].action = 'existing issue'; other.candidates[0].body = ''; other.candidates[0].allowedActions = ['existing issue']; other.candidates[0].issueUrl = 'https://linear.app/acme/issue/OPS-1/x';
  assert.throws(() => validateLinearPayload(other), /another team/);
  const observed = structuredClone(payload); observed.candidates[0].metadata = [label({ observed: true })]; observed.candidates[0].allowedActions.push('metadata:label');
  assert.throws(() => validateLinearPayload(observed), /empty baseline/);
  const bareTerms = structuredClone(payload); bareTerms.candidates[0].duplicate.terms = [];
  assert.throws(() => validateLinearPayload(bareTerms), /duplicate terms/);
});

test('creates one issue with metadata and an uploaded image, and never repeats it', async t => {
  const s = setup(t);
  const image = join(s.dir, 'shot.png'); writeFileSync(image, 'png-bytes');
  s.c.metadata = [label(), priority()]; s.c.allowedActions.push('metadata:label', 'metadata:priority', 'image:shot');
  s.c.images = [{ id: 'shot', path: image, sha256: hash(readFileSync(image)), approval: 'Approved in chat', surface: 'CLI', viewport: 'n/a', state: 'error', caption: 'Error output', provenance: 'Local run', generated: false, destination: 'body' }];
  s.c.noApprovedImages = false;
  const fake = new FakeLinear(); fake.rewrite = d => d.replaceAll('* ', '- ');
  const client = new Linear({ token: KEY, fetch: fake.fetch });
  const first = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, client);
  assert.equal(first.status, 'verified', first.errors.join('\n'));
  const issue = [...fake.issues.values()][0];
  assert.deepEqual(issue.labelIds, [LABEL]); assert.equal(issue.priority, 2);
  assert.match(issue.description, /!\[Error output\]\(https:\/\/uploads\.linear\.app\/acme\/asset-1\)/);
  assert.ok(!issue.description.includes(image), 'local path leaked');
  assert.deepEqual(first.outcomes[0].verification.attachments, { shot: 'https://uploads.linear.app/acme/asset-1' });
  const again = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, client);
  assert.equal(again.status, 'verified'); assert.equal(fake.count('issueCreate'), 1); assert.equal(fake.issues.size, 1);
});

test('reconciles a lost creation response by its client ID', async t => {
  const s = setup(t); const fake = new FakeLinear(); fake.loseNext = true;
  const result = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, new Linear({ token: KEY, fetch: fake.fetch }));
  assert.equal(result.status, 'verified', result.errors.join('\n'));
  assert.equal(fake.issues.size, 1); assert.equal(fake.count('issueCreate'), 1);
});

test('retries a rejected creation with the same client ID', async t => {
  const s = setup(t); const fake = new FakeLinear(); fake.rejectNext = true;
  const client = new Linear({ token: KEY, fetch: fake.fetch });
  const first = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, client);
  assert.equal(first.status, 'failed');
  const clientId = JSON.parse(readFileSync(s.statePath, 'utf8')).candidates.cand.ops.create.clientId;
  const second = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, client);
  assert.equal(second.status, 'verified', second.errors.join('\n'));
  assert.ok(fake.issues.has(clientId)); assert.equal(fake.issues.size, 1);
});

test('returns changed duplicate observations for review, then records after refresh', async t => {
  const s = setup(t); const fake = new FakeLinear();
  const client = new Linear({ token: KEY, fetch: fake.fetch });
  fake.addIssue({ title: 'Unrelated: flags stable in docs', description: 'docs only' });
  const first = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, client);
  assert.equal(first.status, 'needs-review'); assert.equal(fake.count('issueCreate'), 0);
  const review = first.outcomes[0].duplicateReview;
  const revised = structuredClone(s.payload); revised.candidates[0].duplicate.issues = review.issues;
  revised.candidates[0].duplicate.evidence = 'ENG-1 covers documentation only, not CLI behavior';
  const refreshed = await refresh({ version: 1, previousPayload: s.payload, payload: revised, statePath: s.statePath, review: { candidateId: 'cand', reason: 'Unrelated documentation issue', observations: review },
    context: { ...s.context, duplicateReview: { confirmed: true, evidence: 'Coordinator reviewed ENG-1' } } }, client);
  assert.equal(refreshed.status, 'verified', refreshed.errors.join('\n'));
  const second = await record({ version: 1, payload: revised, statePath: s.statePath, context: s.context }, client);
  assert.equal(second.status, 'verified', second.errors.join('\n')); assert.equal(fake.count('issueCreate'), 1);
});

test('Plan Mode payloads do not search for duplicates again', async t => {
  const s = setup(t); s.payload.preparationMode = 'plan'; const fake = new FakeLinear();
  fake.addIssue({ title: 'flags stable elsewhere', description: '' });
  const result = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, new Linear({ token: KEY, fetch: fake.fetch }));
  assert.equal(result.status, 'verified', result.errors.join('\n')); assert.equal(fake.count('issues(first'), 0);
});

test('adds a duplicate comment and skips a conflicting optional priority', async t => {
  const fake = new FakeLinear();
  const existing = fake.addIssue({ title: 'cli: flags drift', description: 'old report', priority: 3 });
  const s = setup(t, { action: 'duplicate comment', issueUrl: existing.url.replace('/slug', ''), body: '', comment: 'New evidence at the investigated revision.' });
  s.c.duplicate = { terms: ['flags drift'], limit: 20, complete: true, evidence: 'Same root cause', issues: [{ id: existing.id, identifier: 'ENG-1', url: existing.url, title: existing.title, state: 'backlog' }],
    issue: { id: existing.id, identifier: 'ENG-1', url: existing.url, title: existing.title, body: 'old report', state: 'backlog' }, comments: [] };
  s.c.metadata = [label(), priority({ observed: 3 })]; s.c.allowedActions = ['duplicate comment', 'metadata:label', 'metadata:priority'];
  const result = await record({ version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, new Linear({ token: KEY, fetch: fake.fetch }));
  assert.equal(result.status, 'verified', result.errors.join('\n'));
  assert.equal(existing.priority, 3); assert.deepEqual(existing.labelIds, [LABEL]);
  assert.deepEqual(result.outcomes[0].omissions, [{ id: 'priority', reason: 'Existing metadata conflicts' }]);
  assert.equal(fake.comments.size, 1); assert.equal(fake.count('issueCreate'), 0);
});

test('reports an invalid key as authRequired without writing', async t => {
  const s = setup(t); const fake = new FakeLinear(); fake.authFail = true;
  const value = await dispatch('record', { version: 1, payload: s.payload, statePath: s.statePath, context: s.context }, { env: { LINEAR_API_KEY: KEY }, fetch: fake.fetch });
  assert.equal(value.authRequired, true); assert.equal(value.status, 'blocked');
  const missing = await dispatch('collect', { version: 1, target: { workspace: 'acme', team: 'ENG' } }, { env: {}, keychain: { read: () => null }, config: { default: null, workspaces: {} } });
  assert.equal(missing.authRequired, true);
});

test('collect observes discovery, duplicates, and metadata', async t => {
  const fake = new FakeLinear(); fake.addIssue({ title: 'flags stable', description: '' });
  const value = await collect({ version: 1, target: { workspace: 'acme', team: 'ENG' }, duplicate: { terms: ['flags'], limit: 10 }, metadata: [{ id: 'label', kind: 'label', value: LABEL }] }, new Linear({ token: KEY, fetch: fake.fetch }));
  assert.equal(value.status, 'verified', value.errors.join('\n'));
  assert.equal(value.observations.duplicates.value.issues[0].identifier, 'ENG-1');
  assert.deepEqual(value.observations['metadata:label'].value.definition, { id: LABEL, name: 'bug', teamId: null });
  const overflow = await collect({ version: 1, target: { workspace: 'acme', team: 'ENG' }, duplicate: { terms: ['flags'], limit: 1 } }, new Linear({ token: KEY, fetch: (fake.addIssue({ title: 'flags again' }), fake.fetch) }));
  assert.equal(overflow.observations.duplicates.available, false);
});

test('preflight blocks a changed workspace', async t => {
  const s = setup(t); writeFileSync(join(s.repo, 'a.txt'), 'changed');
  const value = await preflight(s.payload, s.c, new Linear({ token: KEY, fetch: new FakeLinear().fetch }), s.context);
  assert.equal(value.status, 'blocked'); assert.ok(value.errors.some(e => /Workspace/.test(e)));
});

test('text verification tolerates Markdown re-rendering only', () => {
  assert.equal(normalizeText('* a\n* b [https://x.y](https://x.y)'), normalizeText('- a\n- b https://x.y'));
  assert.notEqual(normalizeText('fix A'), normalizeText('fix B'));
  assert.equal(normalizeText('한글 *본문*'), normalizeText('한글 본문'));
});

test('Keychain stores the key through stdin and env overrides it', () => {
  const calls = []; const store = new Map();
  const transport = (program, args, options) => {
    calls.push({ program, args, input: options.input });
    if (args[0] === '-i') { const m = options.input.match(/-a "([^"]+)".* -w "([^"]+)"/); store.set(m[1], m[2]); return { status: 0, stdout: '' }; }
    if (args[0] === 'find-generic-password') { const v = store.get(args[args.indexOf('-a') + 1]); return v ? { status: 0, stdout: `${v}\n` } : { status: 44, stdout: '' }; }
    return { status: 0, stdout: '' };
  };
  const keychain = new Keychain({ transport, platform: 'darwin' });
  keychain.write('acme', KEY);
  assert.ok(calls.every(c => !c.args.join(' ').includes(KEY)), 'key appeared in argv');
  assert.ok(calls[0].input.includes(SERVICE));
  assert.deepEqual(resolveToken('acme', { env: {}, keychain, config: { default: null, workspaces: {} } }), { token: KEY, source: 'keychain', workspace: 'acme' });
  assert.equal(resolveToken(undefined, { env: {}, keychain, config: { default: 'acme', workspaces: {} } }).token, KEY);
  assert.equal(resolveToken('acme', { env: { LINEAR_API_KEY: 'lin_api_env' }, keychain }).source, 'env');
  assert.throws(() => keychain.write('acme', 'bad"key with spaces'), /Unexpected/);
  assert.equal(new Keychain({ transport, platform: 'linux' }).read('acme'), null);
});

test('auth-store validates the key, stores it once, and status never prints it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-auth-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'key'); writeFileSync(keyFile, `${KEY}\n`);
  const store = new Map(); const keychain = { read: w => store.get(w) ?? null, write: (w, k) => store.set(w, k), remove: w => store.delete(w) };
  const fake = new FakeLinear(); const configPath = join(dir, 'cfg', 'linear.json');
  const stored = await auth('auth-store', [keyFile], { keychain, fetch: fake.fetch, configPath });
  assert.equal(stored.status, 'verified'); assert.equal(stored.workspace, 'acme'); assert.equal(store.get('acme'), KEY);
  assert.ok(!JSON.stringify(stored).includes(KEY)); assert.ok(!readFileSync(configPath, 'utf8').includes(KEY));
  const status = await auth('auth-status', [], { keychain, fetch: fake.fetch, configPath, env: {} });
  assert.equal(status.status, 'verified'); assert.equal(status.source, 'keychain'); assert.deepEqual(status.teams.map(x => x.key), ['ENG']);
  assert.ok(!JSON.stringify(status).includes(KEY));
  fake.authFail = true;
  const revoked = await auth('auth-status', [], { keychain, fetch: fake.fetch, configPath, env: {} });
  assert.equal(revoked.authRequired, true);
  const rejected = await auth('auth-store', [keyFile], { keychain: { write: () => assert.fail('stored a rejected key') }, fetch: fake.fetch, configPath });
  assert.equal(rejected.stored, false);
  await auth('auth-delete', ['acme'], { keychain, configPath });
  assert.equal(store.size, 0); assert.ok(existsSync(configPath));
});
