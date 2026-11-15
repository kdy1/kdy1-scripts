#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { check, version, nonempty, absolute, readJson, cli } from './helper-common.mjs';
import { LINEAR_ID } from './issue-refs.mjs';
// Reuse $add-issue's Linear GraphQL client and Keychain-backed API key resolution.
import { Linear, sameText } from '../../add-issue/scripts/linear.mjs';
import { resolveToken } from '../../add-issue/scripts/linear-auth.mjs';

const USAGE = 'linear-issues.mjs collect|read|close input.json';
const WORKSPACE = /^[a-z0-9][a-z0-9-]*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = ['completed', 'canceled'];
// The batch fixes open issues only, like `is:open` on GitHub. Linear excludes archived issues by default.
export const OPEN = { state: { type: { nin: CLOSED } } };
const PAGE = 'query($filter:IssueFilter!,$after:String){ issues(first:100, after:$after, filter:$filter, orderBy:createdAt){ nodes { id identifier url } pageInfo { hasNextPage endCursor } } }';
const DETAIL = `query($id:String!){ issue(id:$id){ id identifier url title description priority createdAt updatedAt completedAt canceledAt archivedAt trashed
  state { id name type } team { id key } project { name } parent { identifier url }
  labels(first:50){ nodes { name } pageInfo { hasNextPage } }
  children(first:50){ nodes { identifier url state { type } } pageInfo { hasNextPage } }
  relations(first:50){ nodes { type relatedIssue { identifier url state { type } } } pageInfo { hasNextPage } }
  inverseRelations(first:50){ nodes { type issue { identifier url state { type } } } pageInfo { hasNextPage } }
  attachments(first:50){ nodes { title url sourceType } pageInfo { hasNextPage } } } }`;
const COMMENTS = 'query($id:String!,$after:String){ issue(id:$id){ comments(first:100, after:$after){ nodes { id url body createdAt user { name } } pageInfo { hasNextPage endCursor } } } }';
const STATES = 'query($id:String!,$after:String){ team(id:$id){ states(first:100, after:$after){ nodes { id name type } pageInfo { hasNextPage endCursor } } } }';
const COMMENT = 'query($id:String!){ comment(id:$id){ id url body issue { id } } }';
const STATE = 'query($id:String!){ issue(id:$id){ id identifier url state { id name type } team { id key } } }';

const outcome = (status, fields = {}) => ({ version: 1, complete: !['blocked', 'uncertain'].includes(status), status, ...fields });
const authRequired = (workspace, reason) => outcome('blocked', { reason, authRequired: true, workspace, keyUrl: 'https://linear.app/settings/account/security' });
const optional = async promise => { try { return await promise; } catch (e) { if (e.kind === 'not-found') return null; throw e; } };

export function issueKey(workspace, identifier) { return `linear.app/${workspace}/${identifier}`.toLowerCase(); }

export const selectionQuery = input => `linear:${input.workspace} ${JSON.stringify({ and: [input.filter, OPEN] })}`;
const incomplete = (input, reason) => outcome('blocked', { reason, tracker: 'linear', query: selectionQuery(input), issues: [] });
// Pure: turn ordered issue pages into the canonical fixed list. Both passes must agree exactly.
export function canonicalLinearIssues(input, passes) {
  check(Array.isArray(passes) && passes.length === 2, 'Expected two collection passes');
  const ids = passes.map(nodes => nodes.map(x => x.id));
  if (JSON.stringify(ids[0]) !== JSON.stringify(ids[1])) return incomplete(input, 'Selection changed during collection');
  const issues = [], seen = new Set();
  for (const x of passes[0]) {
    if (seen.has(x.id)) continue;
    const url = new URL(x.url);
    if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.pathname.split('/')[1]?.toLowerCase() !== input.workspace.toLowerCase() || !LINEAR_ID.test(x.identifier)) return incomplete(input, 'Issue outside selected workspace or invalid identity');
    seen.add(x.id);
    issues.push({ key: issueKey(input.workspace, x.identifier), tracker: 'linear', identifier: x.identifier, id: x.id, url: x.url, canonicalOrder: issues.length });
  }
  return outcome('complete', { tracker: 'linear', workspace: input.workspace, query: selectionQuery(input), filter: { and: [input.filter, OPEN] }, total: issues.length, issues });
}

async function collect(input, client) {
  check(input.filter && typeof input.filter === 'object' && !Array.isArray(input.filter), 'Expected a Linear IssueFilter object');
  // The coordinator owns filter interpretation; the helper only adds the open-state condition.
  const filter = { and: [input.filter, OPEN] }, passes = [];
  for (let pass = 0; pass < 2; pass++) {
    try { passes.push(await client.connection(PAGE, { filter }, d => d.issues)); }
    catch (e) {
      if (e.kind === 'auth') throw e;
      return incomplete(input, /bound exhausted/.test(e.message) ? 'Selection exceeds 1000 issues' : `Linear selection failed: ${e.message}`);
    }
  }
  return canonicalLinearIssues(input, passes);
}

