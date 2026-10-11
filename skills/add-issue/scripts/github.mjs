import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { run, check, result, version, hash } from './common.mjs';
import { target, issueNumber, images } from './payload.mjs';

const segment = x => encodeURIComponent(String(x));
export const fieldFragments = `... on ProjectV2Field { id name dataType project { id } } ... on ProjectV2SingleSelectField { id name dataType project { id } options { id name } } ... on ProjectV2IterationField { id name dataType project { id } configuration { iterations { id title } completedIterations { id title } } }`;
const valueFragments = `... on ProjectV2ItemFieldTextValue { text field { ${fieldFragments} } } ... on ProjectV2ItemFieldNumberValue { number field { ${fieldFragments} } } ... on ProjectV2ItemFieldDateValue { date field { ${fieldFragments} } } ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ${fieldFragments} } } ... on ProjectV2ItemFieldIterationValue { iterationId field { ${fieldFragments} } }`;
export function definition(value) {
  if (!value) return null;
  const keys = ['id','name','title','description','data_type','dataType','enabled','state','number','options','configuration','visibility'];
  return Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}
export class GitHub {
  constructor(t, { transport = run, maxPages = 10 } = {}) { target(t); this.target = t; this.transport = transport; this.maxPages = maxPages; check(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 100, 'Invalid page bound'); }
  command(args, input) { return this.transport('gh', args, { input, env: { ...process.env, GH_HOST: this.target.host, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } }); }
  api(endpoint, method = 'GET', body) {
    const args = ['api', '--hostname', this.target.host, '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    const r = this.command(args, body === undefined ? undefined : JSON.stringify(body));
    if (!r.ok) { const e = new Error(`GitHub ${method} unavailable: ${endpoint}`); e.definite = [400,401,403,404,410,422].includes(Number(r.httpStatus ?? r.stderr?.match(/HTTP (\d{3})/)?.[1])); throw e; }
    if (!r.stdout.trim()) return null;
    let parsed; try { parsed = JSON.parse(r.stdout); } catch { throw new Error('GitHub returned invalid JSON'); }
    check(!parsed?.errors?.length, 'GitHub returned GraphQL errors'); return parsed;
  }
  graphql(query, variables = {}) { return this.api('graphql', 'POST', { query, variables }).data; }
  list(endpoint) {
    const values = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const items = this.api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      check(Array.isArray(items), 'Expected GitHub array'); values.push(...items);
      if (items.length < 100) return values;
    }
    throw new Error('GitHub pagination bound reached');
  }
  get prefix() { return `repos/${this.target.repo}`; }
  identity() { return this.api('user').login; }
  repository() { return this.api(this.prefix); }
  capabilities() {
    const capabilities = {};
    for (const name of ['create','comment','edit']) {
      const r = this.command(['issue', name, '--help']);
      capabilities[name] = { available: r.ok, attach: r.ok && /(?:^|\n)\s+--attach\s/m.test(r.stdout), type: r.ok && /(?:^|\n)\s+--type\s/m.test(r.stdout) };
    }
    return capabilities;
  }
  duplicates(query, limit) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid duplicate limit');
    const q = `repo:${this.target.repo} is:issue is:open ${query}`;
    const r = this.api(`search/issues?q=${segment(q)}&per_page=${limit}`);
    check(r.incomplete_results === false && r.total_count <= limit && Array.isArray(r.items), 'Incomplete bounded duplicate search');
    for (const issue of r.items) issueNumber(issue.html_url, this.target);
    return r.items.map(i => ({ url: i.html_url, number: i.number, title: i.title, body: i.body ?? '', state: i.state })).sort((a,b) => a.number - b.number);
  }
  issue(url) {
    const n = issueNumber(url, this.target), raw = this.api(`${this.prefix}/issues/${n}`);
    check(!raw.pull_request && raw.html_url === url, 'Not the audited issue target');
    return { url, number: n, nodeId: raw.node_id, title: raw.title, body: raw.body ?? '', state: raw.state, author: raw.user?.login,
      labels: raw.labels.map(l => l.name), type: raw.type?.name ?? null, assignees: raw.assignees.map(a => a.login), milestone: raw.milestone?.number ?? null };
  }
  comments(url) { return this.list(`${this.prefix}/issues/${issueNumber(url, this.target)}/comments`).map(x => ({ id: x.id, url: x.html_url, body: x.body ?? '', author: x.user?.login })); }
  source(source) {
    const pr = this.api(`${this.prefix}/pulls/${source.number}`);
    check(pr.html_url === source.url, 'Source PR target mismatch');
    if (source.threadId === null) return { head: pr.head.sha, merged: pr.merged === true, resolved: null, threadHead: pr.head.sha, threadMerged: pr.merged === true };
    const thread = this.graphql('query($id:ID!){ node(id:$id) { ... on PullRequestReviewThread { id isResolved pullRequest { url headRefOid merged } } } }', { id: source.threadId }).node;
    check(thread?.pullRequest?.url === source.url && typeof thread.isResolved === 'boolean', 'Source thread/PR target mismatch');
    return { head: pr.head.sha, merged: pr.merged === true, resolved: thread.isResolved, threadHead: thread.pullRequest.headRefOid, threadMerged: thread.pullRequest.merged };
  }
  project(projectId) {
    const value = this.graphql(`query($id:ID!){ node(id:$id) { ... on ProjectV2 { id title viewerCanUpdate } } }`, { id: projectId }).node;
    check(value?.id === projectId, 'Project unavailable'); return value;
  }
  projectFields(projectId) {
    const values = []; let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const node = this.graphql(`query($id:ID!,$cursor:String){ node(id:$id) { ... on ProjectV2 { fields(first:100,after:$cursor) { nodes { ${fieldFragments} } pageInfo { hasNextPage endCursor } } } } }`, { id: projectId, cursor }).node;
      check(node?.fields, 'Project fields unavailable'); values.push(...node.fields.nodes);
      if (!node.fields.pageInfo.hasNextPage) return values;
      check(node.fields.pageInfo.endCursor && node.fields.pageInfo.endCursor !== cursor, 'Invalid project cursor'); cursor = node.fields.pageInfo.endCursor;
    }
    throw new Error('Project field pagination bound reached');
  }
  projectItem(projectId, issueUrl) {
    const issue = this.issue(issueUrl); let cursor = null;
    for (let page = 0; page < this.maxPages; page++) {
      const node = this.graphql(`query($id:ID!,$cursor:String){ node(id:$id) { ... on Issue { projectItems(first:100,after:$cursor) { nodes { id project { id } } pageInfo { hasNextPage endCursor } } } } }`, { id: issue.nodeId, cursor }).node;
      check(node?.projectItems, 'Project membership unavailable');
      const found = node.projectItems.nodes.find(x => x.project.id === projectId);
      if (found) return found.id;
      if (!node.projectItems.pageInfo.hasNextPage) return null;
      check(node.projectItems.pageInfo.endCursor && node.projectItems.pageInfo.endCursor !== cursor, 'Invalid membership cursor'); cursor = node.projectItems.pageInfo.endCursor;
    }
    throw new Error('Project membership pagination bound reached');
  }
  metadata(m, issueUrl) {
    let def, value = null, capable = true, itemExists = null;
    const owner = this.target.repo.split('/')[0];
    if (m.kind === 'label') { def = this.api(`${this.prefix}/labels/${segment(m.value)}`); value = issueUrl ? this.issue(issueUrl).labels.includes(m.value) : false; }
    if (m.kind === 'type') { def = this.api(`${this.prefix}/issue-types`).find(x => x.name === m.value); value = issueUrl ? this.issue(issueUrl).type : null; }
    if (m.kind === 'assignee') { def = this.api(`${this.prefix}/assignees/${segment(m.value)}`); value = issueUrl ? this.issue(issueUrl).assignees.includes(m.value) : false; def = { id: m.value, name: m.value }; }
    if (m.kind === 'milestone') { def = this.api(`${this.prefix}/milestones/${m.value}`); value = issueUrl ? this.issue(issueUrl).milestone : null; }
    if (m.kind === 'issue-field') {
      def = this.api(`orgs/${owner}/issue-fields`).find(x => x.id === m.fieldId);
      if (issueUrl) { const field = this.list(`${this.prefix}/issues/${issueNumber(issueUrl, this.target)}/issue-field-values`).find(x => x.issue_field_id === m.fieldId); value = field?.single_select_option?.name ?? field?.value ?? null; }
    }
    if (m.kind.startsWith('project-')) {
      const project = this.project(m.projectId); capable = project.viewerCanUpdate === true;
      const item = issueUrl ? this.projectItem(m.projectId, issueUrl) : null; itemExists = item !== null;
      if (m.kind === 'project-membership') { def = { id: project.id, name: project.title }; value = item !== null; }
      else {
        def = this.graphql(`query($id:ID!){ node(id:$id) { ${fieldFragments} } }`, { id: m.fieldId }).node;
        // Confirm field membership; a valid global field ID alone is insufficient.
        check(def?.project?.id === m.projectId, 'Field belongs to another project');
        if (item) {
          const values = this.graphql(`query($id:ID!,$name:String!){ node(id:$id) { ... on ProjectV2Item { fieldValueByName(name:$name) { ${valueFragments} } } } }`, { id: item, name: m.name }).node?.fieldValueByName;
          if (values) { check(values.field?.id === m.fieldId, 'Ambiguous project field name'); value = values.text ?? values.number ?? values.date ?? values.optionId ?? values.iterationId ?? null; }
        }
      }
    }
    check(def, 'Audited metadata definition unavailable');
    check(def.enabled !== false && def.state !== 'closed', 'Audited metadata disabled or closed');
    if (m.kind === 'issue-field') { check(def.data_type === m.dataType, 'Native field type mismatch'); if (m.dataType === 'single_select') check(def.options?.some(x => x.name === m.value), 'Native field option unavailable'); }
    if (m.kind === 'project-field' && m.valueType === 'singleSelectOptionId') check(def.options?.some(x => x.id === m.value), 'Project option unavailable');
    if (m.kind === 'project-field' && m.valueType === 'iterationId') check([...def.configuration?.iterations ?? [], ...def.configuration?.completedIterations ?? []].some(x => x.id === m.value), 'Project iteration unavailable');
    return { definition: definition(def), value, capable, itemExists };
  }
  preservedFields(c, url) {
    const fields = {};
    if (c.metadata.some(m => m.kind === 'issue-field')) {
      for (const x of this.list(`${this.prefix}/issues/${issueNumber(url, this.target)}/issue-field-values`)) fields[`native:${x.issue_field_id}`] = x.single_select_option?.name ?? x.value;
    }
    for (const projectId of new Set(c.metadata.filter(m => m.kind === 'project-field').map(m => m.projectId))) {
      const item = this.projectItem(projectId, url); if (!item) continue;
      let cursor = null, done = false;
      for (let page = 0; page < this.maxPages; page++) {
        const connection = this.graphql(`query($id:ID!,$cursor:String){ node(id:$id) { ... on ProjectV2Item { fieldValues(first:100,after:$cursor) { nodes { ${valueFragments} } pageInfo { hasNextPage endCursor } } } } }`, { id: item, cursor }).node?.fieldValues;
        check(connection, 'Project values unavailable');
        for (const value of connection.nodes) if (value.field?.id) fields[`project:${projectId}:${value.field.id}`] = value.text ?? value.number ?? value.date ?? value.optionId ?? value.iterationId ?? null;
        if (!connection.pageInfo.hasNextPage) { done = true; break; }
        check(connection.pageInfo.endCursor && connection.pageInfo.endCursor !== cursor, 'Invalid values cursor'); cursor = connection.pageInfo.endCursor;
      }
      check(done, 'Project values pagination bound reached');
    }
    return fields;
  }
  writeMetadata(m, url) {
    const n = issueNumber(url, this.target), endpoint = `${this.prefix}/issues/${n}`;
    if (m.kind === 'label') return this.api(`${endpoint}/labels`, 'POST', { labels: [m.value] });
    if (m.kind === 'assignee') return this.api(`${endpoint}/assignees`, 'POST', { assignees: [m.value] });
    if (m.kind === 'type') return this.api(endpoint, 'PATCH', { type: m.value });
    if (m.kind === 'milestone') return this.api(endpoint, 'PATCH', { milestone: m.value });
    if (m.kind === 'issue-field') return this.api(`${endpoint}/issue-field-values`, 'POST', { issue_field_values: [{ field_id: m.fieldId, value: m.value }] });
    if (m.kind === 'project-membership') return this.graphql('mutation($input:AddProjectV2ItemByIdInput!){ addProjectV2ItemById(input:$input){ item { id } } }', { input: { projectId: m.projectId, contentId: this.issue(url).nodeId } });
    if (m.kind === 'project-field') {
      const itemId = this.projectItem(m.projectId, url); check(itemId, 'Audited project item missing');
      return this.graphql('mutation($input:UpdateProjectV2ItemFieldValueInput!){ updateProjectV2ItemFieldValue(input:$input){ projectV2Item { id } } }', { input: { projectId: m.projectId, itemId, fieldId: m.fieldId, value: { [m.valueType]: m.value } } });
    }
    throw new Error('Unaudited metadata kind');
  }
  create(c, metadata, attachments) {
    if (!attachments.length) {
      const body = { title: c.title, body: c.body };
      for (const m of metadata) {
        if (m.kind === 'label') (body.labels ??= []).push(m.value);
        if (m.kind === 'assignee') (body.assignees ??= []).push(m.value);
        if (m.kind === 'type') body.type = m.value;
        if (m.kind === 'milestone') body.milestone = m.value;
      }
      return this.api(`${this.prefix}/issues`, 'POST', body).html_url;
    }
    const args = ['issue','create','--repo',`${this.target.host}/${this.target.repo}`,'--title',c.title];
    for (const m of metadata) {
      if (m.kind === 'label') args.push('--label', m.value);
      if (m.kind === 'assignee') args.push('--assignee', m.value);
      if (m.kind === 'type') args.push('--type', m.value);
      if (m.kind === 'milestone') args.push('--milestone', m.definition.name ?? m.definition.title);
    }
    return this.bodyCommand(args, c.body, attachments);
  }
  comment(url, body, attachments) { return this.bodyCommand(['issue','comment',String(issueNumber(url, this.target)),'--repo',`${this.target.host}/${this.target.repo}`], body, attachments); }
  bodyCommand(args, body, attachments) {
    const validation = images(attachments);
    check(validation.complete, validation.errors.join('; '));
    const dir = mkdtempSync(join(tmpdir(), 'add-issue-body-'));
    try {
      const path = join(dir, 'body.md'); writeFileSync(path, body, { mode: 0o600 }); args.push('--body-file', path);
      // Upload a private copy of the approved bytes; the source can change during gh's upload.
      for (const [index, image] of attachments.entries()) {
        const bytes = readFileSync(image.path);
        check(hash(bytes) === image.sha256, `Image ${image.id}: changed before upload`);
        const copy = join(dir, `image-${index}${extname(image.path)}`);
        writeFileSync(copy, bytes, { mode: 0o600, flag: 'wx' });
        args.push('--attach', `${copy}#${image.caption}`);
      }
      const r = this.command(args);
      // gh can create the record and some attachments before returning non-zero.
      const url = r.stdout.match(/https:\/\/[^\s]+\/issues\/\d+(?:#issuecomment-\d+)?/g)?.at(-1);
      check(url, r.ok ? 'No verified target returned' : 'Write outcome uncertain');
      if (args[1] === 'create') issueNumber(url, this.target);
      else { const u = new URL(url); check(u.host === this.target.host && u.pathname === `/${this.target.repo}/issues/${args[2]}` && /^#issuecomment-\d+$/.test(u.hash), 'Returned comment target mismatch'); }
      return url;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
export function collect(input, client = new GitHub(input.target)) {
  version(input); target(input.target);
  const observations = {}, gaps = [];
  const observe = (key, fn) => { try { observations[key] = { available: true, value: fn() }; } catch (e) { observations[key] = { available: false, reason: e.message }; gaps.push(key); } };
  observe('account', () => client.identity()); observe('repository', () => { const x = client.repository(); return { name: x.full_name, url: x.html_url, permissions: x.permissions, archived: x.archived, hasIssues: x.has_issues }; });
  observe('capabilities', () => client.capabilities());
  if (input.discover === true) {
    observe('labels', () => client.list(`${client.prefix}/labels`));
    observe('types', () => client.api(`${client.prefix}/issue-types`));
    observe('issueFields', () => client.api(`orgs/${input.target.repo.split('/')[0]}/issue-fields`));
    for (const id of input.projects ?? []) { observe(`project:${id}`, () => client.project(id)); observe(`projectFields:${id}`, () => client.projectFields(id)); }
  }
  if (input.duplicate) observe('duplicates', () => client.duplicates(input.duplicate.query, input.duplicate.limit));
  if (input.issueUrl) { observe('issue', () => client.issue(input.issueUrl)); if (input.includeComments === true) observe('comments', () => client.comments(input.issueUrl)); }
  for (const m of input.metadata ?? []) observe(`metadata:${m.id}`, () => client.metadata(m, input.issueUrl));
  return result(gaps.length ? 'blocked' : 'verified', gaps.map(k => `Unavailable ${k}`), { observations });
}
