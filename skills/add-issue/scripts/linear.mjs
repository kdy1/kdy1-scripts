import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { absolute, check, hash, lock, outside, readJson, result, same, save, text, version } from './common.mjs';
import { executionGate, images as checkImages, permission, validateCandidateCore, validateImageFields } from './payload.mjs';
import { compare } from './workspace.mjs';

export const API = 'https://api.linear.app/graphql';
export const kinds = ['label', 'priority', 'estimate', 'state', 'project', 'cycle', 'assignee'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE = /^[a-z0-9][a-z0-9-]*$/i;
const TEAM = /^[A-Z0-9]{1,10}$/i;
const CLOSED = ['completed', 'canceled'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const ISSUE = 'id identifier url title description priority estimate archivedAt trashed creator { id } state { id type } team { id key } project { id } cycle { id } assignee { id } labelIds';
const now = () => new Date().toISOString();

// kind: auth (stop and re-store the key), rejected (definite failure), not-found, uncertain (outcome unknown).
export class LinearError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
const rethrowAuth = e => { if (e?.kind === 'auth') throw e; };

export class Linear {
  constructor({ token, fetch = globalThis.fetch, endpoint = API, maxPages = 10 }) {
    text(token, 'Linear API key'); this.token = token; this.fetch = fetch; this.endpoint = endpoint; this.maxPages = maxPages;
  }
  async request(query, variables = {}) {
    let res, body = null;
    try { res = await this.fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.token }, body: JSON.stringify({ query, variables }) }); }
    catch (e) { throw new LinearError('uncertain', `Linear request failed: ${e.cause?.code ?? e.name}`); }
    try { body = await res.json(); } catch { body = null; }
    const errors = body?.errors ?? [];
    const code = e => String(e.extensions?.code ?? e.extensions?.type ?? '');
    if (res.status === 401 || errors.some(e => /AUTHENTICATION/i.test(code(e)))) throw new LinearError('auth', 'Linear API key is invalid, expired, or revoked');
    if (res.status === 429 || res.status >= 500 || errors.some(e => /RATELIMIT/i.test(code(e)))) throw new LinearError('uncertain', `Linear HTTP ${res.status}`);
    if (errors.length) { const message = errors.map(e => e.message).join('; '); throw new LinearError(/not found/i.test(message) ? 'not-found' : 'rejected', message); }
    if (!res.ok || !body?.data) throw new LinearError('rejected', `Linear HTTP ${res.status}`);
    return body.data;
  }
  async connection(query, variables, pick) {
    const nodes = []; let after = null;
    for (let page = 0; page < this.maxPages; page++) {
      const conn = pick(await this.request(query, { ...variables, after }));
      check(conn, 'Linear connection unavailable');
      nodes.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) return nodes;
      after = conn.pageInfo.endCursor;
    }
    throw new Error('Linear pagination bound exhausted');
  }
  async identity() {
    const d = await this.request('query { viewer { id name email active } organization { id urlKey name } }');
    return { viewer: d.viewer, organization: d.organization };
  }
  async teams() { return this.connection('query($after:String){ teams(first:100, after:$after){ nodes { id key name } pageInfo { hasNextPage endCursor } } }', {}, d => d.teams); }
  async team(key) {
    const d = await this.request('query($key:String!){ teams(first:2, filter:{ key:{ eq:$key } }){ nodes { id key name archivedAt retiredAt issueEstimationType issueEstimationAllowZero issueEstimationExtended } } }', { key });
    check(d.teams.nodes.length === 1, `Linear team ${key} not found`);
    return d.teams.nodes[0];
  }
  async issue(id) {
    try { return (await this.request(`query($id:String!){ issue(id:$id){ ${ISSUE} } }`, { id })).issue ?? null; }
    catch (e) { if (e.kind === 'not-found') return null; throw e; }
  }
  async comment(id) {
    try { return (await this.request('query($id:String!){ comment(id:$id){ id url body user { id } issue { id } } }', { id })).comment ?? null; }
    catch (e) { if (e.kind === 'not-found') return null; throw e; }
  }
  async comments(issueId) {
    const nodes = await this.connection('query($id:String!,$after:String){ issue(id:$id){ comments(first:100, after:$after){ nodes { id url body user { id } } pageInfo { hasNextPage endCursor } } } }', { id: issueId }, d => d.issue?.comments);
    return nodes.map(observeComment).sort((a, b) => a.id.localeCompare(b.id));
  }
  // Deterministic keyword query over open issues in the team. An overflowing result set is unavailable, not empty.
  async duplicates(teamId, terms, limit) {
    const filter = { team: { id: { eq: teamId } }, state: { type: { nin: CLOSED } }, or: terms.flatMap(t => [{ title: { containsIgnoreCase: t } }, { description: { containsIgnoreCase: t } }]) };
    const d = await this.request('query($filter:IssueFilter!,$first:Int!){ issues(first:$first, filter:$filter){ nodes { id identifier url title state { type } } pageInfo { hasNextPage } } }', { filter, first: limit });
    check(!d.issues.pageInfo.hasNextPage, 'Duplicate query exceeded its bound; use narrower terms');
    return d.issues.nodes.map(x => ({ id: x.id, identifier: x.identifier, url: x.url, title: x.title, state: x.state.type })).sort(byIdentifier);
  }
  async discover(team) {
    const scoped = (field, fields) => this.connection(`query($id:String!,$after:String){ team(id:$id){ ${field}(first:100, after:$after){ nodes { ${fields} } pageInfo { hasNextPage endCursor } } } }`, { id: team.id }, d => d.team?.[field]);
    return {
      labels: (await this.connection('query($id:ID!,$after:String){ issueLabels(first:100, after:$after, filter:{ or:[{ team:{ id:{ eq:$id } } }, { team:{ null:true } }] }){ nodes { id name description isGroup archivedAt team { id } parent { name } } pageInfo { hasNextPage endCursor } } }', { id: team.id }, d => d.issueLabels))
        .filter(x => !x.archivedAt).map(x => ({ id: x.id, name: x.name, teamId: x.team?.id ?? null, description: x.description, isGroup: x.isGroup, parent: x.parent?.name ?? null })),
      states: (await scoped('states', 'id name type archivedAt')).filter(x => !x.archivedAt).map(x => ({ id: x.id, name: x.name, type: x.type, teamId: team.id })),
      projects: (await scoped('projects', 'id name archivedAt')).filter(x => !x.archivedAt).map(x => ({ id: x.id, name: x.name })),
      cycles: (await this.connection('query($id:ID!,$after:String){ cycles(first:100, after:$after, filter:{ team:{ id:{ eq:$id } }, isPast:{ eq:false } }){ nodes { id name number startsAt endsAt } pageInfo { hasNextPage endCursor } } }', { id: team.id }, d => d.cycles))
        .map(x => ({ id: x.id, name: x.name ?? `Cycle ${x.number}`, teamId: team.id, startsAt: x.startsAt, endsAt: x.endsAt })),
      members: (await scoped('members', 'id name active')).filter(x => x.active).map(x => ({ id: x.id, name: x.name })),
      priority: await this.definition({ kind: 'priority' }, team),
      estimate: await this.definition({ kind: 'estimate' }, team),
    };
  }
  // Returns the normalized definition and whether the value is still usable for the team.
  async definition(m, team) {
    if (m.kind === 'priority') {
      const values = (await this.request('query { issuePriorityValues { priority label } }')).issuePriorityValues.map(x => ({ priority: x.priority, label: x.label })).sort((a, b) => a.priority - b.priority);
      return { definition: { name: 'Priority', values }, usable: m.value === undefined || values.some(x => x.priority === m.value) };
    }
    if (m.kind === 'estimate') {
      const definition = { name: 'Estimate', type: team.issueEstimationType, allowZero: team.issueEstimationAllowZero, extended: team.issueEstimationExtended };
      return { definition, usable: definition.type !== 'notUsed' };
    }
    const queries = {
      label: ['issueLabel', 'id name archivedAt isGroup team { id }', x => ({ id: x.id, name: x.name, teamId: x.team?.id ?? null }), x => !x.archivedAt && !x.isGroup && [null, team.id].includes(x.team?.id ?? null)],
      state: ['workflowState', 'id name type archivedAt team { id }', x => ({ id: x.id, name: x.name, type: x.type, teamId: x.team.id }), x => !x.archivedAt && x.team.id === team.id],
      project: ['project', 'id name archivedAt teams(first:100){ nodes { id } }', x => ({ id: x.id, name: x.name }), x => !x.archivedAt && x.teams.nodes.some(t => t.id === team.id)],
      cycle: ['cycle', 'id name number isPast archivedAt team { id }', x => ({ id: x.id, name: x.name ?? `Cycle ${x.number}`, teamId: x.team.id }), x => !x.archivedAt && !x.isPast && x.team.id === team.id],
      assignee: ['user', 'id name active', x => ({ id: x.id, name: x.name }), x => x.active],
    };
    const [root, fields, normalize, usable] = queries[m.kind];
    const x = (await this.request(`query($id:String!){ ${root}(id:$id){ ${fields} } }`, { id: m.value }))[root];
    check(x, `Linear ${m.kind} ${m.value} not found`);
    return { definition: normalize(x), usable: usable(x) };
  }
  async createIssue(input) { const d = await this.request('mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id url } } }', { input }); check(d.issueCreate.success, 'Linear rejected issue creation'); return d.issueCreate.issue; }
  async updateIssue(id, input) { const d = await this.request('mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }', { id, input }); check(d.issueUpdate.success, 'Linear rejected issue update'); }
  async createComment(input) { const d = await this.request('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment { id url } } }', { input }); check(d.commentCreate.success, 'Linear rejected comment creation'); return d.commentCreate.comment; }
  async upload(image) {
    const bytes = readFileSync(image.path);
    check(hash(bytes) === image.sha256, 'Image content changed');
    const contentType = MIME[extname(image.path).toLowerCase()]; check(contentType, 'Unsupported image type');
    const d = await this.request('mutation($contentType:String!,$filename:String!,$size:Int!){ fileUpload(contentType:$contentType, filename:$filename, size:$size){ success uploadFile { uploadUrl assetUrl headers { key value } } } }',
      { contentType, filename: `${image.id}${extname(image.path).toLowerCase()}`, size: bytes.length });
    const file = d.fileUpload?.uploadFile; check(d.fileUpload?.success && file, 'Linear did not return an upload target');
    check(/^https:\/\/uploads\.linear\.app\//.test(file.assetUrl), 'Unexpected Linear asset URL');
    const headers = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' };
    for (const h of file.headers) headers[h.key] = h.value;
    let res;
    try { res = await this.fetch(file.uploadUrl, { method: 'PUT', headers, body: bytes }); } catch { throw new LinearError('uncertain', 'Image upload request failed'); }
    if (!res.ok) throw new LinearError('rejected', `Image upload HTTP ${res.status}`);
    return file.assetUrl;
  }
}

