import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPullRequest, main, parseIssueUrl } from './linear-issue.mjs';

const scratch = fn => { const dir = mkdtempSync(join(tmpdir(), 'slop-fix-issue-linear-')); return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true })); };
const issue = (state = { id: 's', name: 'Todo', type: 'unstarted' }) => ({
  identifier: 'ENG-7', found: true, id: 'i', url: 'https://linear.app/acme/issue/ENG-7/slug', title: 'T', description: 'D', state,
  attachments: [{ title: 'PR', url: 'https://github.com/o/r/pull/9', sourceType: 'github' }, { title: 'Doc', url: 'https://example.invalid/doc', sourceType: 'link' }],
  comments: [],
});

test('parseIssueUrl accepts slugs, query strings, and lowercase identifiers', () => {
  assert.deepEqual(parseIssueUrl('https://linear.app/Acme/issue/eng-7/fix-the-thing?x=1'),
    { tracker: 'linear', workspace: 'acme', identifier: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7' });
  assert.throws(() => parseIssueUrl('https://github.com/o/r/issues/1'), /Linear issue URL/);
  assert.throws(() => parseIssueUrl('https://linear.app/acme/project/eng-7'), /Linear issue URL/);
});

test('read derives the closed state, linked PRs, and reference lines', async () => {
  const calls = [];
  const linear = async (command, input) => { calls.push([command, input]); return { version: 1, complete: true, status: 'verified', issues: [issue()] }; };
  const open = await main(['read', 'https://linear.app/acme/issue/ENG-7/slug'], { linear });
  assert.deepEqual(calls, [['read', { version: 1, workspace: 'acme', identifiers: ['ENG-7'] }]]);
  assert.equal(open.closed, false);
  assert.deepEqual(open.pullRequests, ['https://github.com/o/r/pull/9']);
  assert.deepEqual(open.references, { closes: 'Closes ENG-7', refs: 'Ref ENG-7' });
  const done = await main(['read', 'https://linear.app/acme/issue/ENG-7'], { linear: async () => ({ status: 'verified', issues: [issue({ id: 'd', name: 'Done', type: 'completed' })] }) });
  assert.equal(done.closed, true);
});

test('read passes authentication results through', async () => {
  const blocked = { version: 1, complete: false, status: 'blocked', authRequired: true, workspace: 'acme' };
  const result = await main(['read', 'https://linear.app/acme/issue/ENG-7'], { linear: async () => blocked });
  assert.equal(result.authRequired, true);
  assert.equal(result.target.identifier, 'ENG-7');
});

test('close keeps one comment ID for every attempt', () => scratch(async dir => {
  const comment = join(dir, 'comment.md'), record = join(dir, 'close.json');
  writeFileSync(comment, 'Evidence\n');
  const inputs = [];
  let n = 0;
  const deps = { uuid: () => `id-${++n}`, linear: async (command, input) => { inputs.push(input); return { status: inputs.length === 1 ? 'uncertain' : 'verified' }; } };
  const first = await main(['close', 'https://linear.app/acme/issue/ENG-7', comment, record], deps);
  const second = await main(['close', 'https://linear.app/acme/issue/ENG-7/slug', comment, record, 'state-1'], deps);
  assert.equal(first.commentId, 'id-1');
  assert.equal(second.commentId, 'id-1');
  assert.equal(inputs[1].commentId, 'id-1');
  assert.equal(inputs[1].stateId, 'state-1');
  assert.equal(inputs[0].stateId, undefined);
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).commentId, 'id-1');
  await assert.rejects(main(['close', 'https://linear.app/acme/issue/ENG-8', comment, record], deps), /another issue/);
  await assert.rejects(main(['close', 'https://linear.app/acme/issue/ENG-7', join(dir, 'other.md'), record], deps), /comment file/);
}));

test('collect passes the filter file to the batch helper', () => scratch(async dir => {
  const file = join(dir, 'filter.json');
  writeFileSync(file, JSON.stringify({ team: { key: { eq: 'ENG' } } }));
  let seen;
  await main(['collect', 'Acme', file], { linear: async (command, input) => { seen = [command, input]; return { status: 'complete' }; } });
  assert.deepEqual(seen, ['collect', { version: 1, workspace: 'acme', filter: { team: { key: { eq: 'ENG' } } } }]);
}));

