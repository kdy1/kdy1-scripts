#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { target, check, absolute, run, readJson, save, GitHub, choose, content, preserve, attachmentImages } from './core.mjs';

export function inspect(p, client = new GitHub(p), transport = run) {
  target(p); absolute(p.checkout);
  const observations = {}, errors = [];
  const observe = (key, fn) => { try { observations[key] = fn(); } catch (e) { errors.push(`${key}: ${e.message}`); } };
  const git = (...args) => { const r = transport('git', ['-C', p.checkout, ...args]); check(r.ok, r.stderr || 'Git read failed'); return r.stdout.trim(); };
  observe('authentication', () => { const r = client.command(['auth', 'status', '--hostname', p.host]); check(r.ok, 'gh authentication unavailable'); return true; });
  observe('repository', () => { const r = client.repository(); return { repository: r.full_name, defaultBranch: r.default_branch }; });
  observe('checkout', () => ({ root: git('rev-parse', '--show-toplevel'), branch: git('branch', '--show-current'), headSha: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1'), remotes: git('remote', '-v') }));
  observe('diff', () => ({ stat: git('diff', '--stat', `${p.baseRef ?? p.baseBranch}...HEAD`), files: git('diff', '--name-status', `${p.baseRef ?? p.baseBranch}...HEAD`) }));
  observe('pr', () => choose(p, client));
  observe('remoteHeadSha', () => client.remoteHead());
  observe('attachmentSupport', () => Object.fromEntries(['create', 'edit'].map(action => { const r = client.command(['pr', action, '--help']); return [action, r.ok && /(?:^|\n)\s+--attach\s/m.test(r.stdout)]; })));
  return { version: 1, status: errors.length ? 'incomplete' : 'observed', observations, errors };
}

export function verify(p, body, actual, { defaultBranch, attachments = [] } = {}) {
  const errors = [...content(p, body).errors];
  for (const key of ['repository', 'headRepository', 'headBranch', 'headSha', 'baseBranch', 'draft', 'title']) if (actual[key] !== p[key]) errors.push(`${key} mismatch`);
  if (p.prUrl && actual.url !== p.prUrl) errors.push('PR URL mismatch');
  if (actual.state !== 'OPEN') errors.push(`PR is ${actual.state}`);
  errors.push(...content(p, actual.body).errors);
  // The CLI may append uploaded image Markdown, but must not change prepared prose.
  if (actual.body !== body) {
    const suffix = actual.body.startsWith(body) ? actual.body.slice(body.length) : null;
    if (suffix === null || attachmentImages(suffix).reduce((rest, image) => rest.replace(image, ''), suffix).trim()) errors.push('Prepared body mismatch');
  }
  const images = attachmentImages(actual.body);
  if (new Set(images).size !== images.length) errors.push('Duplicate attachment Markdown');
  const urls = images.map(x => x.slice(x.indexOf('](') + 2, -1));
  if (new Set(urls).size !== urls.length) errors.push('Duplicate attachment URL');
  const outcomes = attachments.map(image => {
    const attached = images.some(x => x.startsWith(`![${image.alt}](`));
    return { ...image, attached, omitted: attached ? null : image.omitted ?? 'No matching GitHub attachment observed; inspect upload outcome before retrying' };
  });
  return { version: 1, status: errors.length ? 'mismatch' : 'verified', complete: !errors.length, errors, pr: actual, attachments: outcomes,
    automaticClosure: defaultBranch === p.baseBranch,
    limitations: defaultBranch !== p.baseBranch && p.issues.some(x => x.kind === 'closes') ? ['Base is not the default branch; automatic issue closure will not occur'] : [],
    manualChecks: ['Selected language and factual meaning', 'Preservation of unrelated body prose', 'Screenshot relevance and captured revision', 'Local validation coverage', 'Codex attach_artifact result'] };
}

export function reconcile(journal, client = new GitHub(journal.plan)) {
  const { plan: p, body } = journal;
  const selected = choose(p, client);
  if (!selected.pr) return { version: 1, status: 'uncertain', errors: ['No matching PR observed; absence alone does not authorize retry'], attempts: journal.attempts };
  if (selected.status === 'stopped') return { version: 1, ...selected };
  return { ...verify(p, body, selected.pr, { defaultBranch: client.repository().default_branch, attachments: journal.attachments }), writeAttempts: journal.attempts };
}

export function publish(p, body, journalPath, client = new GitHub(p)) {
  absolute(journalPath);
  const validation = content(p, body); check(!validation.errors.length, validation.errors.join('; '));
  mkdirSync(resolve(journalPath, '..'), { recursive: true });
  try { mkdirSync(`${journalPath}.lock`); } catch { throw new Error('Publication journal is locked'); }
  try {
    check(!existsSync(journalPath), 'Journal already exists; use reconcile. Do not repeat writes blindly');
    const selected = choose(p, client);
    if (selected.status === 'stopped') return { version: 1, ...selected };
    check(client.remoteHead() === p.headSha, 'Expected head SHA is not pushed');
    const repo = client.repository(); check(repo.full_name === p.repository, 'Repository mismatch');
    const comparison = client.comparison();
    check(Array.isArray(comparison.files), 'Comparison unavailable');
    if (!comparison.files.length) return { version: 1, status: 'stopped', reason: 'No intended change against base', pr: selected.pr };
    for (const issue of p.issues) client.issue(issue.repository, issue.number);
    if (selected.pr) check(!preserve(p, selected.pr.body, body).length, preserve(p, selected.pr.body, body).join('; '));
    const action = selected.pr ? 'edit' : 'create';
    const help = client.command(['pr', action, '--help']);
    const supported = help.ok && /(?:^|\n)\s+--attach\s/m.test(help.stdout);
    const attachments = p.attachments.map(image => ({ ...image, omitted: !existsSync(image.path) || !statSync(image.path).isFile() ? 'File missing or not a regular file' : !supported ? 'CLI --attach unavailable; use native authenticated browser attachment flow' : null }));
    check(new Set(attachments.map(x => x.alt)).size === attachments.length, 'Use distinct attachment alt descriptions');
    for (const image of attachments) check(!attachmentImages(body).some(x => x.startsWith(`![${image.alt}](`)), 'Attachment already appears in body; pass only missing screenshots');
    const journal = { version: 1, plan: structuredClone(p), body, before: selected.pr, attachments, attempts: [], state: 'prepared' };
    save(journalPath, journal);
    // Recheck immediately before creation to detect a PR created during preparation.
    const final = choose(p, client);
    check(final.status === 'ready' && (final.pr?.url ?? null) === (selected.pr?.url ?? null), 'PR selection changed; reconcile');
    if (final.pr) check(final.pr.body === selected.pr.body && final.pr.title === selected.pr.title && final.pr.draft === selected.pr.draft, 'PR content changed during preparation');
    check(client.remoteHead() === p.headSha, 'Remote head changed during preparation');
    const bodyPath = `${journalPath}.body.md`;
    // Snapshot the exact body rather than trusting a mutable caller file.
    writeFileSync(bodyPath, body, { mode: 0o600, flag: 'wx' });
    try {
      const args = ['pr', action];
      if (selected.pr) args.push(selected.pr.url);
      args.push('--repo', `${p.host}/${p.repository}`, '--title', p.title, '--body-file', bodyPath);
      if (!selected.pr) { args.push('--base', p.baseBranch, '--head', p.headRepository === p.repository ? p.headBranch : `${p.headRepository.split('/')[0]}:${p.headBranch}`); if (p.draft) args.push('--draft'); }
      for (const image of attachments.filter(x => !x.omitted)) args.push('--attach', `${image.path}#${image.alt}`);
      journal.state = 'attempting'; journal.attempts.push({ action, startedAt: new Date().toISOString() }); save(journalPath, journal);
      const result = client.command(args); Object.assign(journal.attempts.at(-1), { ok: result.ok, code: result.code, error: result.ok ? null : result.stderr || result.error || 'Write failed' });
      journal.state = 'observing'; save(journalPath, journal);
      // A non-zero result may still have created the PR or uploaded some images.
      const observed = choose(p, client);
      check(observed.status === 'ready' && observed.pr, 'Write outcome uncertain; reconcile before further writes');
      journal.plan.prUrl = observed.pr.url; save(journalPath, journal);
      if (!result.ok) { journal.outcome = { ...verify(p, body, observed.pr, { defaultBranch: repo.default_branch, attachments }), writeAttempts: journal.attempts }; journal.state = journal.outcome.status; save(journalPath, journal); return journal.outcome; }
      if (observed.pr.draft !== p.draft) {
        journal.attempts.push({ action: 'ready', startedAt: new Date().toISOString() }); journal.state = 'attempting'; save(journalPath, journal);
        const ready = client.command(['pr', 'ready', observed.pr.url, '--repo', `${p.host}/${p.repository}`, ...(p.draft ? ['--undo'] : [])]);
        Object.assign(journal.attempts.at(-1), { ok: ready.ok, code: ready.code }); save(journalPath, journal);
      }
      journal.outcome = { ...verify(p, body, client.pr(observed.pr.url), { defaultBranch: repo.default_branch, attachments }), writeAttempts: journal.attempts };
      journal.state = journal.outcome.status; save(journalPath, journal); return journal.outcome;
    } finally { rmSync(bodyPath, { force: true }); }
  } finally { rmSync(`${journalPath}.lock`, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, input, extra] = process.argv.slice(2); const p = readJson(input);
    let result;
    if (command === 'inspect') result = inspect(p);
    else if (command === 'reconcile') result = reconcile(p);
    else {
      const body = readFileSync(absolute(p.bodyFile), 'utf8');
      if (command === 'check-content') result = content(p, body);
      else if (command === 'publish') result = publish(p, body, extra);
      else if (command === 'verify') { const client = new GitHub(p), selected = choose(p, client); check(selected.status === 'ready' && selected.pr, 'No open matching PR'); result = verify(p, body, selected.pr, { defaultBranch: client.repository().default_branch }); }
      else throw new Error('Usage: create-pr.mjs inspect|check-content|publish|verify manifest.json [journal.json], or reconcile journal.json');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (['mismatch', 'incomplete', 'uncertain'].includes(result.status)) process.exitCode = 1;
  } catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
}
