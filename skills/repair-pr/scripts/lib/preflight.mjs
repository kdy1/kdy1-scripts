import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinationStore, canonicalPr } from '../stack-coordination.mjs';
import { assert, api, git, json, run, readPR, repoFromUrl, canonicalPath } from './common.mjs';

function remotes(repository, push) {
  return git('remote').split('\n').filter(Boolean).filter(name => {
    const urls = git('remote', 'get-url', ...(push ? ['--push'] : []), '--all', name).split('\n');
    return urls.length === 1 && repoFromUrl(urls[0]) === repository;
  });
}
function catalogContains(value, pr) {
  if (typeof value === 'string') return value === pr.url || value === pr.headBranch;
  if (Array.isArray(value)) return value.some(v => catalogContains(v, pr));
  return value && typeof value === 'object' && Object.values(value).some(v => catalogContains(v, pr));
}
function readNativeStack(pr) {
  const [owner, name] = pr.slug.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){url headRefName headRefOid baseRefName baseRefOid stack{id}}}}';
  const result = json('gh', ['api', '--hostname', pr.host, 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`]);
  const node = result.data?.repository?.pullRequest;
  assert(node && canonicalPr(node.url) === pr.url && node.headRefName === pr.headBranch
    && node.headRefOid === pr.headSha && node.baseRefName === pr.baseBranch && node.baseRefOid === pr.baseSha
    && Object.hasOwn(node, 'stack'), 'Incomplete or changed native stack identity');
  return node.stack;
}
export function preflight(prArg, ownership = null) {
  const report = { ready: false, blockers: [], stack: null };
  try {
    run('gh', ['--version']); run('gh', ['auth', 'status']);
    report.root = canonicalPath(git('rev-parse', '--show-toplevel'));
    report.commonDir = canonicalPath(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
    report.checkout = canonicalPath(process.cwd());
    report.pr = readPR(prArg);
    const pr = report.pr;
    report.branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], true).stdout.trim() || null;
    report.headSha = git('rev-parse', 'HEAD');
    report.dirty = Boolean(git('status', '--porcelain'));
    report.operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']
      .filter(name => existsSync(git('rev-parse', '--git-path', name)));
    if (report.dirty) report.blockers.push('Pre-existing or unstaged worktree changes');
    if (report.branch !== pr.headBranch) report.blockers.push('Checkout required: current branch differs from PR head (or is detached)');
    if (report.operations.length) report.blockers.push(`Pending Git operations: ${report.operations.join(', ')}`);
    if (pr.state !== 'OPEN') report.blockers.push('PR is not open');
    const worktrees = git('worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map(block => Object.fromEntries(block.split('\n').map(line => {
      const i = line.indexOf(' '); return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
    })));
    report.worktrees = worktrees;
    const currentRoot = report.root;
    if (worktrees.some(w => w.branch === `refs/heads/${pr.headBranch}` && canonicalPath(w.worktree) !== currentRoot)) report.blockers.push('PR branch belongs to another worktree');
    const base = remotes(pr.repository, false), push = remotes(pr.headRepository, true);
    report.baseRemotes = base; report.pushRemotes = push;
    if (base.length !== 1) report.blockers.push('Missing or ambiguous base remote'); else report.baseRemote = base[0];
    if (push.length !== 1) report.blockers.push('Missing or ambiguous push remote'); else report.pushRemote = push[0];
    const registry = new CoordinationStore(join(report.commonDir, 'codex-stack-coordination')).status();
    if (registry.transaction) report.blockers.push('Registry transaction active or interrupted');
    const byPR = registry.stacks.filter(s => s.layers.some(l => l.pr === pr.url));
    const byBranch = registry.stacks.filter(s => s.layers.some(l => l.branch === pr.headBranch && l.headRepository === pr.headRepository));
    assert(byPR.length <= 1 && byBranch.length <= 1 && byPR[0]?.id === byBranch[0]?.id, 'Ambiguous registry membership');
    report.stack = byPR[0] ?? null;
    if (report.stack) {
      const layer = report.stack.layers.find(l => l.pr === pr.url);
      assert(layer?.branch === pr.headBranch && layer.headRepository === pr.headRepository, 'Registered PR/head mismatch');
      if (report.stack.phase !== 'ready') report.blockers.push('Stack is building');
      if (report.stack.lock && !(ownership && report.stack.lock.owner === ownership.owner && report.stack.lock.token === ownership.token && ['repair', 'edit'].includes(report.stack.lock.mode))) report.blockers.push('Stack has another owner or an unclaimed reservation');
      if (registry.catalog?.stack === report.stack.id) report.blockers.push('Stack catalog operation must be reconciled first');
    }
    // Examine GitHub relationships even when the local registry is empty.
    const relationships = [];
    for (let page = 1; ; page++) {
      const items = api(pr.host, `repos/${pr.slug}/pulls?state=open&per_page=100&page=${page}`);
      assert(Array.isArray(items), 'Incomplete PR relationship read');
      relationships.push(...items.filter(x => x.number !== pr.number && ((x.head?.ref === pr.baseBranch && `${pr.host}/${x.head?.repo?.full_name}`.toLowerCase() === pr.repository) || (x.base?.ref === pr.headBranch && pr.headRepository === pr.repository))));
      if (items.length < 100) break;
    }
    const repo = api(pr.host, `repos/${pr.slug}`);
    assert(typeof repo.default_branch === 'string', 'Missing repository default branch');
    report.relationships = relationships.map(x => canonicalPr(x.html_url));
    const help = run('gh', ['stack', '--help'], true);
    if (help.status === 0) {
      const view = run('gh', ['stack', 'view', '--json'], true);
      if (view.status === 0) {
        report.catalog = JSON.parse(view.stdout);
        assert(!report.catalog?.errors?.length, 'Cannot read gh-stack catalog');
      } else {
        const error = view.stderr.trim() || view.stdout.trim();
        const missing = error.match(/\bbranch (["'])(.+?)\1 is not part of a stack\b/);
        assert(missing?.[2] === pr.headBranch && report.branch === pr.headBranch, `gh stack view failed: ${error || view.signal || view.status}`);
        // gh-stack stores its catalog per worktree. A new repair checkout can
        // lack that catalog without losing the common-directory ownership record.
        // Only positively verified standalone membership permits this fallback.
        assert(!relationships.length && pr.baseBranch === repo.default_branch
          && (!report.stack || report.stack.layers.length === 1), 'Missing local catalog for a related or nondefault-base stack; reconcile membership');
        report.nativeStack = readNativeStack(pr);
        assert(report.nativeStack === null, 'Native stack membership exists; reconcile the missing local catalog');
        report.catalogStatus = 'absent-in-worktree';
        report.catalogError = error;
      }
    } else assert(/unknown command ["']?stack/i.test(help.stderr + help.stdout), 'Cannot determine gh-stack availability');
    if (!report.stack && (relationships.length || pr.baseBranch !== repo.default_branch || catalogContains(report.catalog, pr))) report.blockers.push('Unregistered or uncertain stack: verify full membership and register before mutation');
    report.mode = report.stack ? 'stack' : report.blockers.length ? 'unknown' : 'ordinary';
    if (report.stack) {
      const index = report.stack.layers.findIndex(l => l.pr === pr.url);
      const parent = report.stack.layers[index - 1];
      if (parent && (pr.baseBranch !== parent.branch || parent.headRepository !== pr.repository)) report.blockers.push('Registered stack base relationship mismatch');
      if (relationships.some(item => !report.stack.layers.some(l => l.pr === canonicalPr(item.html_url)))) report.blockers.push('GitHub stack relationship missing from registry');
    }
  } catch (error) { report.blockers.push(error.message); }
  report.ready = report.blockers.length === 0;
  return report;
}
