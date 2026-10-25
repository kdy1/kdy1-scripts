import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStackState } from './lib/stack-state.mjs';
const sha = 'a'.repeat(40);
const layers = ['one', 'two', 'three'].map(branch => ({ pr: `https://github.com/o/r/pull/${branch}`, branch, headRepository: 'github.com/o/r' }));
const prs = () => layers.map((l, i) => ({ url: l.pr, headBranch: l.branch, headRepository: l.headRepository, repository: l.headRepository, state: i ? 'OPEN' : 'MERGED', mergeSha: i ? null : sha, baseBranch: i === 2 ? 'two' : 'main' }));
test('merged prefix with verified base containment preserves live chain', () => {
  let checked = 0;
  assert.equal(validateStackState(layers, prs(), (base, merge) => { checked++; assert.equal(base.headBranch, 'two'); assert.equal(merge, sha); return true; }), 1);
  assert.equal(checked, 1);
});
test('rejects a base missing the merged prefix', () => assert.throws(() => validateStackState(layers, prs(), () => false), /does not contain/));
test('rejects closed unmerged and non-prefix merged layers', () => {
  const closed = prs(); closed[0].state = 'CLOSED';
  assert.throws(() => validateStackState(layers, closed), /Closed unmerged/);
  const middle = prs(); middle[2].state = 'MERGED'; middle[2].mergeSha = sha;
  assert.throws(() => validateStackState(layers, middle), /merged prefix/);
});
test('rejects missing merge identity and wrong live parent', () => {
  const missing = prs(); missing[0].mergeSha = null;
  assert.throws(() => validateStackState(layers, missing), /verified merged/);
  const wrong = prs(); wrong[2].baseBranch = 'main';
  assert.throws(() => validateStackState(layers, wrong), /base relationship/);
});
test('ordinary open chain needs no merge containment exception', () => {
  const open = prs(); open[0].state = 'OPEN'; open[1].baseBranch = 'one';
  assert.equal(validateStackState(layers, open, () => { throw Error('unexpected'); }), 0);
});
