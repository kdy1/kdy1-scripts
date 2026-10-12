import { check, hash, lock, outside, result, version } from './common.mjs';
import { readLedger, saveLedger } from './ledger-storage.mjs';
import { validatePayload, executionGate, permission, images } from './payload.mjs';
import { compare } from './workspace.mjs';
import { exactText } from './verify-recording.mjs';
import { GitHub } from './github.mjs';
import { readFileSync, statSync } from 'node:fs';

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
    const ledger = readLedger(input.statePath); version(ledger);
    const payloadHash = hash(p); check(ledger.payloadHash === payloadHash, 'Ledger belongs to another payload');
    const state = ledger.candidates[c.id], op = state?.ops?.create;
    check(c.action === 'new issue' && !state?.issueUrl && !c.issueUrl && op?.status === 'uncertain' && !op.receipt && !op.browser, 'Only an uncertain creation without a target or receipt can be recovered');
    check(Object.entries(state.ops).every(([id, x]) => id === 'create' || x.status === 'omitted'), 'Other operations must be reconciled first');
    const started = Date.parse(op.startedAt);
    let finished = Date.parse(op.finishedAt), completion = { kind: 'finished-at', finishedAt: op.finishedAt };
    if (!Number.isFinite(finished)) {
      // Prefer the original result. An interrupted legacy recorder may never
      // have published it, while its following serialized journal still proves
      // the failed synchronous command had returned before that later start.
      const proof = auth.completionResult;
      if (proof) {
        check(proof.path && proof.sha256, 'Legacy attempt requires its original completion result');
        outside(proof.path, c.workspace.baseline.repo);
        const bytes = readFileSync(proof.path), stat = statSync(proof.path);
        check(stat.isFile() && hash(bytes) === proof.sha256, 'Completion result changed');
        const output = JSON.parse(bytes.toString('utf8'));
        const retained = output.outcomes?.find(x => x.candidateId === c.id)?.operations?.create;
        check(output.payloadHash === payloadHash && retained && hash(retained) === hash(op), 'Completion result belongs to another attempt');
        finished = stat.mtimeMs;
        completion = { kind: 'original-result', ...proof, finishedBy: new Date(finished).toISOString() };
      } else {
        const index = p.candidates.findIndex(x => x.id === c.id);
        const later = p.candidates.slice(index + 1).map(other => ({ other, operation: ledger.candidates[other.id]?.ops?.create }))
          .filter(x => x.operation && Date.parse(x.operation.startedAt) > started)
          .sort((a, b) => Date.parse(a.operation.startedAt) - Date.parse(b.operation.startedAt))[0];
        check(typeof op.error === 'string' && op.error.trim() && later, 'Legacy attempt requires its original completion result or a following serialized creation journal after a persisted command error');
        finished = Date.parse(later.operation.startedAt);
        completion = { kind: 'following-journal', candidateId: later.other.id, operationId: 'create', operationHash: hash(later.operation), finishedBy: later.operation.startedAt };
      }
    }
    check(Number.isFinite(started) && finished >= started && finished <= now() && now() - finished >= 120000, 'Wait at least two minutes after the finished creation attempt');
    const workspace = compare(c.workspace.baseline); if (!workspace.complete) return workspace;
    const imageCheck = images(c.images); if (!imageCheck.complete) return imageCheck;
    check(client.identity() === p.account, 'Authenticated account changed');
    const repo = client.repository();
    check(repo.full_name === p.target.repo && repo.html_url === `https://${p.target.host}/${p.target.repo}` && !repo.archived && repo.has_issues === true, 'Repository changed or unavailable');
    const since = new Date(started - 60000).toISOString();
    const until = new Date(finished + 60000).toISOString();
    const endpoint = `${client.prefix}/issues?state=all&creator=${encodeURIComponent(p.account)}&since=${encodeURIComponent(since)}&sort=created&direction=desc`;
    // Other screens can have verified receipts inside the conservative legacy
    // completion window. Exclude only exact, fully completed records from this
    // same ledger, never an unexplained or changed authored issue.
    const knownOthers = new Map();
    for (const other of p.candidates) {
      const known = ledger.candidates[other.id];
      if (other.id !== c.id && other.title !== c.title && known?.outcome?.complete === true && known.ops?.create?.status === 'verified' && known.ops.create.receipt === known.issueUrl)
        knownOthers.set(known.issueUrl, other);
    }
    const excluded = new Set();
    const observe = () => client.list(endpoint).filter(x => {
      if (x.pull_request) return false;
      check(Number.isFinite(Date.parse(x.created_at)), 'Issue inventory lacks creation provenance');
      // A title/body may have been edited after creation. Any authored issue in
      // this window is a possible receipt until its exact content is verified.
      const created = Date.parse(x.created_at);
      const other = knownOthers.get(x.html_url);
      if (x.user?.login === p.account && other && x.title === other.title && exactText(other.body, x.body ?? '', other.images, p.target.host) && !exactText(c.body, x.body ?? '', c.images, p.target.host)) {
        const current = client.issue(x.html_url);
        if (current.author === p.account && current.title === other.title && exactText(other.body, current.body, other.images, p.target.host)) { excluded.add(x.html_url); return false; }
      }
      return created >= started - 60000 && x.user?.login === p.account &&
        (created <= finished + 60000 || x.title === c.title || exactText(c.body, x.body ?? '', c.images, p.target.host));
    });
    const first = observe(), second = observe();
    const urls = new Set([...first, ...second].map(x => x.html_url));
    if (urls.size) {
      if (urls.size !== 1) return result('blocked', ['Multiple possible creation receipts; do not retry']);
      const url = [...urls][0], issue = client.issue(url);
      if (issue.author !== p.account || issue.title !== c.title || !exactText(c.body, issue.body, c.images, p.target.host)) return result('blocked', ['Possible creation has changed content; do not retry'], { issueUrl: url });
      op.receipt = url; op.status = 'verified'; state.issueUrl = url;
      saveLedger(input.statePath, ledger);
      return result('verified', [], { payloadHash, issueUrl: url, recoveredReceipt: true, retryReleased: false });
    }
    // Preserve the full old operation and audit trail; never replace the ledger.
    (state.creationAttempts ??= []).push({ operation: structuredClone(op), recovery: { checkedAt: new Date(now()).toISOString(), endpoint, since, until, completion, completionResult: auth.completionResult ?? null, excludedVerifiedReceipts: [...excluded], completeReads: 2, matches: 0, authorization: auth.evidence } });
    delete state.ops.create;
    saveLedger(input.statePath, ledger);
    return result('verified', [], { payloadHash, issueUrl: null, recoveredReceipt: false, retryReleased: true });
  } finally { release(); }
}