const byIdentifier = (a, b) => a.identifier.localeCompare(b.identifier, 'en', { numeric: true });
export const observeIssue = x => ({ id: x.id, identifier: x.identifier, url: x.url, title: x.title, body: x.description ?? '', state: x.state.type });
const observeComment = x => ({ id: x.id, url: x.url, body: x.body, author: x.user?.id ?? null });
const isOpen = x => !CLOSED.includes(x.state.type) && !x.archivedAt && !x.trashed;

export function linearTarget(t) {
  check(WORKSPACE.test(t?.workspace ?? ''), 'Invalid Linear workspace URL key');
  check(TEAM.test(t?.team ?? ''), 'Invalid Linear team key');
  check(UUID.test(t?.teamId ?? ''), 'Invalid Linear team ID');
  return t;
}
export function identifierOf(url, t, { allowComment = false } = {}) {
  const u = new URL(text(url, 'Linear issue URL'));
  const m = u.pathname.match(/^\/([^/]+)\/issue\/([A-Za-z0-9]+-[1-9]\d*)(?:\/[^/]*)?$/);
  check(u.protocol === 'https:' && u.host === 'linear.app' && m && m[1] === t.workspace && !u.search && (!u.hash || allowComment && /^#comment-[\w-]+$/.test(u.hash)), 'Linear issue target mismatch');
  const identifier = m[2].toUpperCase();
  check(identifier.split('-')[0] === t.team.toUpperCase(), 'Linear issue belongs to another team');
  return identifier;
}

export function currentValue(issue, m) {
  if (!issue) return m.kind === 'label' ? false : null;
  if (m.kind === 'label') return issue.labelIds.includes(m.value);
  if (m.kind === 'priority') return issue.priority || null;
  if (m.kind === 'estimate') return issue.estimate ?? null;
  return issue[m.kind]?.id ?? null;
}
export const expectedValue = m => m.kind === 'label' ? true : m.value;
const FIELD = { priority: 'priority', estimate: 'estimate', state: 'stateId', project: 'projectId', cycle: 'cycleId', assignee: 'assigneeId' };
export function createFields(entries) {
  const input = {};
  for (const m of entries) { if (m.kind === 'label') (input.labelIds ??= []).push(m.value); else input[FIELD[m.kind]] = m.value; }
  return input;
}
const updateFields = m => m.kind === 'label' ? { addedLabelIds: [m.value] } : createFields([m]);
const STABLE = { label: ['id', 'name', 'teamId'], state: ['id', 'name', 'type', 'teamId'], project: ['id', 'name'], cycle: ['id', 'name', 'teamId'], assignee: ['id', 'name'], priority: ['name', 'values'], estimate: ['name', 'type', 'allowZero', 'extended'] };
export const definition = (kind, value) => value && Object.fromEntries(STABLE[kind].filter(k => value[k] !== undefined).map(k => [k, value[k]]));

// Linear may re-render stored Markdown, so text verification compares letters and digits in order.
export function normalizeText(value) {
  return String(value ?? '').replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (all, label, url) => label.trim() === url ? url : all).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}
export const sameText = (a, b) => normalizeText(a) === normalizeText(b);
export function withImages(value, c, ops, destination) {
  const lines = c.images.filter(i => i.destination === destination).map(i => `![${i.caption}](${ops[`upload:${i.id}`]?.assetUrl})`);
  return lines.length ? `${value}\n\n${lines.join('\n')}` : value;
}

export function validateLinearPayload(p) {
  version(p); check(p.tracker === 'linear', 'Not a Linear payload'); text(p.runId, 'run identity'); linearTarget(p.target);
  check(UUID.test(p.account ?? ''), 'Missing verified Linear user ID');
  check(p.preparationMode === undefined || ['plan', 'default'].includes(p.preparationMode), 'Invalid preparation mode');
  check(Array.isArray(p.candidates) && p.candidates.length, 'Missing candidates');
  const ids = new Set();
  for (const c of p.candidates) {
    text(c.id, 'candidate identity'); check(!ids.has(c.id), 'Duplicate candidate identity'); ids.add(c.id);
    validateCandidateCore(c);
    check(c.authorization.kind !== 'collect-review', 'Collect Review handoffs record on GitHub');
    check(c.action === 'new issue' ? c.issueUrl === null : !!identifierOf(c.issueUrl, p.target), 'Invalid action target');
    const d = c.duplicate;
    check(d?.complete === true && Array.isArray(d.terms) && d.terms.length > 0 && d.terms.length <= 10 && d.terms.every(t => typeof t === 'string' && t.trim().length >= 2 && t.length <= 100), 'Missing bounded duplicate terms');
    check(Number.isInteger(d.limit) && d.limit > 0 && d.limit <= 100, 'Invalid duplicate limit');
    text(d.evidence, 'duplicate decision evidence'); check(Array.isArray(d.issues), 'Missing duplicate observations');
    for (const x of d.issues) identifierOf(x.url, p.target);
    if (c.action !== 'new issue') {
      check(d.issue && UUID.test(d.issue.id ?? '') && identifierOf(d.issue.url, p.target) === identifierOf(c.issueUrl, p.target) && !CLOSED.includes(d.issue.state) && typeof d.issue.title === 'string' && typeof d.issue.body === 'string', 'Missing retained duplicate target');
      check(Array.isArray(d.comments), 'Missing retained duplicate thread');
    }
    check(Array.isArray(c.metadata) && Array.isArray(c.omissions), 'Missing metadata audit');
    const mid = new Set(), slots = new Set();
    for (const m of c.metadata) {
      text(m.id, 'metadata operation identity'); check(!mid.has(m.id), 'Duplicate metadata operation'); mid.add(m.id);
      check(kinds.includes(m.kind) && typeof m.required === 'boolean' && typeof m.overwrite === 'boolean', 'Invalid metadata entry');
      text(m.name, 'metadata name'); text(m.rationale, 'metadata rationale');
      const slot = m.kind === 'label' ? `label:${m.value}` : m.kind; check(!slots.has(slot), 'Duplicate metadata destination'); slots.add(slot);
      if (['label', 'state', 'project', 'cycle', 'assignee'].includes(m.kind)) check(UUID.test(m.value ?? ''), 'Linear metadata values must be IDs');
      if (m.kind === 'priority') check([1, 2, 3, 4].includes(m.value), 'Priority must be 1 (Urgent) to 4 (Low)');
      if (m.kind === 'estimate') check(Number.isInteger(m.value) && m.value >= 0, 'Invalid estimate');
      check(m.definition && typeof m.definition === 'object' && Object.hasOwn(m, 'observed'), 'Missing metadata definition/baseline');
      check(m.definition.name === m.name, 'Metadata name differs from audited definition');
      if (m.definition.id !== undefined) check(m.definition.id === m.value, 'Metadata value differs from audited definition');
      if (c.action === 'new issue') check(m.observed === (m.kind === 'label' ? false : null), 'New issue metadata must have an empty baseline');
      check(permission(m.permission), 'Missing metadata permission evidence');
      if (!m.required) check(m.omissionPolicy === 'skip-on-loss-or-conflict', 'Missing optional omission policy');
      if (m.overwrite) text(m.overwriteAuthority, 'overwrite authority');
      check(c.allowedActions.includes(`metadata:${m.id}`), 'Metadata action not audited');
    }
    if (c.action === 'metadata update') check(c.metadata.length > 0, 'Metadata update has no operations');
    if (c.action === 'existing issue') check(!c.metadata.length, 'Existing issue cannot write metadata');
    check(permission(c.recordPermission), 'Missing action permission evidence');
    check(Array.isArray(c.images) && typeof c.noApprovedImages === 'boolean' && c.noApprovedImages === (c.images.length === 0), 'Missing explicit image manifest');
    check(c.imageComment === undefined, 'Linear uploads need no image-handoff comment');
    const iid = new Set(), captions = new Set();
    for (const image of c.images) {
      validateImageFields(image, c, iid, captions);
      const allowed = c.action === 'new issue' ? ['body'] : c.action === 'duplicate comment' ? ['comment', 'existing'] : ['existing'];
      check(allowed.includes(image.destination), 'Image action mismatch');
      if (image.destination !== 'existing') check(MIME[extname(image.path).toLowerCase()], 'Unsupported image type');
      if (image.destination === 'existing') {
        check(identifierOf(text(image.surfaceUrl, 'existing attachment surface'), p.target, { allowComment: true }) === identifierOf(c.issueUrl, p.target), 'Existing image surface target mismatch');
        check(/^https:\/\/uploads\.linear\.app\//.test(image.attachmentUrl ?? ''), 'Retained attachment must be a Linear upload URL');
      }
      check(c.allowedActions.includes(`image:${image.id}`), 'Image action not audited');
    }
    const allowed = new Set([c.action, ...c.metadata.map(m => `metadata:${m.id}`), ...c.images.map(i => `image:${i.id}`)]);
    check(c.allowedActions.every(a => allowed.has(a)), 'Unknown permitted action');
  }
  return result('verified', [], { payloadHash: hash(p) });
}

export async function collect(input, client) {
  version(input); const t = input.target;
  check(WORKSPACE.test(t?.workspace ?? '') && TEAM.test(t?.team ?? ''), 'Invalid Linear target');
  const observations = {};
  const observe = async (name, fn) => { try { observations[name] = { available: true, value: await fn() }; } catch (e) { rethrowAuth(e); observations[name] = { available: false, reason: e.message }; } };
  await observe('identity', () => client.identity());
  if (observations.identity.available) check(observations.identity.value.organization.urlKey === t.workspace, 'Linear API key belongs to another workspace');
  await observe('team', () => client.team(t.team));
  const team = observations.team.value;
  if (team) {
    const full = { ...t, teamId: team.id };
    if (input.discover) await observe('discovery', () => client.discover(team));
    if (input.duplicate) await observe('duplicates', async () => ({ terms: input.duplicate.terms, limit: input.duplicate.limit, issues: await client.duplicates(team.id, input.duplicate.terms, input.duplicate.limit) }));
    if (input.issueUrl) {
      await observe('issue', async () => { const x = await client.issue(identifierOf(input.issueUrl, full)); check(x, 'Linear issue not found'); return { ...observeIssue(x), open: isOpen(x), labelIds: x.labelIds }; });
      if (input.includeComments && observations.issue.available) await observe('comments', () => client.comments(observations.issue.value.id));
    }
    for (const m of input.metadata ?? []) await observe(`metadata:${m.id}`, async () => {
      const seen = await client.definition(m, team);
      const issue = input.issueUrl ? await client.issue(identifierOf(input.issueUrl, full)) : null;
      return { ...seen, current: currentValue(issue, m) };
    });
  }
  const errors = Object.entries(observations).filter(([, v]) => !v.available).map(([k, v]) => `${k}: ${v.reason}`);
  return result(errors.length ? 'blocked' : 'verified', errors, { observations });
}

export async function preflight(p, c, client, context, cs = { ops: {} }) {
  const errors = [], changes = [];
  const attempt = async (name, fn) => { try { return await fn(); } catch (e) { rethrowAuth(e); errors.push(`${name}: ${e.message}`); return undefined; } };
  const workspace = await attempt('workspace', () => compare(c.workspace.baseline));
  if (workspace && !workspace.complete) errors.push(...workspace.errors);
  errors.push(...checkImages(c.images.filter(i => i.destination !== 'existing' && cs.ops?.[`upload:${i.id}`]?.status !== 'verified')).errors);
  const identity = await attempt('identity', () => client.identity());
  if (identity && (identity.viewer.id !== p.account || !identity.viewer.active)) errors.push('Authenticated Linear user changed or inactive');
  if (identity && identity.organization.urlKey !== p.target.workspace) errors.push('Linear workspace changed');
  const team = await attempt('team', () => client.team(p.target.team));
  if (team && (team.id !== p.target.teamId || team.archivedAt || team.retiredAt)) errors.push('Linear team changed, archived, or retired');
  if (!permission(context?.recordPermission)) errors.push('Current recording permission not verified');
  const ref = c.action === 'new issue' ? cs.issueId : identifierOf(c.issueUrl, p.target);
  const issue = ref ? await attempt('issue', () => client.issue(ref)) : null;
  if (ref && issue === null) errors.push('Audited issue unavailable');
  if (c.action === 'new issue' && issue && (issue.creator?.id !== p.account || issue.title !== c.title)) errors.push('Retained created issue content or author changed');
  if (c.action !== 'new issue' && issue) {
    const seen = observeIssue(issue);
    for (const key of ['id', 'title', 'body', 'state']) if (!same(seen[key], c.duplicate.issue[key])) changes.push({ surface: `issue.${key}`, before: c.duplicate.issue[key], after: seen[key] });
    if (!isOpen(issue) && seen.state === c.duplicate.issue.state) changes.push({ surface: 'issue.archived', before: false, after: true });
    const comments = await attempt('duplicate thread', () => client.comments(issue.id));
    const own = new Set(Object.values(cs.ops ?? {}).map(op => op.receipt).filter(Boolean));
    if (comments) { const retained = comments.filter(x => !own.has(x.id)); if (!same(retained, c.duplicate.comments)) changes.push({ surface: 'comments', before: c.duplicate.comments, after: retained }); }
  }
  // A finalized Plan Mode payload keeps its duplicate decision; recording does not search again.
  const plan = p.preparationMode === 'plan';
  let duplicates;
  if (!plan && team) {
    const mine = new Set([cs.issueId, cs.ops?.create?.clientId].filter(Boolean));
    duplicates = await attempt('duplicates', () => client.duplicates(team.id, c.duplicate.terms, c.duplicate.limit));
    duplicates = duplicates?.filter(x => !(c.action === 'new issue' && mine.has(x.id)));
    if (duplicates && !same(duplicates, c.duplicate.issues)) changes.push({ surface: 'search', before: c.duplicate.issues, after: duplicates });
  }
  if (plan && changes.length) errors.push('Selected issue or thread changed since Plan Mode approval; do not route to another issue');
  const metadata = { apply: [], omissions: [], errors: [] };
  for (const m of c.metadata) {
    let reason = null, seen = null;
    if (team) { try { seen = await client.definition(m, team); } catch (e) { rethrowAuth(e); reason = e.message; } } else reason = 'Linear team unavailable';
    const done = cs.ops?.[`metadata:${m.id}`]?.status === 'verified';
    const value = currentValue(issue, m);
    const existing = c.action !== 'new issue';
    if (!reason && !same(definition(m.kind, m.definition), definition(m.kind, seen.definition))) reason = 'Metadata definition changed';
    else if (!reason && !seen.usable) reason = 'Metadata value is no longer usable for this team';
    else if (!reason && !permission(context?.permissions?.[m.id])) reason = 'Current action permission not verified';
    else if (!reason && same(value, expectedValue(m))) continue;
    else if (!reason && done) reason = 'Completed metadata no longer matches';
    else if (!reason && existing && !same(value, m.observed)) reason = 'Metadata baseline changed';
    else if (!reason && existing && m.kind !== 'label' && value !== null && !m.overwrite) reason = 'Existing metadata conflicts';
    if (!reason) metadata.apply.push(m);
    else if (m.required || done) metadata.errors.push(`${m.id}: ${reason}`);
    else metadata.omissions.push({ id: m.id, reason });
  }
  errors.push(...metadata.errors);
  return result(errors.length ? 'blocked' : changes.length ? 'needs-review' : 'verified', errors,
    { duplicateReview: !plan && changes.length ? { changes, issues: duplicates, issue: issue ? observeIssue(issue) : null } : null, metadata, issue: issue ?? null });
}

export async function verifyRecording(p, c, client, cs) {
  const errors = [], applied = [], attachments = {};
  const issue = cs.issueId ? await client.issue(cs.issueId) : null;
  if (!issue) return result('failed', ['Recorded issue unavailable'], { issueUrl: cs.issueUrl });
  if (c.action === 'new issue' && (issue.creator?.id !== p.account || issue.title !== c.title || !sameText(withImages(c.body, c, cs.ops, 'body'), issue.description))) errors.push('Created issue content differs from the audited payload');
  let comment = null;
  if (c.action === 'duplicate comment') {
    comment = cs.ops.comment?.receipt ? await client.comment(cs.ops.comment.receipt) : null;
    if (!comment || comment.user?.id !== p.account || comment.issue?.id !== issue.id || !sameText(withImages(c.comment, c, cs.ops, 'comment'), comment.body)) errors.push('Handoff comment missing or differs from the audited payload');
  }
  const omitted = new Set(cs.omissions.map(x => x.id));
  for (const m of c.metadata) {
    if (same(currentValue(issue, m), expectedValue(m))) { applied.push({ id: m.id, kind: m.kind, name: m.name, value: m.value }); continue; }
    if (!omitted.has(m.id)) errors.push(`Metadata ${m.id} not applied`);
  }
  const comments = c.images.some(i => i.destination === 'existing' && i.surfaceUrl.includes('#')) ? await client.comments(issue.id) : [];
  for (const image of c.images) {
    const url = image.destination === 'existing' ? image.attachmentUrl : cs.ops[`upload:${image.id}`]?.assetUrl;
    const surface = image.destination === 'body' ? issue.description : image.destination === 'comment' ? comment?.body
      : image.surfaceUrl.includes('#') ? comments.find(x => x.url === image.surfaceUrl)?.body : issue.description;
    if (url && surface?.includes(url)) attachments[image.id] = url; else errors.push(`Image ${image.id} not verified on its surface`);
  }
  return result(errors.length ? 'failed' : 'verified', errors, { issueUrl: issue.url, commentUrl: comment?.url ?? null, title: issue.title, action: c.action, metadata: applied, omissions: cs.omissions, attachments });
}

function contextFor(context, id) { return { ...context, ...(context?.candidates?.[id] ?? {}) }; }
const rank = ['verified', 'needs-review', 'blocked', 'failed', 'uncertain'];

export async function record(input, client) {
  version(input); const p = input.payload;
  const { payloadHash } = validateLinearPayload(p);
  const gate = executionGate(p, input.context); if (!gate.complete) return gate;
  const statePath = absolute(input.statePath);
  for (const c of p.candidates) outside(statePath, c.workspace.baseline.repo);
  const release = lock(statePath); if (!release) return result('blocked', ['Recording ledger is locked by another recorder']);
  try {
    const state = existsSync(statePath) ? readJson(statePath) : { version: 1, tracker: 'linear', payloadHash, candidates: {}, history: [] };
    if (state.payloadHash !== payloadHash) return result('blocked', ['Ledger is bound to a different payload; use refresh for duplicate-review revisions']);
    const persist = () => save(statePath, state);
    persist();
    const outcomes = [];
    try {
      for (const c of p.candidates) {
        const cs = state.candidates[c.id] ??= { issueId: null, issueUrl: null, ops: {}, omissions: [] };
        try { outcomes.push(await recordCandidate(p, c, client, contextFor(input.context, c.id), cs, persist)); }
        catch (e) { rethrowAuth(e); persist(); outcomes.push({ candidateId: c.id, status: e.kind === 'uncertain' ? 'uncertain' : 'failed', errors: [e.message], issueUrl: cs.issueUrl }); }
      }
    } catch (e) { persist(); throw e; } // Only auth errors reach here; the CLI reports authRequired.
    persist();
    const status = outcomes.reduce((worst, o) => rank.indexOf(o.status) > rank.indexOf(worst) ? o.status : worst, 'verified');
    return result(status, outcomes.flatMap(o => o.errors.map(e => `${o.candidateId}: ${e}`)), { payloadHash, outcomes });
  } finally { release(); }
}

async function recordCandidate(p, c, client, context, cs, persist) {
  const out = (status, errors = [], extra = {}) => ({ candidateId: c.id, status, errors, action: c.action, issueUrl: cs.issueUrl, omissions: cs.omissions, ...extra });
  if (cs.complete) return out('verified', [], { verification: cs.verification });
  const bodyText = () => withImages(c.body, c, cs.ops, 'body');
  // A creation with a client-chosen ID is reconciled by reading that ID; resending it cannot duplicate the issue.
  const reconcileCreate = async () => {
    const op = cs.ops.create, issue = await client.issue(op.clientId);
    if (!issue) return false;
    if (issue.creator?.id !== p.account || issue.title !== c.title || !sameText(bodyText(), issue.description)) {
      Object.assign(op, { status: 'failed', error: 'Created issue content or author differs', receipt: issue.url }); cs.issueId = issue.id; cs.issueUrl = issue.url; persist();
      throw new LinearError('rejected', `Created issue ${issue.url} differs from the audited payload`);
    }
    Object.assign(op, { status: 'verified', receipt: issue.url, at: now() }); cs.issueId = issue.id; cs.issueUrl = issue.url; persist();
    return true;
  };
  if (c.action === 'new issue' && cs.ops.create && cs.ops.create.status !== 'verified') await reconcileCreate();
  const pre = await preflight(p, c, client, context, cs);
  if (pre.status === 'needs-review') return out('needs-review', [], { duplicateReview: pre.duplicateReview });
  if (!pre.complete) return out('blocked', pre.errors);
  for (const o of pre.metadata.omissions) if (!cs.omissions.some(x => x.id === o.id)) cs.omissions.push(o);
  if (c.action !== 'new issue') { cs.issueId = pre.issue.id; cs.issueUrl = pre.issue.url; }
  persist();

  // Unreferenced private uploads are harmless, so an uncertain upload is simply repeated.
  for (const image of c.images.filter(i => i.destination !== 'existing')) {
    const key = `upload:${image.id}`; if (cs.ops[key]?.status === 'verified') continue;
    cs.ops[key] = { status: 'uncertain', sha256: image.sha256, at: now() }; persist();
    try { cs.ops[key] = { status: 'verified', sha256: image.sha256, assetUrl: await client.upload(image), at: now() }; }
    catch (e) { rethrowAuth(e); cs.ops[key] = { status: 'failed', error: e.message, at: now() }; persist(); return out('failed', [`Image ${image.id} upload failed: ${e.message}`]); }
    persist();
  }

  if (c.action === 'new issue' && cs.ops.create?.status !== 'verified') {
    const op = cs.ops.create ??= { clientId: randomUUID() };
    Object.assign(op, { status: 'uncertain', metadata: pre.metadata.apply.map(m => m.id), error: null, at: now() }); persist();
    let failure = null;
    try { await client.createIssue({ id: op.clientId, teamId: p.target.teamId, title: c.title, description: bodyText(), ...createFields(pre.metadata.apply) }); }
    catch (e) { rethrowAuth(e); failure = e; }
    if (!await reconcileCreate()) {
      Object.assign(op, { status: failure?.kind === 'rejected' ? 'failed' : 'uncertain', error: failure?.message ?? 'Issue not found after creation' }); persist();
      return out(op.status, [`Issue creation ${op.status === 'failed' ? 'rejected' : 'uncertain'}: ${op.error}`]);
    }
  }

  if (c.action === 'duplicate comment' && cs.ops.comment?.status !== 'verified') {
    const op = cs.ops.comment ??= { clientId: randomUUID() };
    const body = withImages(c.comment, c, cs.ops, 'comment');
    const reconcileComment = async () => {
      const x = await client.comment(op.clientId);
      if (!x) return false;
      if (x.user?.id !== p.account || x.issue?.id !== cs.issueId || !sameText(body, x.body)) { Object.assign(op, { status: 'failed', receipt: x.id, url: x.url, error: 'Comment differs from the audited payload' }); persist(); throw new LinearError('rejected', `Comment ${x.url} differs from the audited payload`); }
      Object.assign(op, { status: 'verified', receipt: x.id, url: x.url, at: now() }); persist(); return true;
    };
    if (!await reconcileComment()) {
      Object.assign(op, { status: 'uncertain', error: null, at: now() }); persist();
      let failure = null;
      try { await client.createComment({ id: op.clientId, issueId: cs.issueId, body }); } catch (e) { rethrowAuth(e); failure = e; }
      if (!await reconcileComment()) {
        Object.assign(op, { status: failure?.kind === 'rejected' ? 'failed' : 'uncertain', error: failure?.message ?? 'Comment not found after creation' }); persist();
        return out(op.status, [`Comment ${op.status === 'failed' ? 'rejected' : 'uncertain'}: ${op.error}`]);
      }
    }
  }

  // Metadata writes set absolute values or add one label, so a re-read decides whether to resend.
  for (const m of pre.metadata.apply) {
    const key = `metadata:${m.id}`;
    let issue = await client.issue(cs.issueId);
    if (!same(currentValue(issue, m), expectedValue(m))) {
      cs.ops[key] = { status: 'uncertain', at: now() }; persist();
      try { await client.updateIssue(cs.issueId, updateFields(m)); }
      catch (e) {
        rethrowAuth(e);
        if (e.kind === 'uncertain') { cs.ops[key].error = e.message; persist(); return out('uncertain', [`Metadata ${m.id} uncertain: ${e.message}`]); }
        cs.ops[key] = { status: 'failed', error: e.message, at: now() };
        if (m.required) { persist(); return out('failed', [`Required metadata ${m.id} rejected: ${e.message}`]); }
        cs.omissions.push({ id: m.id, reason: `Linear rejected the write: ${e.message}` }); persist(); continue;
      }
      issue = await client.issue(cs.issueId);
    }
    if (same(currentValue(issue, m), expectedValue(m))) cs.ops[key] = { status: 'verified', at: now() };
    else {
      cs.ops[key] = { status: 'failed', error: 'Value not present after write', at: now() };
      if (m.required) { persist(); return out('failed', [`Required metadata ${m.id} not applied`]); }
      cs.omissions.push({ id: m.id, reason: 'Value not present after write' });
    }
    persist();
  }

  const verification = await verifyRecording(p, c, client, cs);
  cs.verification = verification; cs.complete = verification.complete; persist();
  return out(verification.complete ? 'verified' : 'failed', verification.errors, { verification });
}

// Bounded duplicate reconciliation for payloads prepared outside Plan Mode.
// After any write for a candidate, only its duplicate observations may change.
export async function refresh(input, client) {
  version(input);
  const prev = validateLinearPayload(input.previousPayload), next = validateLinearPayload(input.payload);
  check(input.previousPayload.preparationMode !== 'plan' && input.payload.preparationMode !== 'plan', 'Plan Mode payloads cannot be refreshed');
  check(input.context?.duplicateReview?.confirmed === true && typeof input.context.duplicateReview.evidence === 'string' && input.context.duplicateReview.evidence.trim(), 'Missing trusted duplicate review');
  const review = input.review; text(review?.candidateId, 'review candidate'); text(review.reason, 'review reason'); check(review.observations, 'Missing reviewed observations');
  const gate = executionGate(input.payload, input.context); if (!gate.complete) return gate;
  const statePath = absolute(input.statePath);
  const release = lock(statePath); if (!release) return result('blocked', ['Recording ledger is locked by another recorder']);
  try {
    check(existsSync(statePath), 'Missing recording ledger');
    const state = readJson(statePath);
    const done = state.history.find(h => h.from === prev.payloadHash && h.to === next.payloadHash);
    if (state.payloadHash === next.payloadHash && done) return result('verified', [], { payloadHash: next.payloadHash });
    check(state.payloadHash === prev.payloadHash, 'Ledger is not bound to the previous payload');
    const before = input.previousPayload, after = input.payload;
    const strip = (payload, id) => ({ ...payload, candidates: payload.candidates.filter(c => c.id !== id) });
    check(same(strip(before, review.candidateId), strip(after, review.candidateId)), 'Refresh may change only the reviewed candidate');
    const oldC = before.candidates.find(c => c.id === review.candidateId), newC = after.candidates.find(c => c.id === review.candidateId);
    check(oldC && newC, 'Unknown review candidate');
    const cs = state.candidates[review.candidateId] ?? { ops: {} };
    if (Object.keys(cs.ops ?? {}).length) {
      const { duplicate: a, ...restOld } = oldC, { duplicate: b, ...restNew } = newC;
      check(same(restOld, restNew) && same(a.terms, b.terms) && a.limit === b.limit, 'Completed or attempted operations fix the target, action, text, metadata, and images');
    }
    for (const key of ['classification', 'revision', 'evidence', 'authorization', 'restrictions', 'workspace', 'environment']) check(same(oldC[key], newC[key]), `Refresh cannot change ${key}`);
    check(same(oldC.images.map(i => [i.id, i.sha256, i.approval]), newC.images.map(i => [i.id, i.sha256, i.approval])), 'Refresh cannot change approved images');
    const pre = await preflight(after, newC, client, contextFor(input.context, newC.id), cs);
    if (!pre.complete) return result(pre.status, pre.errors, { duplicateReview: pre.duplicateReview });
    state.history.push({ from: prev.payloadHash, to: next.payloadHash, previousPayload: before, review, provenance: input.context.duplicateReview.evidence, at: now() });
    state.payloadHash = next.payloadHash;
    save(statePath, state);
    return result('verified', [], { payloadHash: next.payloadHash });
  } finally { release(); }
}
