import { result, same } from './common.mjs';
import { expectedValue } from './payload.mjs';
import { issueNumber } from './payload.mjs';

export function nativeAttachment(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
      ((u.host === host && /^\/user-attachments\/assets\/[a-z\d-]+$/i.test(u.pathname)) ||
      (host === 'github.com' && u.host === 'user-images.githubusercontent.com' && /^\/\d+\/[\w.-]+$/.test(u.pathname)));
  } catch { return false; }
}
export function attachmentMarkdown(body) {
  return [...body.matchAll(/!\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)/g)].map(m => ({ caption: m[1], url: m[2], markdown: m[0] }));
}
export function exactText(expected, observed, allowedImages = [], host = 'github.com') {
  if (observed === expected) return true;
  if (!observed.startsWith(expected)) return false;
  let suffix = observed.slice(expected.length);
  const found = attachmentMarkdown(suffix);
  for (const image of found) {
    if (!nativeAttachment(image.url, host) || !allowedImages.some(x => x.caption === image.caption)) return false;
    suffix = suffix.replace(image.markdown, '');
  }
  return !suffix.trim();
}
export function reconcileImages(c, surfaces, host, routes = {}) {
  const manifest = {}, errors = [];
  for (const image of c.images) {
    const surface = surfaces[image.destination === 'existing' ? `existing:${image.id}` : routes[image.id] ?? image.destination];
    const matches = surface ? attachmentMarkdown(surface.body).filter(x => x.caption === image.caption && nativeAttachment(x.url, host)) : [];
    if (image.generated && !Object.values(surfaces).some(x => x.body.includes(image.prompt))) errors.push(`Image ${image.id}: published generation prompt not verified`);
    if (matches.length !== 1) errors.push(`Image ${image.id}: missing or ambiguous native attachment`);
    else if (image.destination === 'existing' && matches[0].url !== image.attachmentUrl) errors.push(`Image ${image.id}: retained attachment changed`);
    else manifest[image.id] = { id: image.id, url: matches[0].url, caption: image.caption, sourceUrl: surface.url, provenance: image.provenance, prompt: image.generated ? image.prompt : null };
  }
  return result(errors.length ? 'failed' : 'verified', errors, { manifest });
}
export function verifyRecording(p, c, client, state, omissions = []) {
  const errors = [], omitted = new Set(omissions.map(x => x.id)), surfaces = {}, metadata = [];
  let issue;
  try {
    issueNumber(state.issueUrl, p.target);
    if (c.action !== 'new issue' && state.issueUrl !== c.issueUrl) throw new Error('Retained target changed');
    issue = client.issue(state.issueUrl);
    if (c.action === 'new issue') {
      if (issue.author !== p.account || issue.title !== c.title || !exactText(c.body, issue.body, c.images.filter(x => x.destination === 'body'), p.target.host)) errors.push('Created issue content/author mismatch');
    }
    surfaces.body = { url: issue.url, body: issue.body };
    const comments = c.comment || c.imageComment || c.images.some(i => i.generated || i.destination === 'existing' && i.surfaceUrl.includes('#')) ? client.comments(issue.url) : [];
    for (const comment of comments) surfaces[`thread-comment:${comment.id}`] = comment;
    for (const image of c.images.filter(i => i.destination === 'existing')) {
      const surface = image.surfaceUrl === issue.url ? surfaces.body : comments.find(x => x.url === image.surfaceUrl);
      if (surface) surfaces[`existing:${image.id}`] = surface;
    }
    for (const [key, expected, op] of [['comment',c.comment,'comment'], ['image-comment',c.imageComment,'image-comment']]) {
      if (!expected || (key === 'image-comment' && !state.ops?.[op])) continue;
      const receipt = state.ops?.[op]?.receipt;
      const matches = comments.filter(x => x.url === receipt && x.author === p.account && exactText(expected, x.body, c.images.filter(i => (state.imageRoutes?.[i.id] ?? i.destination) === key), p.target.host));
      if (matches.length !== 1) errors.push(`${key}: recorded content/author not verified`);
      else surfaces[key] = matches[0];
    }
    if (state.preserved) {
      for (const label of state.preserved.labels) if (!issue.labels.includes(label)) errors.push('Existing label lost');
      for (const assignee of state.preserved.assignees) if (!issue.assignees.includes(assignee)) errors.push('Existing assignee lost');
      for (const key of ['title','body','type','milestone']) {
        const replacement = key === 'type' || key === 'milestone' ? c.metadata.some(m => m.kind === key && !omitted.has(m.id)) : false;
        if (!replacement && !same(issue[key], state.preserved[key])) errors.push(`Unrelated issue ${key} changed`);
      }
    }
    for (const m of c.metadata) {
      if (omitted.has(m.id)) continue;
      const observed = client.metadata(m, issue.url);
      if (!same(observed.value, expectedValue(m))) errors.push(`Metadata ${m.id}: value not verified`);
      else metadata.push({ id: m.id, kind: m.kind, destination: m.destination, name: m.name, value: m.value });
    }
    if (state.preservedFields) {
      const seen = client.preservedFields(c, issue.url);
      const written = new Set(c.metadata.filter(m => !omitted.has(m.id)).map(m => m.kind === 'issue-field' ? `native:${m.fieldId}` : `project:${m.projectId}:${m.fieldId}`));
      for (const [id, value] of Object.entries(state.preservedFields)) if (!written.has(id) && !same(seen[id] ?? null, value)) errors.push(`Unrelated field ${id} changed`);
    }
  } catch (e) { errors.push(e.message); }
  const reconciliation = reconcileImages(c, surfaces, p.target.host, state.imageRoutes); errors.push(...reconciliation.errors);
  return result(errors.length ? 'failed' : 'verified', errors, { issueUrl: state.issueUrl, title: issue?.title, action: c.action, metadata, omissions, attachments: reconciliation.manifest });
}
