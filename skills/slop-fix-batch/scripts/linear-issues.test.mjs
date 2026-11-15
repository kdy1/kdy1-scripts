import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, canonicalLinearIssues, OPEN } from './linear-issues.mjs';

const KEY = 'lin_api_' + 'x'.repeat(40);
const env = { LINEAR_API_KEY: KEY };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DONE = { id: uuid(901), name: 'Done', type: 'completed' };
const TODO = { id: uuid(902), name: 'Todo', type: 'unstarted' };

// A fake Linear GraphQL endpoint that routes on the query text.
class FakeLinear {
  constructor({ workspace = 'acme', count = 2 } = {}) {
    this.workspace = workspace; this.calls = []; this.comments = new Map(); this.states = [DONE, TODO];
    this.issues = Array.from({ length: count }, (_, i) => ({ id: uuid(i + 1), identifier: `ENG-${i + 1}`, url: `https://linear.app/acme/issue/ENG-${i + 1}/slug`, title: `Issue ${i + 1}`,
      description: 'body', state: { ...TODO }, team: { id: uuid(100), key: 'ENG' } }));
  }
  find(id) { return this.issues.find(x => x.id === id || x.identifier === id); }
  fetch = async (url, options) => {
    const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    const missing = what => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: `Entity not found: ${what}` }] }) });
    const { query, variables: v } = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, KEY);
    const op = ['viewer', 'commentCreate', 'issueUpdate', 'issues(first:100', 'comments(first:100', 'states(first:100', 'comment(id', 'description', 'issue(id'].find(name => query.includes(name));
    this.calls.push({ op, v });
    if (this.failOn === op) { this.failOn = null; this.afterFail?.(v); throw new TypeError('fetch failed'); }
    if (op === 'viewer') return ok({ viewer: { id: uuid(500), name: 'Tester', email: 't@example.invalid', active: true }, organization: { id: uuid(501), urlKey: this.workspace, name: 'Acme' } });
    if (op === 'issues(first:100') {
      assert.deepEqual(v.filter.and[1], OPEN);
      const start = v.after ? Number(v.after) : 0, page = this.issues.slice(start, start + 1);
      if (this.onPage) this.onPage();
      return ok({ issues: { nodes: page.map(({ id, identifier, url }) => ({ id, identifier, url })), pageInfo: { hasNextPage: start + 1 < this.issues.length, endCursor: String(start + 1) } } });
    }
    if (op === 'description') {
      const x = this.find(v.id); if (!x) return missing('Issue');
      const empty = { nodes: [], pageInfo: { hasNextPage: false } };
      return ok({ issue: { ...x, priority: 0, createdAt: 'c', updatedAt: 'u', completedAt: null, canceledAt: null, archivedAt: null, trashed: false, project: null, parent: null,
        labels: { nodes: [{ name: 'Bug' }], pageInfo: { hasNextPage: false } }, children: empty, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-2', url: 'u2', state: { type: 'unstarted' } } }], pageInfo: { hasNextPage: true } },
        inverseRelations: empty, attachments: { nodes: [{ title: 'PR', url: 'https://github.com/o/r/pull/9', sourceType: 'github' }], pageInfo: { hasNextPage: false } } } });
    }
    if (op === 'issue(id') { const x = this.find(v.id); return x ? ok({ issue: x }) : missing('Issue'); }
    if (op === 'comments(first:100') return ok({ issue: { comments: { nodes: [...this.comments.values()].filter(c => c.issue.id === v.id).map(c => ({ ...c, createdAt: 't', user: { name: 'Tester' } })), pageInfo: { hasNextPage: false } } } });
    if (op === 'states(first:100') return ok({ team: { states: { nodes: this.states, pageInfo: { hasNextPage: false } } } });
    if (op === 'comment(id') return this.comments.has(v.id) ? ok({ comment: this.comments.get(v.id) }) : missing('Comment');
    if (op === 'commentCreate') {
      const c = { id: v.input.id, url: `https://linear.app/acme/issue/ENG-1/slug#comment-${v.input.id.slice(-4)}`, body: v.input.body, issue: { id: v.input.issueId } };
      this.comments.set(c.id, c); return ok({ commentCreate: { success: true, comment: { id: c.id, url: c.url } } });
    }
    if (op === 'issueUpdate') { const x = this.find(v.id); x.state = { ...this.states.find(s => s.id === v.input.stateId) }; return ok({ issueUpdate: { success: true } }); }
    throw new Error(`Unexpected query: ${query}`);
  };
}
const scratch = fn => { const dir = mkdtempSync(join(tmpdir(), 'linear-issues-')); return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true })); };
const filter = { team: { key: { eq: 'ENG' } } };

test('collect pages through the open-state filter and returns a ledger-ready selection', async () => {
  const fake = new FakeLinear();
  const result = await run('collect', { version: 1, workspace: 'acme', filter }, { env, fetch: fake.fetch });
  assert.equal(result.status, 'complete');
  assert.equal(result.query, `linear:acme ${JSON.stringify({ and: [filter, OPEN] })}`);
  assert.deepEqual(result.issues.map(i => [i.key, i.identifier, i.canonicalOrder, i.tracker]), [['linear.app/acme/eng-1', 'ENG-1', 0, 'linear'], ['linear.app/acme/eng-2', 'ENG-2', 1, 'linear']]);
  assert.equal(fake.calls.filter(c => c.op === 'issues(first:100').length, 4);
});

