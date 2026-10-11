import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { check, text, version, hash, same, result } from './common.mjs';
import { validateBaseline } from './workspace.mjs';

export const actions = ['new issue', 'duplicate comment', 'metadata update', 'existing issue'];
export const expectedValue = m => ['label','assignee','project-membership'].includes(m.kind) ? true : m.value;
export const kinds = ['label', 'type', 'issue-field', 'project-field', 'project-membership', 'assignee', 'milestone'];
export function target(value) {
  check(/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value?.host), 'Invalid GitHub host');
  check(/^[\w.-]+\/[\w.-]+$/.test(value?.repo), 'Invalid repository');
  return value;
}
export function issueNumber(url, t) {
  const u = new URL(text(url, 'issue URL'));
  const match = u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/);
  check(u.protocol === 'https:' && u.host === t.host && match && `${match[1]}/${match[2]}` === t.repo && !u.search && !u.hash, 'Issue target mismatch');
  return Number(match[3]);
}
export function permission(p) { return p?.confirmed === true && typeof p.evidence === 'string' && !!p.evidence.trim() && typeof p.credentialEvidence === 'string' && !!p.credentialEvidence.trim(); }
export function images(manifest) {
  const errors = [], files = [];
  for (const image of manifest) {
    try {
      check(isAbsolute(image.path) && !image.path.includes('#'), 'Invalid saved path');
      check(lstatSync(image.path).isFile(), 'Missing regular image file');
      check(hash(readFileSync(image.path)) === image.sha256, 'Image content changed');
      files.push({ id: image.id, sha256: image.sha256, path: image.path });
    } catch (e) { errors.push(`Image ${image.id}: ${e.message}`); }
  }
  return result(errors.length ? 'blocked' : 'verified', errors, { files });
}
export function validatePayload(p) {
  version(p); text(p.runId, 'run identity'); target(p.target); text(p.account, 'authenticated account');
  check(Array.isArray(p.candidates) && p.candidates.length, 'Missing candidates');
  const ids = new Set();
  for (const c of p.candidates) {
    text(c.id, 'candidate identity'); check(!ids.has(c.id), 'Duplicate candidate identity'); ids.add(c.id);
    check(['Bug', 'Feature', 'Task'].includes(c.classification), 'Invalid classification');
    check(c.readiness === 'ready', 'Candidate is not ready');
    check(/^[a-f\d]{40,64}$/i.test(c.revision), 'Missing exact revision');
    text(c.evidence, 'candidate evidence'); text(c.authorization?.origin, 'authorization origin'); text(c.authorization?.request, 'original request');
    check(['human', 'main-qa', 'static-analysis', 'collect-review'].includes(c.authorization.kind), 'Invalid authorization kind');
    text(c.authorization.context, 'trusted authorization context');
    if (c.authorization.kind !== 'human') { text(c.authorization.runId, 'handoff run identity'); text(c.authorization.delegation, 'handoff delegation chain'); text(c.authorization.scope, 'authorized handoff scope'); }
    if (['static-analysis', 'collect-review'].includes(c.authorization.kind)) check(c.classification === 'Bug', 'Handoff permits Bugs only');
    check(typeof c.restrictions?.draftOnly === 'boolean' && typeof c.restrictions?.diagnosisOnly === 'boolean' && typeof c.restrictions?.noRepair === 'boolean' && c.restrictions?.noImplementation === true, 'Missing restrictions');
    validateBaseline(c.workspace?.original); validateBaseline(c.workspace?.baseline);
    if (!same(c.workspace.original, c.workspace.baseline)) {
      check(c.workspace.baseline.originalRef === c.workspace.original.ref && c.workspace.baseline.repairLedger.length > 0, 'Missing original baseline/repair link');
    }
    check(c.workspace.cleanupVerified === true, 'Workspace cleanup not verified');
    if (c.environment === 'local') {
      check(c.restrictions.noCodeChanges === true, 'Missing local code-change prohibition');
      text(c.logs, 'sanitized logs or availability gaps'); text(c.runtime, 'runtime provenance or applicability');
    } else text(c.environment, 'investigation environment');
    check(actions.includes(c.action), 'Invalid action'); text(c.title, 'exact title');
    check(Array.isArray(c.allowedActions) && c.allowedActions.includes(c.action), 'Action is not audited');
    check(c.action === 'new issue' ? c.issueUrl === null : !!issueNumber(c.issueUrl, p.target), 'Invalid action target');
    check(typeof c.body === 'string' && typeof c.comment === 'string', 'Missing exact text fields');
    if (c.action === 'new issue') { text(c.body, 'issue body'); check(!c.comment, 'Unexpected duplicate comment'); }
    if (c.action === 'duplicate comment') { text(c.comment, 'duplicate comment'); check(!c.body, 'Unexpected issue body'); }
    if (['metadata update', 'existing issue'].includes(c.action)) check(!c.body && !c.comment, 'No text permitted for this action');
    check(c.duplicate?.complete === true && Number.isInteger(c.duplicate.limit) && c.duplicate.limit > 0 && c.duplicate.limit <= 100, 'Missing bounded duplicate evidence');
    text(c.duplicate.query, 'bounded duplicate query'); text(c.duplicate.evidence, 'duplicate decision evidence');
    check(Array.isArray(c.duplicate.issues), 'Missing duplicate observations');
    for (const item of c.duplicate.issues) issueNumber(item.url, p.target);
    if (c.action !== 'new issue') { check(c.duplicate.issue?.url === c.issueUrl && c.duplicate.issue?.state === 'open' && typeof c.duplicate.issue.body === 'string' && typeof c.duplicate.issue.title === 'string', 'Missing retained duplicate target'); check(Array.isArray(c.duplicate.comments), 'Missing retained duplicate thread'); }
    check(Array.isArray(c.metadata) && Array.isArray(c.omissions), 'Missing metadata audit');
    const mid = new Set(), destinations = new Set();
    for (const m of c.metadata) {
      text(m.id, 'metadata operation identity'); check(!mid.has(m.id), 'Duplicate metadata operation'); mid.add(m.id);
      check(kinds.includes(m.kind) && typeof m.required === 'boolean' && typeof m.overwrite === 'boolean', 'Invalid metadata entry');
      text(m.name, 'metadata name'); text(m.destination, 'metadata destination'); text(m.rationale, 'metadata rationale');
      check(m.destination === (m.kind.startsWith('project-') ? m.projectId : c.issueUrl ?? `https://${p.target.host}/${p.target.repo}`), 'Metadata destination mismatch');
      const key = `${m.kind}:${m.projectId ?? ''}:${m.fieldId ?? (['type','milestone'].includes(m.kind) ? 'single' : m.value)}`; check(!destinations.has(key), 'Duplicate metadata destination'); destinations.add(key);
      if (['label','type','assignee'].includes(m.kind)) text(m.value, 'metadata string value');
      if (m.kind === 'milestone') check(Number.isInteger(m.value) && m.value > 0, 'Invalid milestone');
      if (m.kind === 'project-membership') check(m.value === true, 'Only project addition is allowed');
      check(Object.hasOwn(m, 'value') && Object.hasOwn(m, 'observed') && m.definition !== undefined, 'Missing metadata value/definition/baseline');
      if (m.definition?.name) check(m.name === m.definition.name, 'Metadata name differs from audited definition');
      if (m.kind === 'type') check(m.value === c.classification, 'Issue type differs from classification');
      check(permission(m.permission), 'Missing metadata permission evidence');
      if (!m.required) check(m.omissionPolicy === 'skip-on-loss-or-conflict', 'Missing optional omission policy');
      if (m.overwrite) text(m.overwriteAuthority, 'overwrite authority');
      check(c.allowedActions.includes(`metadata:${m.id}`), 'Metadata action not audited');
      if (m.kind === 'issue-field') {
        check(Number.isInteger(m.fieldId) && m.fieldId > 0 && ['text','number','date','single_select'].includes(m.dataType), 'Invalid native issue field');
        check(m.dataType === 'number' ? typeof m.value === 'number' && Number.isFinite(m.value) : typeof m.value === 'string', 'Invalid native field value');
        if (m.dataType === 'date') check(/^\d{4}-\d{2}-\d{2}$/.test(m.value) && new Date(m.value).toISOString().slice(0,10) === m.value, 'Invalid field date');
      }
      if (m.kind.startsWith('project-')) { text(m.projectId, 'project ID'); if (m.kind === 'project-field') { text(m.fieldId, 'project field ID'); check(['text','number','date','singleSelectOptionId','iterationId'].includes(m.valueType), 'Invalid project value type'); check(m.valueType === 'number' ? typeof m.value === 'number' && Number.isFinite(m.value) : typeof m.value === 'string' && !!m.value, 'Invalid project value'); } }
    }
    if (c.action === 'metadata update') check(c.metadata.length > 0, 'Metadata update has no operations');
    if (c.action === 'existing issue') check(!c.metadata.length, 'Existing issue cannot write metadata');
    check(permission(c.recordPermission), 'Missing action permission evidence');
    check(Array.isArray(c.images) && typeof c.noApprovedImages === 'boolean' && c.noApprovedImages === (c.images.length === 0), 'Missing explicit image manifest');
    const iid = new Set(), captions = new Set();
    for (const image of c.images) {
      text(image.id, 'image identity'); check(!iid.has(image.id), 'Duplicate image identity'); iid.add(image.id);
      for (const key of ['approval','path','surface','viewport','state','caption','provenance']) text(image[key], `image ${key}`);
      check(!/[\[\]\\\n\r]/.test(image.caption) && !captions.has(image.caption), 'Image captions must be unique plain Markdown alt text'); captions.add(image.caption);
      check(![c.body,c.comment,c.imageComment ?? ''].some(value => value.includes(image.path)), 'Published text includes private saved path');
      check(/^[a-f\d]{64}$/.test(image.sha256) && typeof image.generated === 'boolean', 'Missing image hash/provenance');
      if (image.generated) {
        text(image.prompt, 'final image prompt');
        const published = image.destination === 'existing' ? [c.duplicate.issue?.body ?? '', ...(c.duplicate.comments ?? []).map(x => x.body)] : image.destination === 'body' ? [c.body] : [c.body,c.comment,c.imageComment ?? '', c.duplicate.issue?.body ?? '', ...(c.duplicate.comments ?? []).map(x => x.body)];
        check(published.some(value => value.includes(image.prompt)), 'Generated prompt missing from published text');
      }
      check(['body', 'comment', 'image-comment', 'existing'].includes(image.destination), 'Invalid image destination');
      check(c.action === 'new issue' ? ['body','image-comment'].includes(image.destination) : image.destination === 'existing' || c.action === 'duplicate comment' && image.destination === 'comment', 'Image action mismatch');
      if (image.destination === 'existing') {
        const surface = new URL(text(image.surfaceUrl, 'existing attachment surface'));
        check(!surface.hash || /^#issuecomment-\d+$/.test(surface.hash), 'Invalid existing image comment surface');
        surface.hash = ''; check(surface.href === c.issueUrl, 'Existing image surface target mismatch'); text(image.attachmentUrl, 'retained native attachment URL');
      }
      if (image.destination === 'image-comment') { text(c.imageComment, 'exact image handoff comment'); check(c.allowedActions.includes('image-comment'), 'Image comment not audited'); }
      check(c.allowedActions.includes(`image:${image.id}`), 'Image action not audited');
    }
    const allowed = new Set([c.action, ...c.metadata.map(m => `metadata:${m.id}`), ...c.images.map(i => `image:${i.id}`), ...(c.imageComment ? ['image-comment'] : [])]);
    check(c.allowedActions.every(action => allowed.has(action)), 'Unknown permitted action');
    if (c.authorization.kind === 'collect-review') {
      check(c.source?.head === c.revision && Number.isInteger(c.source.number) && c.source.number > 0, 'Missing source PR revision');
      for (const key of ['url','reviewEvidence','authorship','reviewRevision','threadId','threadUrl']) text(c.source[key], `source ${key}`);
      check(c.source.merged === true && c.source.resolved === false, 'Source PR/thread not eligible');
    }
  }
  return result('verified', [], { payloadHash: hash(p) });
}
export function executionGate(p, context) {
  const errors = [];
  if (context?.mode !== 'default') errors.push('Recording requires Default mode');
  if (context?.trustedAuthorization !== true || context?.recordingAuthorized !== true || !context?.evidence) errors.push('Caller must verify trusted authorization and current restrictions');
  if (p.candidates.some(c => c.restrictions.draftOnly || c.restrictions.diagnosisOnly)) errors.push('Draft-only or diagnosis-only restriction');
  return result(errors.length ? 'blocked' : 'verified', errors);
}

export function apiCreationRequired(c, capabilities) { return c.metadata.some(m => m.kind === 'type' && capabilities?.create?.type !== true || m.kind === 'label' && /[,"\r\n]/.test(m.value)); }
