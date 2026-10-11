import { check, result, text } from '../../add-issue/scripts/common.mjs';

export const successfulActions = ['new issue', 'duplicate comment', 'metadata update', 'existing issue'];
export const summaryMarker = '<!-- collect-review:tracked-issues:v1 -->';
const now = () => new Date().toISOString();

function issueLink(url, s) {
  const u = new URL(text(url, 'verified issue URL'));
  check(u.protocol === 'https:' && u.host === s.target.host &&
    u.pathname.startsWith(`/${s.target.repo}/issues/`) &&
    /^[1-9]\d*$/.test(u.pathname.slice(`/${s.target.repo}/issues/`.length)) &&
    !u.search && !u.hash && !u.username && !u.password, 'Summary issue target mismatch');
  return url;
}
function reviewLink(url, p) {
  const u = new URL(text(url, 'original review URL'));
  check(`${u.origin}${u.pathname}` === p.url && !u.search && !u.username && !u.password &&
    /^#[\w-]+$/.test(u.hash), 'Summary review target mismatch');
  return url;
}
function mergeEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.issueUrl)) groups.set(entry.issueUrl, new Set());
    for (const url of entry.sourceUrls) groups.get(entry.issueUrl).add(url);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([issueUrl, sources]) =>
    ({issueUrl, sourceUrls: [...sources].sort()}));
}
function render(entries) {
  return `${summaryMarker}\n\n${entries.map(entry =>
    `Tracked at ${entry.issueUrl}\n${entry.sourceUrls.map(url => `- [Original review](${url})`).join('\n')}`
  ).join('\n\n')}`;
}
function parse(body, s, p) {
  check(body.startsWith(`${summaryMarker}\n\n`), 'Unsupported existing summary format');
  const entries = body.slice(summaryMarker.length + 2).split('\n\n').map(block => {
    const [first, ...lines] = block.split('\n');
    check(first.startsWith('Tracked at ') && lines.length, 'Unsupported existing summary entry');
    return {issueUrl: issueLink(first.slice('Tracked at '.length), s), sourceUrls: lines.map(line => {
      const match = line.match(/^- \[Original review\]\(([^\s)]+)\)$/);
      check(match, 'Unsupported existing summary review link');
      return reviewLink(match[1], p);
    })};
  });
  return mergeEntries(entries);
}
function eligibleEntries(s, p) {
  return mergeEntries(s.candidates.flatMap(candidate => {
    const outcome = candidate.outcome;
    if (!outcome?.verified || !successfulActions.includes(outcome.action)) return [];
    const sources = candidate.sources.filter(source => source.number === p.number &&
      outcome.confirmedSourceKeys.includes(source.key));
    if (!sources.length) return [];
    return [{issueUrl: issueLink(outcome.issueUrl, s), sourceUrls: sources.map(source => reviewLink(source.url, p))}];
  }));
}

