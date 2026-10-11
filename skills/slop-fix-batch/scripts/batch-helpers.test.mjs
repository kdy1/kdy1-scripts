import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request, control } from './github-request.mjs';
import { canonicalIssues, collectIssues } from './collect-issues.mjs';
import { initialize, validateLedger, applyEvent, updateLedger, schedulingSnapshot } from './batch-ledger.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { checkpoint, emptyCheckpoints, checkpointPlan } from './batch-checkpoints.mjs';
import { renderHandoff, renderReport } from './render-handoff.mjs';
import { plan } from './batch-scheduler.mjs';
import { save } from './helper-common.mjs';
const sha = 'a'.repeat(40), head = 'b'.repeat(40);
const issue = { key: 'github.com/o/r/1', number: 1, url: 'https://github.com/o/r/issues/1', canonicalOrder: 0 };
const selection = { version: 1, complete: true, query: 'repo:o/r is:issue is:open', issues: [issue] };
const init = () => initialize({ version: 1, batchId: 'batch', coordinator: 'root', query: selection.query, repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix selected issues', inspectedSha: sha, selection });
const group = { id: 'g', issues: [issue.key], requires: [], confirmed: true, acceptance: 'Fix behavior', dependencyEvidence: 'Independent inspected function' };
const stack = { id: 's', phase: 'building', groups: ['g'], layers: [], baseSha: sha, worktree: '/tmp/stack', fetchedAt: '2026-10-11T00:00:00Z', revalidationEvidence: 'Fetched base and inspected function' };
const layer = { groupId: 'g', requirementsSatisfied: true, headSha: head, workerSha: sha, checks: [{ command: 'node --test', status: 'passed', sha }], integrationChanged: false, realWorldValidation: 'not-performed' };
function event(ledger, type, fields = {}) { return { id: `e${ledger.revision}`, expectedRevision: ledger.revision, at: '2026-10-11T00:00:00Z', type, ...fields }; }
function apply(ledger, type, fields) { return applyEvent(ledger, event(ledger, type, fields), 'root'); }
function building() { let l = apply(init(), 'groups', { groups: [group] }); return apply(l, 'stack', { value: stack }); }
function publication() {
  const l = { groupId: 'g', url: 'https://github.com/o/r/pull/2', headRepository: 'github.com/o/r', headBranch: 'kdy1/fix', baseBranch: 'main', headSha: head, baseSha: sha, title: 'Fix behavior', body: `Fix behavior\n\nCloses ${issue.url}`, closes: [issue.url] };
  return { version: 1, expected: { stackId: 's', baseBranch: 'main', layers: [l] }, observed: { complete: true, attachmentComplete: true, stackId: 's', layers: [{ ...l, state: 'OPEN', isDraft: false }], attachments: [l.url] } };
}
function ready() {
  let l = apply(building(), 'layer', { stackId: 's', value: layer });
  l = apply(l, 'publication', { stackId: 's', verification: publication() });
  l = apply(l, 'coordination', { stackId: 's', value: { phase: 'ready', evidence: 'Verified registry ready after detach' } });
  return apply(l, 'ready', { stackId: 's', detachedSha: head, evidence: 'Clean detached checkout' });
}
function scratch(fn) { const dir = mkdtempSync(join(tmpdir(), 'batch-helpers-')); return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true })); }
const auth = { token: 'test-secret', namespace: 'identity-a' };
const response = (data, headers = {}, status = 200) => ({ status, headers, text: JSON.stringify(data) });
const input = dir => ({ version: 1, statePath: join(dir, 'request.json'), host: 'github.com', endpoint: '/repos/o/r/issues' });

