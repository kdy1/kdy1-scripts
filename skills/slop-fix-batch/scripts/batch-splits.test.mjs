import test from 'node:test';
import assert from 'node:assert/strict';
import { initialize, applyEvent, validateLedger, groupReferences, ledgerSummary } from './batch-ledger.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { renderReport, renderHandoff } from './render-handoff.mjs';
const sha = 'a'.repeat(40);
const issue = { key: 'github.com/o/r/1', url: 'https://github.com/o/r/issues/1', canonicalOrder: 0 };
const groups = ['foundation', 'consumer', 'completion'].map((id, i, ids) => ({ id, issues: [issue.key], requires: i ? [ids[i - 1]] : [], confirmed: true, acceptance: `Verify ${id}`, dependencyEvidence: 'Consumer needs changed contract' }));
const split = { groups: groups.map(g => g.id), reason: 'Review contract and consumers separately', coverageEvidence: 'All issue requirements mapped from investigation', completionGroup: 'completion', requirements: groups.map(g => ({ id: g.id, acceptance: g.acceptance, groups: [g.id] })) };
function initial() { return initialize({ version: 1, batchId: 'split', coordinator: 'root', repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix selected issues', inspectedSha: sha, query: 'open', selection: { complete: true, query: 'open', issues: [issue] } }); }
function apply(ledger, type, fields) { return applyEvent(ledger, { id: `e${ledger.revision}`, expectedRevision: ledger.revision, at: '2026-10-16T00:00:00Z', type, ...structuredClone(fields) }, 'root'); }
function register() { return apply(initial(), 'split-plan', { groups, splitPlans: { [issue.key]: split } }); }
function building() { return apply(register(), 'stack', { value: { id: 's', phase: 'building', groups: split.groups, layers: [], baseSha: sha, worktree: '/tmp/split-stack', fetchedAt: '2026-10-16T00:00:00Z', revalidationEvidence: 'Verified base' } }); }
function publish(ledger, index) {
  const groupId = groups[index].id, headSha = String(index + 1).repeat(40);
  let next = apply(ledger, 'layer', { stackId: 's', value: { groupId, requirementsSatisfied: true, headSha, workerSha: headSha, checks: [{ command: 'node --test', status: 'passed', sha: headSha }], integrationChanged: false, realWorldValidation: 'not-performed' } });
  const references = groupReferences(next, groupId);
  const previous = next.stacks.s.layers.slice(0, -1).map(l => l.publication.layer);
  const layer = { groupId, url: `https://github.com/o/r/pull/${index + 2}`, headRepository: 'github.com/o/r', headBranch: groupId, baseBranch: index ? groups[index - 1].id : 'main', headSha, baseSha: index ? previous.at(-1).headSha : sha, title: `Implement ${groupId}`, body: `${index === 2 ? 'Closes' : 'Refs'} ${issue.url}`, ...references };
  const layers = [...previous, layer];
  const verification = { version: 1, expected: { stackId: 's', baseBranch: 'main', layers }, observed: { complete: true, attachmentComplete: true, stackId: 's', layers: layers.map(l => ({ ...l, state: 'OPEN', isDraft: false })), attachments: layers.map(l => l.url) } };
  next = apply(next, 'publication', { stackId: 's', verification });
  return { ledger: next, verification };
}
test('three split groups publish sequentially with refs then closes and complete reporting', () => {
  let ledger = building();
  for (let i = 0; i < 3; i++) {
    ledger = publish(ledger, i).ledger;
    assert.deepEqual(groupReferences(ledger, groups[i].id), i === 2 ? { closes: [issue.url], refs: [] } : { closes: [], refs: [issue.url] });
    if (i < 2) assert.match(renderReport(ledger), /partially published; issue incomplete/);
  }
  const report = renderReport(ledger);
  for (const id of split.groups) assert.ok(report.includes(id));
  for (const n of [2, 3, 4]) assert.ok(report.includes(`pull/${n}`));
  assert.match(report, /implemented and published/);
  ledger.stacks.s.maintenance = { prs: [{ url: ledger.stacks.s.layers[0].url, state: 'MERGED', mergeCommitSha: sha }] };
  assert.doesNotMatch(renderReport(ledger), /verified merged at/);
  ledger.stacks.s.maintenance.prs = ledger.stacks.s.layers.map(l => ({ url: l.url, state: 'MERGED', mergeCommitSha: l.headSha }));
  assert.match(renderReport(ledger), /verified merged at/);
});
test('split registration is atomic and cannot replace assigned or published work', () => {
  const original = initial();
  const bad = structuredClone(split); bad.requirements[0].groups = [];
  assert.throws(() => apply(original, 'split-plan', { groups, splitPlans: { [issue.key]: bad } }), /requirement owners/);
  assert.deepEqual(original.groups, {});
  assert.throws(() => apply(register(), 'split-plan', { groups, splitPlans: { [issue.key]: split } }), /replace existing/);
  assert.throws(() => apply(publish(building(), 0).ledger, 'group', { value: groups[0] }), /immutable/);
});
test('invalid duplicate assignment, missing coverage, missing dependencies and cross-stack membership fail', () => {
  assert.throws(() => apply(initial(), 'groups', { groups }), /assigned twice/);
  for (const mutate of [
    l => { l.splitPlans[issue.key].requirements = []; },
    l => { l.splitPlans[issue.key].requirements.pop(); },
    l => { l.groups.completion.requires = []; },
    l => { l.splitPlans[issue.key].groups.pop(); },
  ]) { const l = register(); mutate(l); assert.throws(() => validateLedger(l)); }
  const l = building(); l.stacks.s.groups.pop();
  assert.throws(() => validateLedger(l), /one complete stack/);
});
test('intermediate closure aliases and missing refs are rejected including staged publication', () => {
  const { ledger, verification } = publish(building(), 0);
  for (const closing of [`Closes ${issue.url}`, 'fixes #1', 'Closes #10, #1', 'RESOLVES o/r#1', `Closes [issue](${issue.url})`]) {
    const v = structuredClone(verification);
    v.expected.layers[0].body += `\n${closing}`;
    v.observed.layers[0].body = v.expected.layers[0].body;
    assert.equal(verifyPublication(v).complete, false, closing);
  }
  for (const closing of ['Closes #10', 'Closes other/repo#1']) {
    const unrelated = structuredClone(verification);
    unrelated.expected.layers[0].body += `\n${closing}`; unrelated.observed.layers[0].body = unrelated.expected.layers[0].body;
    assert.equal(verifyPublication(unrelated).complete, true);
  }
  const v = structuredClone(verification);
  v.expected.layers[0].refs = []; v.expected.layers[0].closes = [issue.url];
  v.expected.layers[0].body = `Closes ${issue.url}`; v.observed.layers[0].body = v.expected.layers[0].body;
  assert.throws(() => apply(ledger, 'publication-attempt', { stackId: 's', value: { id: 'attempt', preparedPrefix: v } }), /references differ/);
  const missing = structuredClone(verification); missing.expected.layers[0].body = missing.observed.layers[0].body = 'Partial fix';
  assert.equal(verifyPublication(missing).complete, false);
});
test('blocked intermediate work prevents a ready stack', () => {
  const ledger = publish(building(), 0).ledger;
  assert.throws(() => apply(ledger, 'ready', { stackId: 's', detachedSha: ledger.stacks.s.layers[0].headSha, evidence: 'Only first layer done' }));
  ledger.stacks.s.blocker = 'Consumer checks failed';
  assert.match(renderReport(ledger), /Consumer checks failed/);
  assert.match(renderReport(ledger), /issue incomplete/);
});

test('split plans survive recovery and are included in worker handoffs and receipts', () => {
  const ledger = JSON.parse(JSON.stringify(building()));
  validateLedger(ledger);
  const first = ledger.events[0];
  assert.deepEqual(applyEvent(ledger, first, 'root'), ledger);
  assert.ok(ledgerSummary('/batch/ledger.json', ledger, initial()).changed.issueIds.includes(issue.key));
  const assignment = { scope: 'contract part', repositoryInstructions: 'AGENTS.md', concurrency: 'one slot', estimateEvidence: 'inspected contract', requestHelper: '/skill/github-request.mjs', requestState: '/batch/api.json', schedulerHelper: '/skill/batch-scheduler.mjs', timingState: '/batch/timing.json', ledgerPath: '/batch/ledger.json', checkout: '/tmp/worker', inspectedSha: sha, issueKeys: [issue.key], stackId: 's', groupId: 'foundation', acceptance: groups[0].acceptance, integrationWorktree: '/tmp/split-stack', dependencyEvidence: groups[0].dependencyEvidence };
  const handoff = renderHandoff({ version: 1, mode: 'execution', role: 'preparation', phase: 'prepare', ledger, assignment });
  const context = JSON.parse(handoff.split('## Issue split context\n\n')[1].split('\n\nComplete only')[0]);
  assert.deepEqual(context.splitPlans[issue.key], split);
  assert.deepEqual(context.publicationReferences, { closes: [], refs: [issue.url] });
});
