import { same, result } from './common.mjs';
import { images, permission, apiCreationRequired } from './payload.mjs';
import { exactText, reconcileImages } from './verify-recording.mjs';
import { compare } from './workspace.mjs';

export { expectedValue } from './payload.mjs';
import { expectedValue } from './payload.mjs';
export function metadataPlan(c, observations, context, completed = {}) {
  const errors = [], omissions = [], apply = [];
  for (const m of c.metadata) {
    const seen = observations[m.id]; let reason = null;
    if (!seen?.available) reason = seen?.reason ?? 'Metadata unavailable';
    else if (!same(m.definition, seen.value.definition)) reason = 'Metadata definition changed';
    else if (!seen.value.capable || !permission(context?.permissions?.[m.id])) reason = 'Current action permission not verified';
    else if (same(seen.value.value, expectedValue(m))) continue;
    else if (completed[`metadata:${m.id}`]?.status === 'verified') reason = 'Completed metadata no longer matches';
    else if (!same(seen.value.value, m.observed)) reason = 'Metadata baseline changed';
    else if (!['label','assignee','project-membership'].includes(m.kind) && seen.value.value !== null && !m.overwrite) reason = 'Existing metadata conflicts';
    if (reason) {
      if (m.required || completed[`metadata:${m.id}`]?.status === 'verified') errors.push(`${m.id}: ${reason}`);
      else omissions.push({ id: m.id, reason });
    } else apply.push(m);
  }
  for (const m of [...apply]) {
    if (m.kind === 'project-field' && !observations[m.id].value.itemExists && !apply.some(x => x.kind === 'project-membership' && x.projectId === m.projectId)) {
      const reason = 'Project item missing without an applicable audited membership addition';
      apply.splice(apply.indexOf(m), 1);
      if (m.required) errors.push(`${m.id}: ${reason}`); else omissions.push({ id: m.id, reason });
    }
  }
  return { errors, omissions, apply };
}
export function preflight(p, c, client, context, state = {}) {
  const errors = [], observations = {}, skips = [];
  const attempt = (name, fn) => { try { return fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return undefined; } };
  const workspace = attempt('workspace', () => compare(c.workspace.baseline));
  if (workspace && !workspace.complete) errors.push(...workspace.errors);
  const imageResult = images(c.images); errors.push(...imageResult.errors);
  const account = attempt('identity', () => client.identity());
  if (account !== p.account) errors.push('Authenticated account changed or unavailable');
  const repo = attempt('repository', () => client.repository());
  if (!repo || repo.full_name !== p.target.repo || repo.html_url !== `https://${p.target.host}/${p.target.repo}` || repo.archived || repo.has_issues !== true) errors.push('Repository unavailable, changed, archived, or issues disabled');
  if (!permission(context?.recordPermission)) errors.push('Current recording permission not verified');
  const url = state.issueUrl ?? c.issueUrl;
  if (c.action !== 'new issue' && url !== c.issueUrl) errors.push('Retained recording target changed');
  if (c.action === 'new issue' && url && (state.ops?.create?.status !== 'verified' || state.ops.create.receipt !== url)) errors.push('Retained creation receipt mismatch');
  const issue = url ? attempt('issue', () => client.issue(url)) : null;
  if (url && (!issue || issue.state !== 'open')) errors.push('Audited issue is closed or unavailable');
  if (c.action === 'new issue' && issue && (issue.author !== p.account || issue.title !== c.title || !exactText(c.body, issue.body, c.images, p.target.host))) errors.push('Retained created issue content or author changed');
  const existingImages = c.images.filter(i => i.destination === 'existing');
  if (existingImages.length && issue) {
    const comments = attempt('existing image thread', () => client.comments(url));
    const surfaces = { 'thread-body': { url: issue.url, body: issue.body } };
    for (const comment of comments ?? []) surfaces[`thread-comment:${comment.id}`] = comment;
    for (const image of existingImages) { const surface = image.surfaceUrl === issue.url ? { url: issue.url, body: issue.body } : comments?.find(x => x.url === image.surfaceUrl); if (surface) surfaces[`existing:${image.id}`] = surface; }
    errors.push(...reconcileImages({ images: existingImages }, surfaces, p.target.host).errors);
  }
  if (c.action !== 'new issue' && issue) {
    for (const key of ['url','title','body','state']) if (!same(issue[key], c.duplicate.issue[key])) errors.push(`Duplicate target ${key} changed`);
    const comments = attempt('duplicate thread', () => client.comments(url));
    const receipts = new Set(Object.values(state.ops ?? {}).filter(op => op.status === 'verified').map(op => op.receipt));
    if (comments && !same(comments.filter(x => !receipts.has(x.url)), c.duplicate.comments)) errors.push('Duplicate thread changed; coordinator semantic review required');
  }
  for (const retained of c.source ? [c.source,...c.source.relatedSources ?? []] : []) {
    const source = attempt('source', () => client.source(retained));
    if (source?.resolved === true) skips.push('Source thread is now resolved');
    if (!source || source.head !== retained.head || source.threadHead !== retained.head || source.merged !== true || source.threadMerged !== true) errors.push('Source PR revision or merged state changed/unverifiable');
  }
  const duplicates = attempt('duplicates', () => client.duplicates(c.duplicate.query, c.duplicate.limit));
  if (duplicates && !same(duplicates.filter(x => !(c.action === 'new issue' && state.ops?.create?.status === 'verified' && x.url === state.issueUrl)), c.duplicate.issues)) errors.push('Duplicate observations changed; coordinator semantic review required');
  const capabilities = attempt('capabilities', () => client.capabilities());
  for (const m of c.metadata) {
    try { observations[m.id] = { available: true, value: client.metadata(m, url) }; }
    catch (e) { observations[m.id] = { available: false, reason: e.message }; }
  }
  const metadata = metadataPlan(c, observations, context, state.ops); errors.push(...metadata.errors);
  const pendingImages = c.images.filter(x => x.destination !== 'existing' && !state.attachments?.[x.id]);
  const bodyImages = pendingImages.filter(x => x.destination === 'body');
  const typeNeedsApi = apiCreationRequired(c, capabilities);
  if (c.action === 'new issue' && bodyImages.length && (!capabilities?.create?.attach || typeNeedsApi)) {
    if (!c.imageComment || !c.allowedActions.includes('image-comment')) errors.push('Audited image handoff comment required for attachment fallback');
  }
  return result(errors.length || skips.length ? 'blocked' : 'verified', errors.length ? errors : skips,
    { skip: skips.length > 0 && errors.length === 0, issue, metadata, capabilities, browserRequired: pendingImages.length > 0 && !capabilities?.comment?.attach && (!capabilities?.create?.attach || !!url || typeNeedsApi) });
}