async function readIssue(client, identifier) {
  const x = (await optional(client.request(DETAIL, { id: identifier })))?.issue;
  if (!x) return { identifier, found: false };
  const nodes = name => x[name].nodes;
  const truncated = ['labels', 'children', 'relations', 'inverseRelations', 'attachments'].filter(name => x[name].pageInfo.hasNextPage);
  const comments = await client.connection(COMMENTS, { id: x.id }, d => d.issue?.comments);
  return {
    identifier: x.identifier, found: true, id: x.id, url: x.url, title: x.title, description: x.description ?? '', priority: x.priority,
    state: x.state, team: x.team.key, project: x.project?.name ?? null, parent: x.parent, labels: nodes('labels').map(l => l.name),
    createdAt: x.createdAt, updatedAt: x.updatedAt, completedAt: x.completedAt, canceledAt: x.canceledAt, archived: Boolean(x.archivedAt || x.trashed),
    children: nodes('children').map(c => ({ identifier: c.identifier, url: c.url, state: c.state.type })),
    relations: [...nodes('relations').map(r => ({ type: r.type, direction: 'outgoing', ...r.relatedIssue, state: r.relatedIssue.state.type })),
      ...nodes('inverseRelations').map(r => ({ type: r.type, direction: 'incoming', ...r.issue, state: r.issue.state.type }))],
    // Attachments include linked GitHub PRs, which show existing fixing work.
    attachments: nodes('attachments'), comments: comments.map(c => ({ id: c.id, url: c.url, author: c.user?.name ?? null, createdAt: c.createdAt, body: c.body })),
    truncated,
  };
}

async function read(input, client) {
  check(Array.isArray(input.identifiers) && input.identifiers.length && input.identifiers.every(id => LINEAR_ID.test(id)), 'Expected Linear issue identifiers');
  const issues = [];
  for (const identifier of input.identifiers) issues.push(await readIssue(client, identifier));
  const missing = issues.filter(x => !x.found).map(x => x.identifier);
  return outcome(missing.length ? 'blocked' : 'verified', { ...(missing.length ? { reason: `Linear issues not found: ${missing.join(', ')}` } : {}), workspace: input.workspace, issues });
}

// Post one evidence comment with a client-chosen ID, then move the issue to a completed state.
// Rerunning with the same commentId never posts a second comment.
async function close(input, client) {
  check(LINEAR_ID.test(input.identifier ?? ''), 'Expected a Linear issue identifier');
  check(UUID.test(input.commentId ?? ''), 'Expected a client comment UUID recorded before the first attempt');
  check(input.stateId === undefined || UUID.test(input.stateId), 'Invalid completed state ID');
  const body = readFileSync(absolute(input.commentFile), 'utf8'); nonempty(body, 'evidence comment');
  const current = async () => (await optional(client.request(STATE, { id: input.identifier })))?.issue ?? null;
  const ownComment = async () => (await optional(client.request(COMMENT, { id: input.commentId })))?.comment ?? null;
  let issue = await current();
  if (!issue) return outcome('blocked', { reason: `Linear issue ${input.identifier} not found` });
  let comment = await ownComment();
  if (comment && comment.issue.id !== issue.id) return outcome('blocked', { reason: 'The comment ID belongs to another issue' });
  if (!comment && CLOSED.includes(issue.state.type)) return outcome('already-closed', { identifier: issue.identifier, url: issue.url, state: issue.state });
  if (issue.state.type === 'canceled') return outcome('blocked', { reason: 'The issue was canceled after the evidence comment', state: issue.state });
  let target = issue.state.type === 'completed' ? issue.state : null;
  if (!target) {
    const completed = (await client.connection(STATES, { id: issue.team.id }, d => d.team?.states)).filter(s => s.type === 'completed');
    target = input.stateId ? completed.find(s => s.id === input.stateId) : completed.length === 1 ? completed[0] : null;
    if (!target) return outcome('blocked', { reason: input.stateId ? 'stateId is not a completed state of the issue team' : 'Select one completed state with stateId', completedStates: completed });
  }
  if (!comment) {
    try { await client.createComment({ id: input.commentId, issueId: issue.id, body }); }
    catch (e) { if (e.kind === 'auth') throw e; if (e.kind !== 'uncertain') return outcome('blocked', { reason: `Linear rejected the comment: ${e.message}` }); }
    comment = await ownComment();
    if (!comment) return outcome('uncertain', { reason: 'Comment outcome unknown; rerun with the same commentId' });
  }
  if (!sameText(comment.body, body)) return outcome('blocked', { reason: 'The recorded evidence comment differs from commentFile', commentUrl: comment.url });
  if (issue.state.type !== 'completed') {
    try { await client.updateIssue(issue.id, { stateId: target.id }); }
    catch (e) { if (e.kind === 'auth') throw e; if (e.kind !== 'uncertain') return outcome('blocked', { reason: `Linear rejected the state change: ${e.message}`, commentUrl: comment.url }); }
  }
  issue = await current();
  if (issue?.state.type !== 'completed') return outcome('uncertain', { reason: 'Completed state not observed; rerun with the same commentId', commentUrl: comment.url, state: issue?.state ?? null });
  return outcome('verified', { identifier: issue.identifier, url: issue.url, closure: { state: 'completed', stateName: issue.state.name, stateId: issue.state.id, commentUrl: comment.url } });
}

const commands = { collect, read, close };
export async function run(command, input, deps = {}) {
  check(commands[command], USAGE); version(input);
  check(WORKSPACE.test(input.workspace ?? ''), 'Expected the Linear workspace URL key');
  const { token } = resolveToken(input.workspace, deps);
  if (!token) return authRequired(input.workspace, `No Linear API key stored for workspace ${input.workspace}`);
  const client = deps.client ?? new Linear({ token, fetch: deps.fetch });
  try {
    const { organization } = await client.identity();
    if (organization.urlKey.toLowerCase() !== input.workspace.toLowerCase()) return authRequired(input.workspace, `The Linear API key belongs to workspace ${organization.urlKey}`);
    return await commands[command](input, client);
  } catch (e) {
    if (e.kind === 'auth') return authRequired(input.workspace, e.message);
    throw e;
  }
}
cli(import.meta.url, USAGE, ([command, path]) => { check(command && path, USAGE); return run(command, readJson(path)); });