test('collect blocks a selection that changes between passes, overflows, or leaves the workspace', async () => {
  const fake = new FakeLinear(); let pages = 0;
  fake.onPage = () => { if (++pages === 3) fake.issues.reverse(); };
  assert.match((await run('collect', { version: 1, workspace: 'acme', filter }, { env, fetch: fake.fetch })).reason, /changed during collection/);
  const big = new FakeLinear({ count: 11 });
  const overflow = await run('collect', { version: 1, workspace: 'acme', filter }, { env, fetch: big.fetch });
  assert.equal(overflow.status, 'blocked'); assert.match(overflow.reason, /exceeds 1000/);
  const other = [{ id: uuid(1), identifier: 'ENG-1', url: 'https://linear.app/other/issue/ENG-1' }];
  assert.equal(canonicalLinearIssues({ workspace: 'acme', filter }, [other, other]).complete, false);
});

test('a key for another workspace or a missing key asks for authentication', async () => {
  const fake = new FakeLinear({ workspace: 'other' });
  const wrong = await run('collect', { version: 1, workspace: 'acme', filter }, { env, fetch: fake.fetch });
  assert.equal(wrong.authRequired, true);
  const none = await run('read', { version: 1, workspace: 'acme', identifiers: ['ENG-1'] }, { env: {}, store: { read: () => ({ token: null, locked: false }) }, config: { default: null, workspaces: {} } });
  assert.equal(none.authRequired, true); assert.equal(none.complete, false);
  const locked = await run('read', { version: 1, workspace: 'acme', identifiers: ['ENG-1'] }, { env: {}, store: { read: () => ({ token: null, locked: true }) }, config: { default: null, workspaces: {} } });
  assert.equal(locked.keyringLocked, true); assert.equal(locked.authRequired, undefined); assert.equal(locked.complete, false);
});

test('read returns body, comments, relations, attachments and truncation', async () => {
  const fake = new FakeLinear();
  fake.comments.set(uuid(700), { id: uuid(700), url: 'c', body: 'Repro steps', issue: { id: uuid(1) } });
  const result = await run('read', { version: 1, workspace: 'acme', identifiers: ['ENG-1'] }, { env, fetch: fake.fetch });
  const [issue] = result.issues;
  assert.equal(result.status, 'verified');
  assert.deepEqual([issue.labels, issue.comments[0].body, issue.relations[0].identifier, issue.attachments[0].url, issue.truncated], [['Bug'], 'Repro steps', 'ENG-2', 'https://github.com/o/r/pull/9', ['relations']]);
  assert.equal((await run('read', { version: 1, workspace: 'acme', identifiers: ['ENG-404'] }, { env, fetch: fake.fetch })).status, 'blocked');
});

test('close posts one evidence comment, completes the issue and is idempotent', () => scratch(async dir => {
  const fake = new FakeLinear(), commentFile = join(dir, 'comment.md'); writeFileSync(commentFile, 'Resolved by abc123; tests pass.');
  const input = { version: 1, workspace: 'acme', identifier: 'ENG-1', commentFile, commentId: uuid(800) };
  const first = await run('close', input, { env, fetch: fake.fetch });
  assert.equal(first.status, 'verified');
  assert.deepEqual(first.closure, { state: 'completed', stateName: 'Done', stateId: DONE.id, commentUrl: fake.comments.get(uuid(800)).url });
  const again = await run('close', input, { env, fetch: fake.fetch });
  assert.equal(again.status, 'verified');
  assert.equal(fake.calls.filter(c => c.op === 'commentCreate').length, 1);
  assert.equal((await run('close', { ...input, commentId: uuid(801) }, { env, fetch: fake.fetch })).status, 'already-closed');
}));

test('close recovers a lost comment response by reading the client ID', () => scratch(async dir => {
  const fake = new FakeLinear(), commentFile = join(dir, 'comment.md'); writeFileSync(commentFile, 'Evidence');
  const input = { version: 1, workspace: 'acme', identifier: 'ENG-1', commentFile, commentId: uuid(810) };
  // The comment is created but the response is lost.
  fake.failOn = 'commentCreate'; fake.afterFail = v => fake.comments.set(v.input.id, { id: v.input.id, url: 'lost', body: v.input.body, issue: { id: v.input.issueId } });
  assert.equal((await run('close', input, { env, fetch: fake.fetch })).status, 'verified');
  // The request never arrives: the result is uncertain and a rerun creates the comment once.
  const lost = new FakeLinear(); lost.failOn = 'commentCreate';
  assert.equal((await run('close', input, { env, fetch: lost.fetch })).status, 'uncertain');
  assert.equal((await run('close', input, { env, fetch: lost.fetch })).status, 'verified');
  assert.equal(lost.comments.size, 1);
}));

test('close needs an explicit completed state when the team has several', () => scratch(async dir => {
  const fake = new FakeLinear(), commentFile = join(dir, 'comment.md'); writeFileSync(commentFile, 'Evidence');
  const shipped = { id: uuid(903), name: 'Shipped', type: 'completed' }; fake.states.push(shipped);
  const input = { version: 1, workspace: 'acme', identifier: 'ENG-1', commentFile, commentId: uuid(820) };
  const blocked = await run('close', input, { env, fetch: fake.fetch });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.completedStates.length, 2);
  assert.equal(fake.calls.filter(c => c.op === 'commentCreate').length, 0);
  assert.equal((await run('close', { ...input, stateId: shipped.id }, { env, fetch: fake.fetch })).closure.stateName, 'Shipped');
  assert.equal((await run('close', { ...input, commentId: uuid(821), identifier: 'ENG-2', stateId: TODO.id }, { env, fetch: fake.fetch })).status, 'blocked');
}));
