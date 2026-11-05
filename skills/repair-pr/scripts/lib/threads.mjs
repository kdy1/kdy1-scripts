import { readFileSync } from 'node:fs';
import { assert, git, json } from './common.mjs';
import { loadSession, saveSession } from './session.mjs';
import { verifyPublication } from './publish.mjs';
import { readReviewThreads, isReviewAuthor, isReviewBot } from '../repair-pr.mjs';

function inventory(s) {
  const [owner, name] = s.pr.slug.split('/');
  return readReviewThreads({ owner, name, host: s.pr.host }, s.pr.number);
}
function mutate(s, query, id, body) {
  return json('gh', ['api', '--hostname', s.pr.host, 'graphql', '-f', `query=${query}`, '-F', `threadId=${id}`, ...(body === undefined ? [] : ['-f', `body=${body}`])]);
}
// GitHub marks a thread outdated once its diff hunk changes, which a fixed
// finding's own repair normally does. Only outdating that the same problem's
// repair does not explain needs a recorded reassessment.
function repairChangedPath(s, problem, path) {
  if (!problem.commit || !path) return false;
  const commit = s.stackPublication?.repairCommits?.find(x => x.problemId === problem.id)?.commit ?? problem.commit;
  return git('diff', '--name-only', `${commit}^`, commit).split('\n').includes(path);
}
export function finishThreads(file) {
  const s = loadSession(file);
  verifyPublication(s);
  const { threads, viewerLogin } = inventory(s);
  const work = s.problems.flatMap(p => p.threads.filter(t => t.disposition !== 'blocked').map(t => ({ t, p })));
  const unexplained = [];
  const prepared = work.map(({ t, p }) => {
    const actual = threads.find(x => x.id === t.id);
    assert(actual, `Thread ${t.id} is not in this PR`);
    const eligible = actual.comments.nodes.filter(c => isReviewAuthor(c.author?.login, viewerLogin));
    const finding = t.findingCommentId ? eligible.find(c => c.id === t.findingCommentId) : eligible[0];
    assert(finding, `Thread ${t.id} has no eligible author`);
    let outdated = null;
    if (!actual.isResolved && actual.isOutdated) {
      if (t.disposition === 'fixed' && repairChangedPath(s, p, actual.path)) outdated = 'repair-changed-path';
      else if (t.reassessment) outdated = 'reassessed';
      else unexplained.push(t.id);
    }
    let body = null, bodyError = null;
    if (t.replyBodyFile && !actual.isResolved) {
      assert(t.disposition === 'incorrect' && isReviewBot(finding.author?.login), `Optional replies are allowed only for incorrect bot findings: ${t.id}`);
      assert(t.findingCommentId || eligible.every(c => isReviewBot(c.author?.login)), `Select a bot findingCommentId for a mixed-author thread: ${t.id}`);
      try { body = readFileSync(t.replyBodyFile, 'utf8'); assert(body.trim(), `Empty reply for ${t.id}`); }
      catch (error) { body = null; bodyError = error.message; }
    }
    return { t, actual, body, bodyError, outdated };
  });
  assert(!unexplained.length, `Outdated without a repair of this problem changing the thread's file: ${unexplained.join(', ')}. Reassess each at the current head, then record {"reassessment": {"threadId", "evidence"}} before finishing`);
  saveSession(file, s);
  const failures = [];
  for (const { t, actual, body, bodyError, outdated } of prepared) {
    const outcome = s.threadOutcomes[t.id] ??= {};
    if (outdated) outcome.outdated = outdated;
    if (bodyError && !outcome.reply) {
      outcome.reply = { state: 'failed', error: bodyError };
      failures.push(`Reply not sent: ${t.id}: ${bodyError}`); saveSession(file, s);
    }
    if (actual.isResolved) {
      outcome.resolve = { ...outcome.resolve, state: 'verified', reconciled: true };
      if (outcome.reply?.state === 'attempting' || outcome.reply?.state === 'uncertain') {
        const found = actual.comments.nodes.find(c => c.author?.login?.toLowerCase() === viewerLogin.toLowerCase() && c.body === outcome.reply.body && !outcome.reply.beforeIds.includes(c.id));
        if (found) outcome.reply = { ...outcome.reply, state: 'verified', commentId: found.id };
        else { outcome.reply.state = 'uncertain'; failures.push(`Reply outcome uncertain: ${t.id}`); }
      }
      if (outcome.reply?.state === 'failed') failures.push(`Reply not sent: ${t.id}: ${outcome.reply.error}`);
      saveSession(file, s); continue;
    }
    if (body && !outcome.reply) {
      outcome.reply = { state: 'attempting', body, beforeIds: actual.comments.nodes.map(c => c.id), at: new Date().toISOString() }; saveSession(file, s);
      try {
        const result = mutate(s, 'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) { comment { id url } } }', t.id, body);
        const comment = result?.data?.addPullRequestReviewThreadReply?.comment;
        assert(comment?.id, 'GitHub did not confirm the reply');
        outcome.reply = { ...outcome.reply, state: 'verified', commentId: comment.id, url: comment.url };
      } catch (error) { outcome.reply.state = 'uncertain'; outcome.reply.error = error.message; failures.push(`Reply failed or uncertain: ${t.id}: ${error.message}`); }
      saveSession(file, s);
    } else if (outcome.reply?.state === 'failed') {
      failures.push(`Reply not sent; no retry: ${t.id}: ${outcome.reply.error}`);
    } else if (outcome.reply && outcome.reply.state !== 'verified') {
      const fresh = inventory(s).threads.find(x => x.id === t.id);
      const found = fresh?.comments.nodes.find(c => c.author?.login?.toLowerCase() === viewerLogin.toLowerCase() && c.body === outcome.reply.body && !outcome.reply.beforeIds.includes(c.id));
      if (found) outcome.reply = { ...outcome.reply, state: 'verified', commentId: found.id };
      else { outcome.reply.state = 'uncertain'; failures.push(`Reply outcome uncertain; no retry: ${t.id}`); }
      saveSession(file, s);
    }
    if (outcome.resolve) {
      // An interrupted request that is still unresolved is not permission to retry.
      outcome.resolve.state = 'uncertain'; saveSession(file, s);
      failures.push(`Resolution outcome uncertain; no retry: ${t.id}`); continue;
    }
    outcome.resolve = { state: 'attempting', at: new Date().toISOString() }; saveSession(file, s);
    try {
      const result = mutate(s, 'mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }', t.id);
      const resolved = result?.data?.resolveReviewThread?.thread;
      assert(resolved?.id === t.id && resolved.isResolved === true, 'GitHub did not confirm resolution');
      outcome.resolve.state = 'verified';
    } catch (error) { outcome.resolve.state = 'uncertain'; outcome.resolve.error = error.message; failures.push(`Resolution failed or uncertain: ${t.id}: ${error.message}`); }
    saveSession(file, s);
  }
  return { complete: failures.length === 0, outcomes: s.threadOutcomes, failures, blocked: s.problems.flatMap(p => p.threads.filter(t => t.disposition === 'blocked').map(t => t.id)) };
}