export function summarize(s, input, client, persist = () => {}, reconcileOnly = false) {
  const p = s.prs.find(pr => pr.number === input.number);
  check(p, 'PR outside snapshot');
  const ledger = s.trackingSummaries ??= {};
  const previous = ledger[p.number];
  const attempt = previous?.attempts?.at(-1);
  const pending = attempt && ['uncertain', 'failed'].includes(attempt.status);
  const finish = (status, errors, summary) => {
    ledger[p.number] = summary;
    persist();
    return result(status, errors, {summary});
  };
  const blocked = message => finish('blocked', [message], {...previous, status: pending ? previous.status : 'blocked', errors: [message]});
  if (!reconcileOnly && !pending) {
    check(['default', 'plan'].includes(input.context?.mode), 'Missing current summary mode');
    if (!eligibleEntries(s, p).length) return finish('verified', [], {...previous, status: 'skipped', reason: 'No verified issue outcomes'});
  }
  let comments;
  try {
    check(client.identity() === s.account, 'Authenticated account changed or unavailable');
    comments = client.prComments(p.number).filter(comment => comment.author === s.account && comment.body.includes(summaryMarker));
    check(comments.length <= 1, 'Multiple managed PR summaries; do not create or edit another comment');
  } catch (e) { return blocked(e.message); }
  const existing = comments[0];

  // An interrupted write is only read back. Neither command automatically retries it.
  if (pending || reconcileOnly && attempt) {
    if (existing && existing.body === attempt.body && (!attempt.commentId || existing.id === attempt.commentId)) {
      attempt.status = 'verified';
      attempt.commentId = existing.id;
      attempt.commentUrl = existing.url;
      attempt.verifiedAt = now();
      return finish('verified', [], {...previous, status: 'verified', body: attempt.body, entries: attempt.entries,
        commentId: existing.id, commentUrl: existing.url, errors: [], reconciled: true});
    }
    if (!pending) return blocked('Previously verified summary changed or is missing');
    return finish(attempt.status, ['Prior summary write is not verified; no automatic retry'], {...previous,
      status: attempt.status, errors: ['Prior summary write is not verified; no automatic retry']});
  }
  if (reconcileOnly) {
    if (previous?.status === 'verified' && existing?.id === previous.commentId && existing.body === previous.body)
      return finish('verified', [], {...previous, reconciled: true, errors: []});
    return blocked('No matching retained summary write to reconcile');
  }
  if (previous?.commentId && existing?.id !== previous.commentId)
    return blocked('Previously observed summary is missing or replaced; do not create another comment');

  let entries;
  try { entries = mergeEntries([...(existing ? parse(existing.body, s, p) : []), ...eligibleEntries(s, p)]); }
  catch (e) { return blocked(e.message); }
  const body = render(entries);
  const summary = {...previous, body, entries, commentId: existing?.id ?? null, commentUrl: existing?.url ?? null, errors: []};
  if (input.context.mode === 'plan' || s.draftOnly || s.restrictions?.draftOnly || s.restrictions?.diagnosisOnly)
    return finish('prepared', [], {...summary, status: 'prepared'});
  check(s.authorization.trusted && input.context.trustedAuthorization === true && input.context.summaryAuthorized === true,
    'Summary requires trusted current authorization');
  text(input.context.evidence, 'current summary authorization evidence');
  if (existing?.body === body) return finish('verified', [], {...summary, status: 'verified', unchanged: true});
  if (p.blocked) return blocked(p.blocked);
  let current;
  try { current = client.pr(p.number); }
  catch { p.blocked = 'Source PR head/merged state cannot be verified'; return blocked(p.blocked); }
  if (current.head !== p.head || !current.merged) {
    p.blocked = 'Source PR head or merged state changed';
    return blocked(p.blocked);
  }
  try {
    check(client.identity() === s.account, 'Authenticated account changed or unavailable');
    // Do not overwrite an edit or create a duplicate after the initial read.
    const fresh = client.prComments(p.number).filter(comment => comment.author === s.account && comment.body.includes(summaryMarker));
    check(fresh.length === comments.length && (!existing || fresh[0]?.id === existing.id && fresh[0]?.body === existing.body),
      'PR summary changed before writing; rerun summary');
  } catch (e) { return blocked(e.message); }

  const write = {status: 'uncertain', action: existing ? 'update' : 'create', body, entries,
    commentId: existing?.id ?? null, startedAt: now()};
  ledger[p.number] = {...summary, status: 'uncertain', attempts: [...(previous?.attempts ?? []), write]};
  persist();
  try {
    const receipt = client.writePrComment(p.number, body, existing?.id ?? null);
    check(receipt.author === s.account && receipt.body === body && (!existing || receipt.id === existing.id),
      'Summary response does not confirm intended comment');
    write.commentId = receipt.id;
    write.commentUrl = receipt.url;
  } catch (e) {
    write.error = e.message;
    if (e.definite) write.status = 'failed';
  }
  try {
    const observed = client.prComments(p.number).filter(comment => comment.author === s.account && comment.body.includes(summaryMarker));
    const matching = observed[0];
    if (observed.length === 1 && matching.body === body && (!write.commentId || matching.id === write.commentId)) {
      write.status = 'verified';
      write.commentId = matching.id;
      write.commentUrl = matching.url;
      write.verifiedAt = now();
    }
  } catch (e) { write.readbackError = e.message; }
  return finish(write.status, write.status === 'verified' ? [] : [write.error ?? write.readbackError ?? 'Summary write outcome uncertain'],
    {...ledger[p.number], status: write.status, commentId: write.commentId, commentUrl: write.commentUrl ?? summary.commentUrl,
      errors: write.status === 'verified' ? [] : [write.error ?? write.readbackError ?? 'Summary write outcome uncertain']});
}
