import test from 'node:test';
import assert from 'node:assert/strict';
import { initialize, applyEvent, validateLedger, groupReferences } from './batch-ledger.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { renderHandoff, renderReport } from './render-handoff.mjs';
const sha = 'a'.repeat(40);
const issue = { key: 'linear.app/acme/eng-1', tracker: 'linear', identifier: 'ENG-1', id: '00000000-0000-4000-8000-000000000001', url: 'https://linear.app/acme/issue/ENG-1/slug', canonicalOrder: 0 };
const groups = ['contract', 'completion'].map((id, i, ids) => ({ id, issues: [issue.key], requires: i ? [ids[i - 1]] : [], confirmed: true, acceptance: `Verify ${id}`, dependencyEvidence: 'Consumer needs changed contract' }));
const split = { groups: groups.map(g => g.id), reason: 'Review separately', coverageEvidence: 'All requirements mapped', completionGroup: 'completion', requirements: groups.map(g => ({ id: g.id, acceptance: g.acceptance, groups: [g.id] })) };
const query = 'linear:acme {"and":[{"team":{"key":{"eq":"ENG"}}},{"state":{"type":{"nin":["completed","canceled"]}}}]}';
function initial() { return initialize({ version: 1, batchId: 'linear', coordinator: 'root', repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix Linear issues', inspectedSha: sha, query, selection: { complete: true, tracker: 'linear', workspace: 'acme', query, issues: [issue] } }); }
function apply(ledger, type, fields) { return applyEvent(ledger, { id: `e${ledger.revision}`, expectedRevision: ledger.revision, at: '2026-11-15T00:00:00Z', type, ...structuredClone(fields) }, 'root'); }
function building() {
  const l = apply(initial(), 'split-plan', { groups, splitPlans: { [issue.key]: split } });
  return apply(l, 'stack', { value: { id: 's', phase: 'building', groups: split.groups, layers: [], baseSha: sha, worktree: '/tmp/linear-stack', fetchedAt: '2026-11-15T00:00:00Z', revalidationEvidence: 'Verified base' } });
}
function publish(ledger, index, body) {
  const groupId = groups[index].id, headSha = String(index + 1).repeat(40);
  const next = apply(ledger, 'layer', { stackId: 's', value: { groupId, requirementsSatisfied: true, headSha, workerSha: headSha, checks: [{ command: 'node --test', status: 'passed', sha: headSha }], integrationChanged: false, realWorldValidation: { status: 'not-applicable', reason: 'Internal refactor only' } } });
  const previous = next.stacks.s.layers.slice(0, -1).map(l => l.publication.layer);
  const layer = { groupId, url: `https://github.com/o/r/pull/${index + 2}`, headRepository: 'github.com/o/r', headBranch: `kdy1/${groupId}`, baseBranch: index ? previous.at(-1).headBranch : 'main', headSha, baseSha: index ? previous.at(-1).headSha : sha, title: `fix: ${groupId}`, body, ...groupReferences(next, groupId) };
  const layers = [...previous, layer];
  const verification = { version: 1, runtime: 'claude-code', expected: { stackId: 's', baseBranch: 'main', layers }, observed: { complete: true, attachmentStatus: 'not-applicable', attachments: [], stackId: 's', layers: layers.map(l => ({ ...l, state: 'OPEN', isDraft: false })) } };
  return { next, verification };
}
const claude = l => { l.context.runtime = 'claude-code'; return l; };

test('Linear split issues publish Ref then Closes by identifier and close through a completed state', () => {
  let ledger = claude(building());
  assert.deepEqual(groupReferences(ledger, 'contract'), { closes: [], refs: ['ENG-1'] });
  let { next, verification } = publish(ledger, 0, 'Contract change\n\nRef ENG-1');
  ledger = apply(next, 'publication', { stackId: 's', verification });
  ({ next, verification } = publish(ledger, 1, 'Completion\n\nCloses ENG-1'));
  ledger = apply(next, 'publication', { stackId: 's', verification });
  assert.match(renderReport(ledger), /implemented and published/);
  assert.throws(() => apply(ledger, 'closure', { issueKey: issue.key, value: { targetSha: sha, state: 'CLOSED', stateReason: 'COMPLETED', commentUrl: `${issue.url}#comment-1`, evidence: 'Verified' } }), /Closure not verified/);
  ledger = apply(ledger, 'closure', { issueKey: issue.key, value: { targetSha: sha, state: 'completed', stateName: 'Done', stateId: 'state', commentUrl: `${issue.url}#comment-1`, evidence: 'Verified' } });
  assert.match(renderReport(ledger), /verified closure/);
});

test('Linear reference lines, closing aliases, titles and branches are verified', () => {
  const { verification } = publish(claude(building()), 0, 'Contract change\n\nRef ENG-1');
  assert.equal(verifyPublication(verification).complete, true);
  const variant = change => { const v = structuredClone(verification); change(v.expected.layers[0]); Object.assign(v.observed.layers[0], v.expected.layers[0]); return verifyPublication(v).complete; };
  for (const body of ['Contract\n\nRefs ENG-1', 'Contract', 'Ref ENG-1\nfixes eng-1', 'Ref ENG-1\nCompletes https://linear.app/acme/issue/ENG-1/slug', 'Ref ENG-1\nClosing ENG-1.']) assert.equal(variant(l => { l.body = body; }), false, body);
  for (const body of ['Ref ENG-1\nCloses ENG-10', 'Ref ENG-1\nFixes DES-1']) assert.equal(variant(l => { l.body = body; }), true, body);
  assert.equal(variant(l => { l.title = 'fix(ENG-1): contract'; }), false);
  assert.equal(variant(l => { l.headBranch = 'kdy1/eng-1-contract'; }), false);
  assert.equal(variant(l => { l.headBranch = 'kdy1/eng-10-contract'; }), true);
});

test('Linear fixed issues require identifiers and appear in worker handoffs', () => {
  const ledger = building();
  const bad = structuredClone(ledger); delete bad.fixedIssues[0].identifier;
  assert.throws(() => validateLedger(bad), /Linear issue identifier/);
  const unknown = structuredClone(ledger); unknown.fixedIssues[0].tracker = 'jira';
  assert.throws(() => validateLedger(unknown), /Unknown issue tracker/);
  const github = { key: 'github.com/o/r/1', url: 'https://github.com/o/r/issues/1', canonicalOrder: 0 };
  assert.throws(() => initialize({ version: 1, batchId: 'x', coordinator: 'root', repository: 'github.com/o/r', baseBranch: 'main', remote: 'origin', authorization: 'Fix', inspectedSha: sha, query, selection: { complete: true, tracker: 'linear', query, issues: [github] } }), /tracker mismatch/);
  const assignment = { scope: 'contract part', repositoryInstructions: 'AGENTS.md', concurrency: 'one slot', estimateEvidence: 'inspected contract', requestHelper: '/skill/github-request.mjs', requestState: '/batch/api.json', schedulerHelper: '/skill/batch-scheduler.mjs', timingState: '/batch/timing.json', ledgerPath: '/batch/ledger.json', checkout: '/tmp/worker', inspectedSha: sha, issueKeys: [issue.key] };
  const handoff = renderHandoff({ version: 1, mode: 'execution', role: 'investigation', phase: 'prepare', ledger, assignment });
  assert.match(handoff, /## Linear issues\n\n- ENG-1: https:\/\/linear\.app\/acme\/issue\/ENG-1\/slug/);
  assert.match(handoff, /linear-issues\.mjs read/);
  assert.match(handoff, /Do not edit source, refs, GitHub or Linear/);
});
