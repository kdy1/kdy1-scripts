import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { audit, commandKey, frontMatter, workflowCommands } from './audit.mjs';

const fixtures = [];
after(() => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });

function repository(files, links = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-instructions-'));
  fixtures.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  return root;
}

const kinds = result => result.findings.map(finding => `${finding.kind} ${finding.path}`).sort();

test('frontMatter reads plain, quoted and folded fields', () => {
  assert.deepEqual(frontMatter('---\nname: a\ndescription:\n  first line\n  second line\nflag: "true"\n---\nbody'), {
    name: 'a', description: 'first line second line', flag: 'true',
  });
  assert.deepEqual(frontMatter('no front matter'), {});
});

test('workflowCommands reads inline and block run steps', () => {
  const yaml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: cargo test --workspace',
    '      - name: Many',
    '        run: |',
    '          # comment',
    '          pnpm install',
    '',
    '          go vet ./...',
    '      - uses: actions/checkout@v4',
  ].join('\n');
  assert.deepEqual(workflowCommands(yaml).map(entry => entry.command), ['cargo test --workspace', 'pnpm install', 'go vet ./...']);
});

test('commandKey keeps the tool, subcommand and runner target', () => {
  assert.equal(commandKey('cargo clippy --workspace -- -D warnings'), 'cargo clippy');
  assert.equal(commandKey('pnpm exec turbo run build lint'), 'pnpm exec turbo run build');
  assert.equal(commandKey('scripts/ci/validate.sh'), 'scripts/ci/validate.sh');
  assert.equal(commandKey('echo done'), null);
});

test('reports a CLAUDE.md that hides AGENTS.md files', () => {
  const root = repository({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Other rules\n', 'web/AGENTS.md': '# Web\n' });
  assert.deepEqual(kinds(audit(root)), ['claude-md-hides-agents-md CLAUDE.md']);
});

test('accepts a CLAUDE.md that imports or links to AGENTS.md', () => {
  const imported = repository({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n\n## Claude only\n' });
  assert.deepEqual(kinds(audit(imported)), []);
  const linked = repository({ 'AGENTS.md': '# Rules\n' }, { 'CLAUDE.md': 'AGENTS.md' });
  assert.deepEqual(kinds(audit(linked)), []);
});

test('reports explicit-only skills that agents can still select', () => {
  const root = repository({
    '.agents/skills/batch/SKILL.md': '---\nname: batch\ndescription: Use only when a human explicitly invokes $batch.\n---\n',
    '.agents/skills/batch/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
    '.agents/skills/setup/SKILL.md': '---\nname: setup\ndescription: Use only when a human explicitly invokes $setup.\ndisable-model-invocation: true\n---\n',
    '.agents/skills/setup/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
    '.agents/skills/upstream/SKILL.md': '---\nname: upstream\ndescription: Do not use automatically.\n---\n',
    'skills-lock.json': JSON.stringify({ version: 2, skills: { upstream: {} } }),
  }, { '.claude/skills': '../.agents/skills' });
  const result = audit(root);
  assert.deepEqual(kinds(result), ['skill-explicit-only-without-claude-setting .agents/skills/batch']);
  assert.equal(result.skills.length, 3, 'the .claude/skills symlink does not duplicate skills');
  assert.equal(result.skills.find(skill => skill.name === 'upstream').imported, true);
});

test('reports interactive commands, unknown filters, missing paths and broken links once', () => {
  const root = repository({
    'AGENTS.md': [
      'Run `pnpm changeset`, or `pnpm changeset` again.',
      'Test with `pnpm exec turbo run test --filter=web` and `--filter=./apps/web` and `--filter=web-app`.',
      'See `apps/web/README.md`, `apps/api/` and `log/slog`.',
      'Read [the contract](docs/missing.md) and [the app](apps/web/README.md#usage).',
    ].join('\n'),
    'apps/web/package.json': JSON.stringify({ name: 'web-app', scripts: { test: 'vitest' } }),
    'apps/web/README.md': '# Web\n',
  });
  const result = audit(root);
  assert.deepEqual(result.findings.map(finding => [finding.kind, finding.line]), [
    ['interactive-command', 1],
    ['unknown-package-filter', 2],
    ['missing-path', 3],
    ['broken-link', 4],
  ]);
  assert.deepEqual(result.packages, [{ dir: 'apps/web', name: 'web-app', nameDiffersFromDir: true, scripts: ['test'] }]);
});

test('marks CI commands that no instruction file mentions', () => {
  const root = repository({
    'AGENTS.md': 'Run `cargo test` before you finish.\n',
    '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: cargo test --locked\n      - run: cargo clippy -- -D warnings\n',
  });
  assert.deepEqual(audit(root).ciCommands.map(entry => [entry.key, entry.mentioned]), [['cargo test', true], ['cargo clippy', false]]);
});
