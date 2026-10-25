import { assert, api } from './common.mjs';

// Completed prefixes remain in the immutable registry. Only a verified merged
// prefix may be excluded from the live parent chain; closed/unmerged PRs block.
export function validateStackState(layers, actuals, contains = remoteContains) {
  let firstOpen = -1;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i], a = actuals[i];
    assert(a && a.url === l.pr && a.headRepository === l.headRepository && a.headBranch === l.branch, 'Registered stack identity mismatch');
    if (a.state === 'MERGED') {
      assert(firstOpen < 0 && /^[a-f0-9]{40,64}$/.test(a.mergeSha ?? ''), 'Only a verified merged prefix may precede open layers');
    } else {
      assert(a.state === 'OPEN', 'Closed unmerged stack layer requires reconciliation');
      if (firstOpen < 0) firstOpen = i;
      else {
        const parent = actuals[i - 1];
        assert(a.baseBranch === parent.headBranch && a.repository === parent.headRepository, 'Registered stack base relationship mismatch');
      }
    }
  }
  assert(firstOpen >= 0, 'Stack has no open layers');
  for (let i = 0; i < firstOpen; i++) {
    assert(actuals[i].repository === actuals[firstOpen].repository && contains(actuals[firstOpen], actuals[i].mergeSha), 'Open stack base does not contain the merged prefix');
  }
  return firstOpen;
}
function remoteContains(base, commit) {
  const comparison = api(base.host, `repos/${base.slug}/compare/${commit}...${base.baseSha}`);
  return comparison.merge_base_commit?.sha === commit && ['ahead', 'identical'].includes(comparison.status);
}
