import { GitHub as Base } from '../../add-issue/scripts/github.mjs';
import { check, run } from '../../add-issue/scripts/common.mjs';

export function authorship(user, app = null) {
  const login = user?.login ?? null, type = user?.type ?? user?.__typename ?? null;
  const codex = ['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector'].includes(login) && type === 'Bot';
  return { status: codex ? 'codex' : type === 'User' ? 'other' : 'uncertain', login, id: user?.node_id ?? user?.id ?? null, type, app };
}
export const threadFingerprint = t => JSON.stringify({ id: t.id, pr: t.pullRequest?.url, comments: t.comments.nodes });
export class GitHub extends Base {
  constructor(target, options = {}) {
    const maxPages = options.maxPages ?? 10000;
    check(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 10000, 'Invalid page bound');
    super(target, {...options,maxPages:Math.min(maxPages,100)}); this.maxPages = maxPages;
  }
  pr(number) {
    const p = this.api(`${this.prefix}/pulls/${number}`);
    check(p.number === number && p.html_url === `https://${this.target.host}/${this.target.repo}/pull/${number}`, 'PR target mismatch');
    check(/^[a-f\d]{40,64}$/i.test(p.head?.sha ?? '') && typeof p.merged === 'boolean', 'Incomplete PR metadata');
    return { number, url: p.html_url, head: p.head.sha, merged: p.merged, nodeId: p.node_id };
  }
  merged(cutoff) {
    const [owner, name] = this.target.repo.split('/');
    return this.connection(`query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number mergedAt} pageInfo{hasNextPage endCursor}}}}`, {owner,name}, x => x.repository?.pullRequests).filter(x => {
      check(typeof x.mergedAt === 'string' && Number.isFinite(Date.parse(x.mergedAt)), 'Missing merge timestamp');
      return !cutoff || Date.parse(x.mergedAt) <= Date.parse(cutoff);
    }).map(x => x.number);
  }
  connection(query, variables, select) {
    const nodes = []; let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const c = select(this.graphql(query, {...variables,cursor}));
      check(Array.isArray(c?.nodes) && c.nodes.every(Boolean) && typeof c.pageInfo?.hasNextPage === 'boolean', 'Incomplete GraphQL connection');
      nodes.push(...c.nodes);
      if (!c.pageInfo.hasNextPage) return nodes;
      check(c.pageInfo.endCursor && c.pageInfo.endCursor !== cursor, 'Invalid GraphQL cursor'); cursor = c.pageInfo.endCursor;
    }
    throw new Error('GraphQL pagination bound reached');
  }
  threads(pr) {
    const nodes = this.connection(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated viewerCanResolve path line originalLine diffSide startLine originalStartLine pullRequest{url} comments(first:100){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`, {id:pr.nodeId}, x => x.node?.reviewThreads);
    return nodes.map(t => this.completeThread(t, pr));
  }
  completeThread(t, pr) {
    check(t?.id && t.pullRequest?.url === pr.url && typeof t.isResolved === 'boolean' && typeof t.isOutdated === 'boolean', 'Incomplete or mismatched thread');
    check(Array.isArray(t.comments?.nodes) && t.comments.nodes.every(Boolean) && typeof t.comments.pageInfo?.hasNextPage === 'boolean', 'Incomplete thread comments');
    // Complete the inventory even for resolved threads, so REST comments can be excluded.
    if (t.comments.pageInfo.hasNextPage) {
      const all = this.connection(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}}}}`, {id:t.id}, x => x.node?.comments);
      t.comments = {nodes:all,pageInfo:{hasNextPage:false,endCursor:null}};
    }
    if (!t.isResolved) check(t.comments.nodes.length > 0, 'Empty unresolved thread');
    return t;
  }
  thread(id, pr) {
    const t = this.graphql(`query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved isOutdated viewerCanResolve path line originalLine diffSide startLine originalStartLine pullRequest{url} comments(first:100){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}}}}`, {id}).node;
    return this.completeThread(t, pr);
  }
  resolve(id) { return this.graphql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}', {id}).resolveReviewThread?.thread; }
  prComment(raw, number) {
    check(Number.isSafeInteger(raw?.id) && raw.id > 0 && typeof raw.body === 'string' && typeof raw.user?.login === 'string',
      'Incomplete PR comment');
    check(raw.html_url === `https://${this.target.host}/${this.target.repo}/pull/${number}#issuecomment-${raw.id}`,
      'PR comment target mismatch');
    return {id: raw.id, url: raw.html_url, body: raw.body, author: raw.user.login};
  }
  prComments(number) {
    check(Number.isSafeInteger(number) && number > 0, 'Invalid PR number');
    return this.list(`${this.prefix}/issues/${number}/comments`).map(raw => this.prComment(raw, number));
  }
  writePrComment(number, body, commentId = null) {
    check(Number.isSafeInteger(number) && number > 0 && typeof body === 'string' && body.trim(), 'Invalid PR summary');
    check(commentId === null || Number.isSafeInteger(commentId) && commentId > 0, 'Invalid PR comment ID');
    const endpoint = commentId === null ? `${this.prefix}/issues/${number}/comments` : `${this.prefix}/issues/comments/${commentId}`;
    return this.prComment(this.api(endpoint, commentId === null ? 'POST' : 'PATCH', {body}), number);
  }
}
const commentFields = 'id databaseId url body author{__typename login ... on User{id} ... on Bot{id}} originalCommit{oid} commit{oid} pullRequestReview{id} path line originalLine diffHunk createdAt updatedAt';

export function resolveScope(input, transport = run) {
  let target = input.target ?? null; const numbers = [];
  const accept = t => { if (target) check(target.host.toLowerCase() === t.host.toLowerCase() && target.repo.toLowerCase() === t.repo.toLowerCase(), 'Mixed repository scope'); else target = t; };
  const scopes = input.scope === undefined ? [] : Array.isArray(input.scope) ? input.scope : [input.scope];
  check(input.scope === undefined || scopes.length > 0,'Explicit empty PR selection');
  for (const scope of scopes) {
    if (Number.isSafeInteger(scope) && scope > 0) { numbers.push(scope); continue; }
    check(typeof scope === 'string', 'Invalid scope');
    if (/^#?[1-9]\d*$/.test(scope)) { numbers.push(Number(scope.replace('#',''))); continue; }
    if (/^[\w.-]+\/[\w.-]+$/.test(scope)) { accept({host:target?.host ?? 'github.com',repo:scope}); continue; }
    const u = new URL(scope), m = u.pathname.match(/^\/([\w.-]+\/[\w.-]+)(?:\/pull\/([1-9]\d*))?\/?$/);
    check(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && m, 'Invalid repository/PR URL');
    accept({host:u.host,repo:m[1]}); if (m[2]) numbers.push(Number(m[2]));
  }
  if (!target) {
    check(typeof input.checkout === 'string', 'No unique target; provide target or checkout');
    const r = transport('gh',['repo','view','--json','nameWithOwner,url'],{cwd:input.checkout});
    check(r.ok, 'Cannot resolve checkout repository'); const value = JSON.parse(r.stdout), u = new URL(value.url);
    accept({host:u.host,repo:value.nameWithOwner});
  }
  check(numbers.every(n => Number.isSafeInteger(n) && n > 0),'Invalid PR number');
  return {target,numbers:[...new Set(numbers)]};
}