test('conditional revalidation retains exact pages and authentication/API-version partition', () => scratch(async dir => {
  let calls = 0;
  const transport = async (_, options) => {
    calls++;
    if (calls === 2) { assert.equal(options.headers['If-None-Match'], 'tag'); return { status: 304, headers: {}, text: '' }; }
    assert.equal(options.headers['If-None-Match'], undefined); return response([{ number: calls }], { ETag: 'tag' });
  };
  const a = await request(input(dir), { auth, transport });
  const b = await request(input(dir), { auth, transport });
  assert.deepEqual(b.pages[0].data, a.pages[0].data); assert.equal(b.pages[0].revalidated, true);
  await request(input(dir), { auth: { ...auth, namespace: 'identity-b' }, transport });
  await request({ ...input(dir), apiVersion: 'different' }, { auth: { ...auth, namespace: 'identity-b' }, transport });
  assert.equal(readFileSync(input(dir).statePath, 'utf8').includes('test-secret'), false);
}));
test('304 without stored representation fails closed and locks are released', () => scratch(async dir => {
  await assert.rejects(request(input(dir), { auth, transport: async () => ({ status: 304, headers: {}, text: '' }) }), /304/);
  assert.equal((await request(input(dir), { auth, transport: async () => response([]) })).complete, true);
}));
test('all pages are collected; page failure retains incomplete status', () => scratch(async dir => {
  const url = 'https://api.github.com/repos/o/r/issues?page=2';
  let calls = 0;
  const transport = async () => ++calls === 1 ? response([1], { link: `<${url}>; rel="next"` }) : response([2]);
  const a = await request({ ...input(dir), paginate: true }, { auth, transport }); assert.equal(a.pages.length, 2);
  calls = 0;
  const b = await request({ ...input(dir), paginate: true }, { auth, transport: async (...args) => ++calls === 1 ? response([1], { link: `<${url}>; rel="next"` }) : Promise.reject(new Error('offline')) });
  assert.equal(b.complete, false); assert.equal(b.pages.length, 1);
}));
test('unsafe next links never send authentication outside the endpoint', () => scratch(async dir => {
  let calls = 0;
  await assert.rejects(request({ ...input(dir), paginate: true }, { auth, transport: async () => { calls++; return response([], { link: '<https://evil.test/page>; rel="next"' }); } }), /Unsafe/);
  assert.equal(calls, 1);
}));
test('primary cooldown applies to resource and secondary cooldown to the whole queue', () => scratch(async dir => {
  const now = () => 1000; let calls = 0;
  const transport = async () => { calls++; return response([], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100', 'x-ratelimit-resource': 'core' }); };
  await request(input(dir), { auth, now, transport });
  assert.equal((await request(input(dir), { auth, now, transport })).status, 'cooldown'); assert.equal(calls, 1);
  const limited = await request({ ...input(dir), resource: 'search' }, { auth, now, transport: async () => response({ message: 'secondary rate limit' }, { 'Retry-After': '90' }, 429) });
  assert.equal(limited.retryAt, 91000);
  assert.equal((await request({ ...input(dir), resource: 'graphql' }, { auth, now, transport })).status, 'cooldown');
}));
test('busy queue produces incomplete result without waiting or transport', () => scratch(async dir => {
  mkdirSync(`${input(dir).statePath}.lock`);
  assert.equal((await request(input(dir), { transport: () => assert.fail('must not call transport') })).status, 'busy');
}));
test('write interruption invalidates cache and blocks repeat attempts until reconciliation', () => scratch(async dir => {
  await request(input(dir), { auth, transport: async () => response([], { etag: 'a' }) });
  const write = { ...input(dir), method: 'PATCH', attempt: 'w1', body: { title: 'fixed' } };
  const failed = await request(write, { auth, transport: async () => { const state = JSON.parse(readFileSync(write.statePath)); assert.deepEqual(state.cache, {}); assert.equal(state.writes.w1.status, 'uncertain'); throw new Error('lost response'); } });
  assert.equal(failed.status, 'uncertain');
  assert.equal((await request(write, { auth })).status, 'blocked');
  assert.equal((await request({ ...write, attempt: 'w2' }, { auth })).status, 'uncertain');
  control({ version: 1, action: 'reconcile-write', statePath: write.statePath, attempt: 'w1', evidence: 'Fresh state confirmed failure' });
  assert.equal((await request({ ...write, attempt: 'w2' }, { auth, transport: async () => response({}) })).mutationResponseOnly, true);
}));
test('CLI limit observations preserve missing request counts and pause all resources', () => scratch(async dir => {
  control({ version: 1, statePath: input(dir).statePath, action: 'observe-cli', entryPoint: 'gh stack submit', limited: true });
  const state = JSON.parse(readFileSync(input(dir).statePath)); assert.equal(state.observations[0].exactRequestCount, null);
  assert.equal((await request(input(dir), { auth })).status, 'cooldown');
}));
const searchInput = { version: 1, query: selection.query, host: 'github.com', repository: 'o/r' };
const item = { number: 1, html_url: issue.url };
const observation = (items, total = items.length, incomplete = false) => ({ version: 1, complete: true, pages: [{ data: { total_count: total, incomplete_results: incomplete, items } }] });
test('selection preserves order, deduplicates and excludes PRs', () => {
  const result = canonicalIssues(searchInput, observation([item, item, { pull_request: {} }]));
  assert.equal(result.complete, true); assert.deepEqual(result.issues, [issue]);
});
test('selection rejects incomplete, capped, partial, changed-total and wrong-repository reads', () => {
  for (const read of [observation([item], 2), observation([], 1001), observation([], 0, true), { version: 1, complete: false, pages: [] }, observation([{ ...item, html_url: 'https://github.com/other/repo/issues/1' }])]) assert.equal(canonicalIssues(searchInput, read).complete, false);
  assert.equal(canonicalIssues(searchInput, observation([])).complete, true);
});
test('ledger preserves fixed list and idempotent events, rejecting conflicting ids/revisions/owners', () => {
  const l = init(), e = event(l, 'groups', { groups: [group] }), next = applyEvent(l, e, 'root');
  assert.deepEqual(applyEvent(next, e, 'root'), next);
  assert.throws(() => applyEvent(next, { ...e, groups: [] }, 'root'), /Conflicting/);
  assert.throws(() => applyEvent(next, { ...e, id: 'new' }, 'root'), /revision/);
  assert.throws(() => applyEvent(l, e, 'worker'), /coordinator/);
  assert.throws(() => apply(l, 'groups', { groups: [{ ...group, issues: ['other'] }] }), /fixed list/);
  assert.throws(() => apply(l, 'fixed-list', {}), /Unknown/);
});
test('ledger rejects cycles, cross-stack dependencies and missing original worker coverage', () => {
  assert.throws(() => apply(init(), 'groups', { groups: [{ ...group, requires: ['g'] }] }), /cycle/);
  assert.throws(() => apply(building(), 'layer', { stackId: 's', value: { ...layer, checks: [{ command: 'test', status: 'passed', sha: head }] } }), /original SHA/);
  assert.throws(() => apply(building(), 'layer', { stackId: 's', value: { ...layer, integrationChanged: true } }), /integration-change/);
});
test('ready requires complete publication, registry proof and detached exact tip', () => {
  assert.throws(() => apply(building(), 'ready', { stackId: 's', detachedSha: head, evidence: 'clean' }), /ready handoff/);
  assert.equal(ready().stacks.s.phase, 'ready');
  assert.throws(() => apply(ready(), 'layer', { stackId: 's', value: layer }), /protected/);
});
test('published layers and unknown publication attempts remain protected', () => {
  let l = apply(building(), 'layer', { stackId: 's', value: layer });
  l = apply(l, 'publication-attempt', { stackId: 's', value: { id: 'p1', status: 'uncertain' } });
  assert.throws(() => apply(l, 'layer', { stackId: 's', value: layer }), /publication blocks/);
  l = apply(l, 'publication', { stackId: 's', verification: publication() });
  assert.throws(() => apply(l, 'layer', { stackId: 's', value: layer }), /cannot change/);
});
test('uncertain workers retain slots and need reconciliation before completion', () => {
  let l = apply(init(), 'assignment', { value: { id: 'a', taskId: 't', lane: 'implementation', status: 'reserved', slots: 2 } });
  l = apply(l, 'assignment', { value: { ...l.assignments.a, status: 'uncertain' } });
  assert.throws(() => apply(l, 'assignment', { value: { ...l.assignments.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'stopped' } }), /reconciliation/);
  l = apply(l, 'scheduler', { value: { version: 1, capacity: 3, tasks: [] } });
  assert.equal(plan(schedulingSnapshot(l)).accounting.used, 2);
  l = apply(l, 'assignment', { value: { ...l.assignments.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'stopped and no writes' }, reconciled: true, evidence: 'Verified terminal agent and remote effects' });
  assert.equal(l.assignments.a.slots, 0);
});
test('atomic ledger updates never steal interrupted locks or overwrite conflicts', () => scratch(dir => {
  const path = join(dir, 'ledger.json'), l = init(); save(path, l);
  updateLedger(path, 'root', event(l, 'groups', { groups: [group] }));
  mkdirSync(`${path}.lock`);
  assert.throws(() => updateLedger(path, 'root', event(l, 'groups', { groups: [] })), /busy or interrupted/);
  assert.equal(JSON.parse(readFileSync(path)).revision, 1);
}));
test('publication detects identity, SHA, draft, body, closes, attachment and prefix errors', () => {
  assert.equal(verifyPublication(publication()).complete, true);
  for (const change of [p => p.observed.layers[0].headSha = sha, p => p.observed.layers[0].isDraft = true, p => p.observed.layers[0].body = 'Refs issue', p => p.observed.attachments = [], p => p.observed.layers.push(p.observed.layers[0]), p => p.observed.complete = false, p => p.observed.layers[0].baseSha = head]) {
    const p = publication(); change(p); assert.equal(verifyPublication(p).complete, false);
  }
});
test('checkpoint pass captures events and PRs; arrivals remain pending and due immediately', () => {
  let c = checkpoint(emptyCheckpoints(), { type: 'enqueue', id: 'e1', stackId: 's' });
  c = checkpoint(c, { type: 'start', passId: 'p', at: 1000, prs: ['pr1'] });
  assert.throws(() => checkpoint(c, { type: 'start', passId: 'another', at: 1001, prs: [] }), /active/);
  c = checkpoint(c, { type: 'enqueue', id: 'e2', stackId: 's' });
  c = checkpoint(c, { type: 'finish', passId: 'p', at: 2000, full: true, nextFullAt: 5000, refresh: { s: 9000 }, inventory: { complete: true, prs: [{ url: 'pr1', readComplete: true, state: 'OPEN', headSha: head, baseSha: sha, readAt: 1500 }] } });
  assert.deepEqual(c.pending.map(e => e.id), ['e2']); assert.equal(c.refresh.s, 0); assert.equal(c.nextFullAt, 5000);
});
test('partial pass cannot claim full inventory or terminate; changed heads invalidate candidates', () => {
  let c = checkpoint(emptyCheckpoints(), { type: 'start', passId: 'p', at: 1000, prs: ['pr1', 'pr2'] });
  c = checkpoint(c, { type: 'finish', passId: 'p', at: 2000, inventory: { complete: true, prs: [{ url: 'pr1', readComplete: true, state: 'OPEN', headSha: head, baseSha: sha, readAt: 1500 }] } });
  assert.equal(c.inventory.complete, false);
  c = checkpoint(c, { type: 'candidate', queue: 'merge', stackId: 's', prs: ['pr1'], evidence: 'inventory at time' });
  c = checkpoint(c, { type: 'invalidate', stackId: 's' }); assert.equal(c.candidates.merge[0].stale, true);
  assert.equal(checkpointPlan({ ...ready(), checkpoints: c, implementationEnded: true }, 1000).stop, false);
});
test('termination requires exact current terminal PR set and no protected or unknown work', () => {
  const l = ready(); l.implementationEnded = true; l.checkpoints.pending = [];
  l.checkpoints.inventory = { complete: true, prs: [{ url: l.stacks.s.layers[0].url, state: 'MERGED', readComplete: true, headSha: head, baseSha: sha, readAt: 1500 }] };
  assert.equal(checkpointPlan(l, 1000).stop, true);
  l.stacks.s.outstandingEffects = true; assert.equal(checkpointPlan(l, 1000).stop, false);
});
function assignment() { return { scope: 'selected issue', repositoryInstructions: 'AGENTS.md', concurrency: 'one slot; no nested allocation', estimateEvidence: 'inspected function', requestHelper: '/skill/github-request.mjs', requestState: '/batch/api.json', schedulerHelper: '/skill/batch-scheduler.mjs', timingState: '/batch/timing.json', ledgerPath: '/batch/ledger.json', checkout: '/tmp/worker', inspectedSha: sha, issueKeys: [issue.key] }; }
test('handoff distinguishes Plan Mode, preparation and recorded START; rejects placeholders', () => {
  const i = { version: 1, mode: 'plan', role: 'investigation', phase: 'prepare', ledger: init(), assignment: assignment() };
  assert.match(renderHandoff(i), /Read-only preparation only/);
  assert.throws(() => renderHandoff({ ...i, role: 'publication' }), /Plan Mode/);
  assert.throws(() => renderHandoff({ ...i, assignment: { ...assignment(), scope: '<scope>' } }), /placeholder/);
  assert.throws(() => renderHandoff({ ...i, mode: 'execution', phase: 'start' }), /persisted assignment/);
  assert.throws(() => renderHandoff({ ...i, assignment: { ...assignment(), inspectedSha: 'main' } }), /SHA/);
});
test('report distinguishes publication from closure and original worker SHA from publication head', () => {
  let l = ready(); let report = renderReport(l);
  assert.match(report, /closure unverified/); assert.ok(report.includes(sha)); assert.ok(report.includes(head));
  l = apply(l, 'closure', { issueKey: issue.key, value: { targetSha: head, state: 'CLOSED', stateReason: 'COMPLETED', commentUrl: `${issue.url}#issuecomment-1`, evidence: 'All target requirements verified' } });
  report = renderReport(l); assert.match(report, /verified closure/);
});
test('fixture connects collection, ledger, scheduler, publication, checkpoints and report', () => scratch(async dir => {
  const collected = await collectIssues({ ...searchInput, statePath: join(dir, 'api.json') }, { auth, transport: async () => response(observation([item]).pages[0].data) });
  assert.equal(collected.complete, true);
  let l = initialize({ ...init(), selection: collected });
  l = apply(l, 'groups', { groups: [group] }); l = apply(l, 'stack', { value: stack });
  l = apply(l, 'scheduler', { value: { version: 1, capacity: 1, tasks: [{ id: 'implement', stack: 's', lane: 'implementation', status: 'pending', eligible: true, requires: [] }] } });
  assert.equal(plan(schedulingSnapshot(l)).allocations[0].id, 'implement');
  l = apply(l, 'layer', { stackId: 's', value: layer }); l = apply(l, 'publication', { stackId: 's', verification: publication() });
  assert.equal(l.checkpoints.pending.length, 1); assert.match(renderReport(l), /implemented and published/);
}));
test('every helper CLI provides help without remote access', () => {
  for (const name of ['github-request', 'collect-issues', 'batch-ledger', 'verify-publication', 'batch-checkpoints', 'render-handoff']) {
    const result = spawnSync(process.execPath, [new URL(`./${name}.mjs`, import.meta.url).pathname, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /\.mjs/);
  }
});

test('GraphQL read queries are uncached, errors remain incomplete and mutations cannot bypass write rules', () => scratch(async dir => {
  const gql = { ...input(dir), endpoint: '/graphql', method: 'POST', operation: 'graphql-read', body: { query: 'query { viewer { login } }' } };
  assert.equal((await request(gql, { auth, transport: async () => response({ data: { viewer: { login: 'user' } } }) })).complete, true);
  assert.deepEqual(JSON.parse(readFileSync(gql.statePath)).writes, {});
  assert.deepEqual(JSON.parse(readFileSync(gql.statePath)).cache, {});
  assert.equal((await request(gql, { auth, transport: async () => response({ data: {}, errors: [{ message: 'incomplete' }] }) })).complete, false);
  await assert.rejects(request({ ...gql, body: { query: 'mutation { closeIssue { clientMutationId } }' } }, { auth }), /explicit query/);
}));
test('enterprise request uses enterprise API paths and malformed pagination is blocked', () => scratch(async dir => {
  await request({ ...input(dir), host: 'github.enterprise.test' }, { auth, transport: async url => { assert.equal(url, 'https://github.enterprise.test/api/v3/repos/o/r/issues'); return response([]); } });
  await request({ ...input(dir), host: 'github.enterprise.test', endpoint: '/graphql', method: 'POST', operation: 'graphql-read', body: { query: '{ viewer { login } }' } }, { auth, transport: async url => { assert.equal(url, 'https://github.enterprise.test/api/graphql'); return response({ data: {} }); } });
  await assert.rejects(request({ ...input(dir), paginate: true }, { auth, transport: async () => response([], { link: 'broken; rel="next"' }) }), /Malformed/);
}));
test('5xx and invalid write responses are uncertain, while HTTP rejection is never automatically retried', () => scratch(async dir => {
  const w = { ...input(dir), method: 'PUT', attempt: 'w1' }; let calls = 0;
  const result = await request(w, { auth, transport: async () => { calls++; return response({}, {}, 503); } });
  assert.equal(result.status, 'uncertain'); assert.equal(calls, 1);
  control({ version: 1, action: 'reconcile-write', statePath: w.statePath, attempt: 'w1', evidence: 'Remote confirmed no effects' });
  assert.equal((await request({ ...w, attempt: 'w2' }, { auth, transport: async () => ({ status: 200, headers: {}, text: 'invalid' }) })).status, 'uncertain');
  assert.equal(JSON.parse(readFileSync(w.statePath)).writes.w2.status, 'uncertain');
}));
test('legacy import blocks missing evidence without creating a new ledger', () => scratch(dir => {
  const source = join(dir, 'old.json'), dest = join(dir, 'ledger.json'); save(source, { version: 1 });
  const result = spawnSync(process.execPath, [new URL('./batch-ledger.mjs', import.meta.url).pathname, 'import', dest, source], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stdout, /explicit recovery/); assert.throws(() => readFileSync(dest), /ENOENT/);
}));
test('new independent groups can be confirmed while another stack is building', () => {
  const i2 = { ...issue, key: 'github.com/o/r/3', number: 3, url: 'https://github.com/o/r/issues/3', canonicalOrder: 1 };
  let l = initialize({ ...init(), selection: { ...selection, issues: [issue, i2] } });
  l = apply(l, 'groups', { groups: [group] }); l = apply(l, 'stack', { value: stack });
  l = apply(l, 'group', { value: { ...group, id: 'g2', issues: [i2.key] } }); assert.ok(l.groups.g2);
  assert.throws(() => apply(l, 'group', { value: group }), /Constructed group/);
});
test('pass invalidation during network reads cannot be erased by finishing the captured pass', () => {
  let c = checkpoint(emptyCheckpoints(), { type: 'start', passId: 'p', at: 1000, prs: ['pr'] });
  c = checkpoint(c, { type: 'invalidate', stackId: 's' });
  c = checkpoint(c, { type: 'finish', passId: 'p', at: 2000, refresh: { s: 9999 }, inventory: { complete: true, prs: [{ url: 'pr', state: 'OPEN', headSha: head, baseSha: sha, readAt: 1500, readComplete: true }] } });
  assert.equal(c.inventory.complete, false); assert.equal(c.refresh.s, 0);
});
test('stale or missing head/base inventory cannot qualify as current full coverage', () => {
  const c = checkpoint(emptyCheckpoints(), { type: 'start', passId: 'p', at: 1000, prs: ['pr'] });
  for (const pr of [{ url: 'pr', readComplete: true }, { url: 'pr', state: 'MERGED', headSha: head, baseSha: sha, readAt: 500, readComplete: true }]) {
    assert.equal(checkpoint(c, { type: 'finish', passId: 'p', at: 2000, inventory: { complete: true, prs: [pr] } }).inventory.complete, false);
  }
});
test('implementation and publication START validate actual worker, separate/frozen checkout and SHA coverage', () => {
  let l = building();
  const recorded = { id: 'a', taskId: 'implement', lane: 'implementation', stackId: 's', status: 'reserved', slots: 1, worker: 'child', worktree: '/tmp/worker', startSha: sha };
  l = apply(l, 'assignment', { value: recorded });
  const a = { ...assignment(), assignmentId: 'a', worker: 'child', stackId: 's', groupId: 'g', acceptance: 'Fix behavior', integrationWorktree: '/tmp/stack', dependencyEvidence: 'No prerequisites', startSha: sha, branch: 'kdy1/worker', prerequisiteChecks: 'Independent base revalidated', checkCommands: ['node --test'], repositoryCheckCommands: [], requiredExecutionTimes: 'none' };
  assert.match(renderHandoff({ version: 1, mode: 'execution', role: 'implementation', phase: 'start', ledger: l, assignment: a }), /START only/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'implementation', phase: 'start', ledger: l, assignment: { ...a, worker: 'wrong' } }), /worker identity/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'implementation', phase: 'start', ledger: l, assignment: { ...a, startSha: head } }), /SHA differs/);
  const p = { ...a, checkout: '/tmp/stack', headSha: head, baseSha: sha, headBranch: 'kdy1/fix', baseBranch: 'main', createPrSkill: '/skills/create-pr/SKILL.md', checks: layer.checks, closes: [issue.url], realWorldValidation: 'not-performed', integrationChanged: false };
  const text = renderHandoff({ version: 1, mode: 'execution', role: 'publication', phase: 'prepare', ledger: l, assignment: p });
  assert.match(text, /Read-only preparation/); assert.ok(text.includes(sha)); assert.ok(text.includes(head));
});
test('coordinator maintenance handoff consumes no child slot and preserves conditional gates', () => {
  const l = ready(); const a = { ...assignment(), worker: 'root', batchSkill: '/skills/slop-fix-batch/SKILL.md', batchReference: '/skills/slop-fix-batch/references/batch-maintenance.md', coordinationRoot: '/repo/.git/coordination', capacityAccounting: 'one free slot' };
  assert.match(renderHandoff({ version: 1, mode: 'execution', role: 'maintenance', phase: 'start', ledger: l, assignment: a }), /fresh review\/CI\/membership gates/);
  assert.deepEqual(l.assignments, {});
  assert.throws(() => renderHandoff({ version: 1, mode: 'plan', role: 'maintenance', phase: 'start', ledger: l, assignment: a }), /Plan Mode permits read-only assignments only/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'maintenance', phase: 'start', ledger: building(), assignment: a }), /coordinator identity and ready handoff/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'maintenance', phase: 'start', ledger: l, assignment: { ...a, worker: 'child' } }), /coordinator identity and ready handoff/);
  assert.throws(() => renderHandoff({ version: 1, mode: 'execution', role: 'maintenance', phase: 'start', ledger: l, assignment: { ...a, batchSkill: undefined } }), /absolute path/);
});