test('checkPullRequest verifies Closes and Ref layers', () => {
  const pr = { url: 'u', title: 'feat: add the thing', headRefName: 'kdy1/thing', isDraft: false, state: 'OPEN' };
  assert.equal(checkPullRequest({ ...pr, body: 'Text\n\nCloses ENG-7\n' }, 'ENG-7', 'closes').status, 'verified');
  assert.equal(checkPullRequest({ ...pr, body: 'Text\n\nRef ENG-7\n' }, 'ENG-7', 'refs').status, 'verified');
  assert.match(checkPullRequest({ ...pr, body: 'Refs ENG-7\n' }, 'ENG-7', 'refs').errors.join(), /no standalone "Ref ENG-7"/);
  assert.match(checkPullRequest({ ...pr, body: 'Ref ENG-7\nThis fixes ENG-7\n' }, 'ENG-7', 'refs').errors.join(), /closing word/);
  assert.match(checkPullRequest({ ...pr, headRefName: 'kdy1/eng-7-part-1', body: 'Ref ENG-7' }, 'ENG-7', 'refs').errors.join(), /head branch/);
  assert.match(checkPullRequest({ ...pr, title: 'feat: ENG-7 part 1', body: 'Ref ENG-7' }, 'ENG-7', 'refs').errors.join(), /title/);
  assert.match(checkPullRequest({ ...pr, isDraft: true, body: 'Closes ENG-7' }, 'ENG-7', 'closes').errors.join(), /draft/);
  // A closing layer may name the issue in its branch; Linear links it for closure on merge.
  assert.equal(checkPullRequest({ ...pr, headRefName: 'kdy1/eng-7', body: 'Closes ENG-7' }, 'ENG-7', 'closes').status, 'verified');
});

test('check-pr reads the PR through gh', async () => {
  let argv;
  const gh = args => { argv = args; return JSON.stringify({ url: 'https://github.com/o/r/pull/1', title: 't', headRefName: 'b', body: 'Closes ENG-7', isDraft: false, state: 'OPEN' }); };
  const result = await main(['check-pr', 'https://github.com/o/r/pull/1', 'ENG-7', 'closes'], { gh });
  assert.equal(result.status, 'verified');
  assert.deepEqual(argv.slice(0, 3), ['pr', 'view', 'https://github.com/o/r/pull/1']);
});

test('read and close work with the slop-fix-batch Linear helper', () => scratch(async dir => {
  const { run } = await import('../../slop-fix-batch/scripts/linear-issues.mjs');
  const env = { LINEAR_API_KEY: 'lin_api_' + 'x'.repeat(40) };
  const empty = { nodes: [], pageInfo: { hasNextPage: false } };
  const states = [{ id: '00000000-0000-4000-8000-000000000901', name: 'Done', type: 'completed' }];
  const comments = new Map();
  const x = { id: 'i', identifier: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7/slug', title: 'T', description: 'D',
    state: { id: 's', name: 'Todo', type: 'unstarted' }, team: { id: 't', key: 'ENG' } };
  const fetch = async (url, options) => {
    const { query, variables: v } = JSON.parse(options.body);
    const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (query.includes('viewer')) return ok({ viewer: { id: 'v', name: 'T', email: 't@example.invalid', active: true }, organization: { id: 'o', urlKey: 'acme', name: 'Acme' } });
    if (query.includes('commentCreate')) { const c = { id: v.input.id, url: 'https://linear.app/acme/issue/ENG-7#comment-1', body: v.input.body, issue: { id: v.input.issueId } }; comments.set(c.id, c); return ok({ commentCreate: { success: true, comment: c } }); }
    if (query.includes('issueUpdate')) { x.state = states.find(s => s.id === v.input.stateId); return ok({ issueUpdate: { success: true } }); }
    if (query.includes('comments(first:100')) return ok({ issue: { comments: { nodes: [...comments.values()].map(c => ({ ...c, createdAt: 't', user: { name: 'T' } })), pageInfo: { hasNextPage: false } } } });
    if (query.includes('states(first:100')) return ok({ team: { states: { nodes: states, pageInfo: { hasNextPage: false } } } });
    if (query.includes('comment(id')) return comments.has(v.id) ? ok({ comment: comments.get(v.id) }) : { ok: true, status: 200, json: async () => ({ errors: [{ message: 'Entity not found: Comment' }] }) };
    if (query.includes('description')) return ok({ issue: { ...x, priority: 0, createdAt: 'c', updatedAt: 'u', completedAt: null, canceledAt: null, archivedAt: null, trashed: false, project: null, parent: null,
      labels: empty, children: empty, relations: empty, inverseRelations: empty, attachments: { nodes: [{ title: 'PR', url: 'https://github.com/o/r/pull/9', sourceType: 'github' }], pageInfo: { hasNextPage: false } } } });
    if (query.includes('issue(id')) return ok({ issue: x });
    throw new Error(`Unexpected query: ${query}`);
  };
  const linear = (command, input) => run(command, input, { env, fetch });
  const read = await main(['read', 'https://linear.app/acme/issue/ENG-7/slug'], { linear });
  assert.equal(read.status, 'verified');
  assert.equal(read.closed, false);
  assert.deepEqual(read.pullRequests, ['https://github.com/o/r/pull/9']);
  const comment = join(dir, 'comment.md');
  writeFileSync(comment, 'Evidence\n');
  const closed = await main(['close', 'https://linear.app/acme/issue/ENG-7', comment, join(dir, 'close.json')], { linear });
  assert.equal(closed.status, 'verified');
  assert.equal(closed.closure.stateName, 'Done');
  assert.equal(comments.size, 1);
  assert.equal((await main(['read', 'https://linear.app/acme/issue/ENG-7'], { linear })).closed, true);
}));
