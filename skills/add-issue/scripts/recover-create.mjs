import { check, hash, lock, outside, readJson, save, result, version } from './common.mjs';
import { validatePayload, executionGate, permission, images } from './payload.mjs';
import { compare } from './workspace.mjs';
import { exactText } from './verify-recording.mjs';
import { GitHub } from './github.mjs';

// Search indexing alone cannot establish absence after a lost creation response.
// Read the complete, bounded REST inventory twice before releasing one retry.
export function recoverCreate(input, { client = new GitHub(input.payload.target), now = () => Date.now() } = {}) {
  version(input); const p = input.payload; validatePayload(p);
  const c = p.candidates.find(x => x.id === input.candidateId); check(c, 'Unknown candidate');
  const context = { ...input.context, ...(input.context?.candidates?.[c.id] ?? {}) };
  const gate = executionGate({ ...p, candidates: [c] }, context); if (!gate.complete) return gate;
  const auth = context.creationRetry;
  check(auth?.confirmed === true && auth.originalRecorderFinished === true && typeof auth.evidence === 'string' && auth.evidence.trim(), 'Explicit human retry authorization and finished recorder evidence required');
  check(permission(context.recordPermission), 'Current recording permission not verified');
  outside(input.statePath, c.workspace.baseline.repo);
  const release = lock(input.statePath);
  if (!release) return result('blocked', ['Recording ledger is locked']);
  try {
    const ledger = readJson(input.statePath); version(ledger);
    const payloadHash = hash(p); check(ledger.payloadHash === payloadHash, 'Ledger belongs to another payload');
    const state = ledger.candidates[c.id], op = state?.ops?.create;
    check(c.action === 'new issue' && !state?.issueUrl && !c.issueUrl && op?.status === 'uncertain' && !op.receipt && !op.browser, 'Only an uncertain creation without a target or receipt can be recovered');
    check(Object.entries(state.ops).every(([id, x]) => id === 'create' || x.status === 'omitted'), 'Other operations must be reconciled first');
    const started = Date.parse(op.startedAt);
    check(Number.isFinite(started) && now() - started >= 120000, 'Wait at least two minutes after the finished creation attempt');
    const workspace = compare(c.workspace.baseline); if (!workspace.complete) return workspace;
    const imageCheck = images(c.images); if (!imageCheck.complete) return imageCheck;
    check(client.identity() === p.account, 'Authenticated account changed');
    const repo = client.repository();
    check(repo.full_name === p.target.repo && repo.html_url === `https://${p.target.host}/${p.target.repo}` && !repo.archived && repo.has_issues === true, 'Repository changed or unavailable');
    const since = new Date(started - 60000).toISOString();
    const endpoint = `${client.prefix}/issues?state=all&creator=${encodeURIComponent(p.account)}&since=${encodeURIComponent(since)}&sort=created&direction=desc`;
    const observe = () => client.list(endpoint).filter(x => {
      if (x.pull_request) return false;
      check(Number.isFinite(Date.parse(x.created_at)), 'Issue inventory lacks creation provenance');
      // A title/body may have been edited after creation. Any authored issue in
      // this window is a possible receipt until its exact content is verified.
      return Date.parse(x.created_at) >= started - 60000 && x.user?.login === p.account;
    });
    const first = observe(), second = observe();
    const urls = new Set([...first, ...second].map(x => x.html_url));
    if (urls.size) {
      if (urls.size !== 1) return result('blocked', ['Multiple possible creation receipts; do not retry']);
      const url = [...urls][0], issue = client.issue(url);
      if (issue.author !== p.account || issue.title !== c.title || !exactText(c.body, issue.body, c.images, p.target.host)) return result('blocked', ['Possible creation has changed content; do not retry'], { issueUrl: url });
      op.receipt = url; op.status = 'verified'; state.issueUrl = url;
      save(input.statePath, ledger);
      return result('verified', [], { payloadHash, issueUrl: url, recoveredReceipt: true, retryReleased: false });
    }
    // Preserve the full old operation and audit trail; never replace the ledger.
    (state.creationAttempts ??= []).push({ operation: structuredClone(op), recovery: { checkedAt: new Date(now()).toISOString(), endpoint, completeReads: 2, matches: 0, authorization: auth.evidence } });
    delete state.ops.create;
    save(input.statePath, ledger);
    return result('verified', [], { payloadHash, issueUrl: null, recoveredReceipt: false, retryReleased: true });
  } finally { release(); }
}