test('finished ledger assignments cannot leave stale active slots in scheduler snapshots', () => {
  let l = apply(init(), 'assignment', { value: { id: 'a', taskId: 'implement', lane: 'implementation', status: 'reserved', slots: 1 } });
  l = apply(l, 'scheduler', { value: { version: 1, capacity: 1, tasks: [{ id: 'implement', stack: 's', lane: 'implementation', status: 'active', eligible: false, slots: 1, requires: [] }] } });
  l = apply(l, 'assignment', { value: { ...l.assignments.a, status: 'finished', slots: 0, outcome: 'succeeded', evidence: 'Worker verified complete' } });
  const s = schedulingSnapshot(l); assert.equal(s.tasks[0].status, 'done'); assert.equal(plan(s).accounting.used, 0);
});
test('concurrent shared requests return busy immediately instead of duplicating transport', () => scratch(async dir => {
  let finish; let started;
  const entered = new Promise(resolve => started = resolve);
  const waiting = new Promise(resolve => finish = resolve);
  const a = request(input(dir), { auth, transport: async () => { started(); await waiting; return response([]); } });
  await entered;
  try { assert.equal((await request(input(dir), { auth, transport: () => assert.fail('duplicate transport') })).status, 'busy'); }
  finally { finish(); }
  assert.equal((await a).complete, true);
}));
