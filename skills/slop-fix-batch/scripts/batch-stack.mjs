#!/usr/bin/env node
// Bounded deterministic steps. Agents retain conflict, scope and remote-evidence judgment.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { check, version, absolute, nonempty, sha, readJson, save, cli } from './helper-common.mjs';
import { validateLedger, submitLedger } from './batch-ledger.mjs';
import { verifyPublication } from './verify-publication.mjs';
import { ledgerRuntime } from './runtime.mjs';
import { requestStatus, control } from './github-request.mjs';

export function runCommand(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  check(!result.error && result.status === 0, `${file} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim();
}
function context(input) {
  version(input); absolute(input.ledgerPath);
  const ledger = validateLedger(readJson(input.ledgerPath)), g = ledger.delegation?.grants[input.grantId];
  check(g?.status === 'active' && g.role === 'stack-execution' && g.worker === input.worker && g.generation === input.generation, 'Active stack-execution grant required');
  const a = ledger.assignments[g.assignmentId], s = ledger.stacks[a.stackId];
  check(a.status === 'active' && s.phase === 'building', 'START and building stack required');
  absolute(a.worktree); absolute(a.coordinationRoot); absolute(a.coordinationHelper); absolute(a.requestState);
  nonempty(a.coordinationId, 'coordination id'); nonempty(a.stackOwner, 'stable stack build owner'); nonempty(a.branch, 'assigned layer branch');
  return { ledger, g, a, s };
}
function preparedPrefix(s, runtime) {
  const p = s.publicationAttempt?.preparedPrefix;
  check(p && verifyPublication(p, runtime).complete && p.expected.stackId === s.id && p.expected.layers.length === s.layers.length, 'Verify matching prepared PRs and runtime attachment status before submit');
  s.layers.forEach((l, i) => {
    check(p.expected.layers[i].headSha === l.headSha && p.expected.layers[i].groupId === l.groupId, 'Prepared prefix differs from integration');
    if (l.publication) check(isDeepStrictEqual(p.expected.layers[i], l.publication.layer), 'Prepared prefix changes existing publication');
  });
  return p;
}
function record(input, events) {
  const { g } = context(input);
  const result = submitLedger(input.ledgerPath, { version: 1, grantId: g.id, worker: g.worker, generation: g.generation, sequence: g.sequence + 1, at: new Date().toISOString(), events });
  check(result.complete !== false, 'Ledger busy; retain attempt and reconcile before another command'); return result;
}
function registry(a, run) {
  const result = JSON.parse(run(process.execPath, [a.coordinationHelper, 'status'], a.worktree));
  check(Array.isArray(result.stacks), 'Incomplete coordination status'); return result;
}
function clean(a, run) {
  check(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], a.worktree) === a.coordinationRoot, 'Different Git common-directory root');
  check(!run('git', ['status', '--porcelain'], a.worktree), 'Integration checkout must be clean');
}
export function stepCommands(kind, a, s, runtime = 'codex') {
  switch (kind) {
    case 'init': check(s.layers.length === 0, 'Init only first layer'); nonempty(a.baseRef, 'pinned base ref'); return [['gh', ['stack', 'init', '--base', a.baseRef, a.branch]]];
    case 'add': check(s.layers.length && s.layers.at(-1).publication?.complete, 'Verify prior prefix before add'); return [['gh', ['stack', 'add', a.branch]]];
    case 'integrate':
      check(a.requirementsSatisfied === true && Array.isArray(a.commits) && a.commits.length, 'Missing checked implementation handoff');
      a.commits.forEach(sha); sha(a.workerStartSha);
      check(a.checks?.length && a.checks.every(c => c.status === 'passed' && c.sha === a.commits.at(-1) && c.command), 'Worker checks must cover final returned commit');
      return [['git', ['cherry-pick', ...a.commits]]];
    case 'submit': preparedPrefix(s, runtime); return [['gh', ['stack', 'submit', '--auto', '--open', '--remote', a.remote]]];
    case 'detach': check(s.layers.length === s.groups.length && s.layers.every(l => l.publication?.complete), 'Complete verified stack required before detach'); return [['git', ['switch', '--detach', s.layers.at(-1).headSha]]];
    default: throw new Error('Unsupported stack step');
  }
}
export function runStep(input, { run = runCommand } = {}) {
  const { ledger, a, s } = context(input);
  check(/^[\w.-]+$/.test(input.operationId ?? ''), 'Unique safe operation id required'); sha(input.expectedHead);
  check(!s.operations?.[input.operationId], 'Attempt already recorded; use reconcile, never repeat execution');
  check(!Object.values(s.operations ?? {}).some(o => o.status === 'uncertain'), 'Reconcile earlier operation');
  const kind = input.kind; check(['register', 'init', 'add', 'integrate', 'submit', 'detach', 'ready'].includes(kind), 'Unsupported stack step');
  clean(a, run);
  check(run('git', ['rev-parse', 'HEAD'], a.worktree) === input.expectedHead, 'Integration head mismatch');
  const r = registry(a, run), registered = r.stacks.find(x => x.id === a.coordinationId);
  if (kind !== 'register') check(registered?.phase === 'building' && registered.lock?.mode === 'build' && registered.lock.owner === a.stackOwner, 'Verified building ownership required');
  if (registered) check(registered.repository === ledger.repository && registered.batch === ledger.batchId && registered.ledger === input.ledgerPath, 'Coordination identity mismatch');
  const tip = s.layers.at(-1)?.headSha ?? s.baseSha;
  if (['init', 'add', 'integrate', 'submit', 'detach', 'ready'].includes(kind)) check(input.expectedHead === tip, 'Step must start at recorded integration tip');
  if (['init', 'add'].includes(kind)) {
    check(registered.layers.some(l => l.branch === a.branch), 'Register assigned branch before gh-stack creation');
    if (kind === 'init') check(run('git', ['rev-parse', a.baseRef], a.worktree) === s.baseSha, 'Pinned anchor moved');
    else check(run('git', ['branch', '--show-current'], a.worktree) === s.layers.at(-1).publication.layer.headBranch, 'Add must start on verified top layer');
  }
  if (kind === 'integrate') {
    check(run('git', ['branch', '--show-current'], a.worktree) === a.branch, 'Integration requires assigned layer branch');
    const commands = stepCommands(kind, a, s, ledgerRuntime(ledger)); // validates handoff before any mutation
    check(isDeepStrictEqual(run('git', ['rev-list', '--reverse', `${a.workerStartSha}..${a.commits.at(-1)}`], a.worktree).split('\n'), a.commits), 'Commit range includes missing or unrelated commits');
    for (const id of ledger.groups[a.groupId].requires) check(s.layers.some(l => l.groupId === id), 'Missing integrated prerequisite');
    run('git', ['merge-base', '--is-ancestor', a.workerStartSha, tip], a.worktree);
    check(commands.length === 1, 'Unexpected integration command');
  }
  if (kind === 'ready') {
    check(s.layers.length === s.groups.length && s.layers.every(l => l.publication?.complete), 'Complete assigned membership required');
    check(!run('git', ['branch', '--show-current'], a.worktree), 'Detach before ready');
    check(isDeepStrictEqual(registered.layers.map(l => l.pr), s.layers.map(l => l.url)), 'Registration differs from published prefix');
  }
  if (kind === 'submit') { nonempty(a.remote, 'verified push remote'); check(run('git', ['branch', '--show-current'], a.worktree) === preparedPrefix(s, ledgerRuntime(ledger)).expected.layers.at(-1).headBranch, 'Submit requires verified tip branch'); }
  if (!['register', 'ready'].includes(kind)) stepCommands(kind, a, s, ledgerRuntime(ledger));
  // Even CLI network work consults all known resource cooldowns and pending shared writes.
  const network = ['init', 'add', 'submit'].includes(kind);
  if (network) {
    const status = requestStatus({ version: 1, statePath: a.requestState });
    if (Object.values(status.cooldowns).some(t => t > Date.now())) return { version: 1, complete: false, status: 'cooldown' };
    if (Object.values(status.writes).some(w => w.status === 'uncertain' && !w.reconciled)) return { version: 1, complete: false, status: 'uncertain', reason: 'Reconcile shared writes before CLI mutation' };
    const eviction = control({ version: 1, statePath: a.requestState, action: 'invalidate' });
    if (eviction.complete === false) return eviction;
  }
  const op = { id: input.operationId, kind, owner: a.stackOwner, status: 'uncertain', headSha: input.expectedHead };
  record(input, [{ type: 'operation', stackId: s.id, value: op }]);
  let catalog = null;
  try {
    if (network) {
      catalog = JSON.parse(run(process.execPath, [a.coordinationHelper, 'catalog-acquire', '--stack', a.coordinationId, '--owner', a.stackOwner, '--token', registered.lock.token], a.worktree));
      op.catalogToken = catalog.token;
      record(input, [{ type: 'operation', stackId: s.id, value: { ...op, commandStarted: false }, progress: true, evidence: 'Catalog acquired; command not yet sent' }]);
      // Store the token before running gh; an interrupted catalog acquisition is recoverable via status.
      // The operation itself stays uncertain until the agent verifies the captured view and remote effects.
    }
    if (network) { op.commandStarted = true; record(input, [{ type: 'operation', stackId: s.id, value: op, progress: true, evidence: 'Record command boundary before gh-stack invocation' }]); }
    let output;
    if (kind === 'register') {
      const layers = s.layers.map(l => ({ branch: l.publication?.layer.headBranch ?? l.branch, headRepository: ledger.repository, pr: l.url ?? null }));
      if (!layers.some(l => l.branch === a.branch)) layers.push({ branch: a.branch, headRepository: ledger.repository, pr: null });
      check(layers.every(l => l.branch), 'Missing branch identity');
      const file = join(dirname(input.ledgerPath), `${input.operationId}.registration.json`);
      save(file, { id: a.coordinationId, batch: ledger.batchId, repository: ledger.repository, ledger: input.ledgerPath, layers });
      output = run(process.execPath, [a.coordinationHelper, 'register', '--file', file, '--owner', a.stackOwner, ...(registered ? ['--token', registered.lock.token] : [])], a.worktree);
    } else if (kind === 'ready') output = run(process.execPath, [a.coordinationHelper, 'ready', '--stack', a.coordinationId, '--owner', a.stackOwner, '--token', registered.lock.token], a.worktree);
    else {
      const commands = stepCommands(kind, a, s, ledgerRuntime(ledger));
      output = commands.map(([file, args]) => run(file, args, a.worktree)).join('\n');
    }
    const headSha = run('git', ['rev-parse', 'HEAD'], a.worktree);
    if (network) {
      const catalogView = JSON.parse(run('gh', ['stack', 'view', '--json'], a.worktree));
      control({ version: 1, statePath: a.requestState, action: 'invalidate' });
      control({ version: 1, statePath: a.requestState, action: 'observe-cli', entryPoint: `batch-stack:${kind}` });
      return { version: 1, complete: false, status: 'needs-verification', operationId: op.id, headSha, catalogToken: catalog.token, catalogView, output };
    }
    clean(a, run);
    record(input, [{ type: 'operation', stackId: s.id, value: { ...op, status: 'verified', resultHeadSha: headSha }, reconciled: true, evidence: `Completed ${kind}; clean checkout at ${headSha}; output ${output}` }]);
    return { version: 1, complete: true, headSha, output };
  } catch (error) {
    if (network) {
      try {
        control({ version: 1, statePath: a.requestState, action: 'invalidate' });
        control({ version: 1, statePath: a.requestState, action: 'observe-cli', entryPoint: `batch-stack:${kind}`, limited: /rate limit|secondary|abuse/i.test(error.message) });
      } catch { /* Unknown effects and representation invalidation remain protected by the recorded operation. */ }
      if (!catalog && !op.commandStarted) {
        try {
          const observed = registry(a, run);
          if (observed.catalog && observed.catalog.stack !== a.coordinationId && !observed.transaction) {
            record(input, [{ type: 'operation', stackId: s.id, value: { ...op, status: 'rejected' }, reconciled: true, evidence: 'Catalog held by another stack; this command was never sent' }]);
            return { version: 1, complete: false, status: 'busy', operationId: op.id, reason: 'Shared catalog held by another stack; no command sent' };
          }
        } catch { /* Retain unknown ownership if even contention cannot be proved. */ }
      }
    }
    return { version: 1, complete: false, status: 'uncertain', operationId: op.id, catalogToken: catalog?.token ?? null, reason: error.message };
  }
}
export function reconcileStep(input, { run = runCommand } = {}) {
  const { a, s } = context(input), op = s.operations?.[input.operationId];
  check(op?.status === 'uncertain' && op.owner === a.stackOwner, 'No owned unresolved attempt');
  check(input.gitOperationsClear === true && input.remoteReconciled === true && typeof input.verified === 'boolean', 'Missing operation reconciliation proof');
  nonempty(input.evidence, 'actual operation and remote evidence'); clean(a, run);
  const r = registry(a, run);
  if (r.catalog?.stack === a.coordinationId) {
    check(r.catalog.stack === a.coordinationId && r.catalog.owner === a.stackOwner && input.catalogToken === r.catalog.token, 'Catalog ownership mismatch');
    run(process.execPath, [a.coordinationHelper, 'catalog-release', '--owner', a.stackOwner, '--token', r.catalog.token], a.worktree);
  }
  const headSha = run('git', ['rev-parse', 'HEAD'], a.worktree);
  record(input, [{ type: 'operation', stackId: s.id, value: { ...op, status: input.verified ? 'verified' : 'rejected', resultHeadSha: headSha }, reconciled: true, evidence: input.evidence }]);
  return { version: 1, complete: true, headSha };
}
export function prepareWorktree(input, { run = runCommand } = {}) {
  version(input); absolute(input.checkout); absolute(input.path); sha(input.startSha); absolute(input.commonRoot);
  check(input.mode === 'execution' && input.authorization && input.owner, 'Execution worktree preparation requires recorded authorization');
  check(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], input.checkout) === input.commonRoot, 'Source common-directory mismatch');
  check(run('git', ['rev-parse', `${input.startSha}^{commit}`], input.checkout) === input.startSha, 'Starting commit unavailable');
  // Never switches or resets an existing checkout. A failed add remains a recovery blocker.
  run('git', ['worktree', 'add', '--detach', input.path, input.startSha], input.checkout);
  check(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], input.path) === input.commonRoot, 'New worktree uses another common directory');
  check(run('git', ['rev-parse', 'HEAD'], input.path) === input.startSha && !run('git', ['status', '--porcelain'], input.path), 'New worktree identity/status mismatch');
  return { version: 1, complete: true, path: input.path, startSha: input.startSha };
}
cli(import.meta.url, 'batch-stack.mjs <run|reconcile|worktree> input.json', ([command, path]) => {
  check(path, 'Missing input'); const input = readJson(path);
  if (command === 'run') return runStep(input);
  if (command === 'reconcile') return reconcileStep(input);
  check(command === 'worktree', 'Unknown command'); return prepareWorktree(input);
});
