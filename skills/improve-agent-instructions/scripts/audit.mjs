#!/usr/bin/env node
// Collects deterministic facts about a repository's agent instruction files
// and skills. The output is a list of candidates; the agent verifies each one
// before it changes a file.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'copilot-instructions.md'];
const CLAUDE_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md']);
export const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.codex/skills'];
const EXPLICIT_ONLY = /explicit(?:ly)?\s+invo|only when (?:a |the )?(?:human|user)|do not (?:activate|select|use) (?:it )?automatically|never select (?:it )?automatically|direct(?:ly)? (?:human )?invo/i;
const INTERACTIVE = [
  { pattern: /^(?:pnpm|npx|yarn|bunx?)(?: exec)? changeset(?: add)?$/, hint: 'prompts for packages and bump types' },
  { pattern: /^gh auth login(?:$| (?!.*--with-token))/, hint: 'prompts unless --with-token is given' },
  { pattern: /^git (?:rebase|add|commit|checkout|reset|stash) .*(?:^| )(?:-i|-p|--interactive|--patch)(?: |$)/, hint: 'opens an interactive prompt or editor' },
  { pattern: /^(?:npm|pnpm|yarn) init$/, hint: 'prompts unless -y is given' },
  { pattern: /^infisical (?:login|init)(?: |$)/, hint: 'opens an interactive login or project selection' },
];
const CI_TOOLS = new Set(['cargo', 'go', 'pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'deno', 'node', 'python', 'python3', 'uv', 'uvx', 'pytest', 'make', 'just', 'buf', 'tox', 'ruff', 'mypy', 'gofmt', 'rustfmt', 'swift', 'xcodebuild', 'gradle', './gradlew', 'mvn', 'dotnet']);
const RUNNERS = new Set(['run', 'exec', 'dlx', 'x']);

const toPosix = path => path.split('\\').join('/');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function listFiles(root) {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0').filter(Boolean).filter(path => existsSync(join(root, path)) || isLink(join(root, path)));
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Imported skills are upstream content; the agent must not edit them.
function importedSkills(root) {
  const lock = read(join(root, 'skills-lock.json'));
  if (!lock) return new Set();
  try { return new Set(Object.keys(JSON.parse(lock).skills ?? {})); } catch { return new Set(); }
}

function insideSkillRoot(path) {
  return SKILL_ROOTS.some(skillRoot => path === skillRoot || path.startsWith(`${skillRoot}/`));
}

export function instructionFiles(files) {
  return files
    .filter(path => INSTRUCTION_FILES.includes(posix.basename(path)) && !insideSkillRoot(path) && !path.split('/').includes('node_modules'))
    .filter(path => posix.basename(path) !== 'copilot-instructions.md' || path === '.github/copilot-instructions.md')
    .sort();
}

// Claude Code reads AGENTS.md only when no CLAUDE.md, .claude/CLAUDE.md or
// CLAUDE.local.md exists in the same directory or above it, unless that file
// imports or links to AGENTS.md.
export function claudeShadowing(root, instructions) {
  const findings = [];
  const agents = instructions.filter(path => posix.basename(path) === 'AGENTS.md');
  for (const path of instructions.filter(path => CLAUDE_FILES.has(posix.basename(path)))) {
    let dir = posix.dirname(path);
    if (posix.basename(dir) === '.claude') dir = posix.dirname(dir);
    const scope = dir === '.' ? '' : `${dir}/`;
    const hidden = agents.filter(agent => agent.startsWith(scope));
    if (!hidden.length) continue;
    const full = join(root, path);
    const linked = isLink(full) && posix.basename(toPosix(readlinkSync(full))) === 'AGENTS.md';
    const imports = /^@(?:\.\/)?AGENTS\.md\s*$/m.test(read(full) ?? '');
    if (linked || imports) continue;
    findings.push({ kind: 'claude-md-hides-agents-md', path, detail: `Claude Code reads ${path} instead of ${hidden.join(', ')}` });
  }
  return findings;
}

export function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? '');
  if (!match) return {};
  const fields = {};
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      fields[key] = field[2].replace(/^(['"])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

export function skills(root, files) {
  const imported = importedSkills(root);
  const seen = new Map();
  const result = [];
  for (const skillRoot of SKILL_ROOTS) {
    const dir = join(root, skillRoot);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const skillDir = join(dir, entry);
      const manifest = join(skillDir, 'SKILL.md');
      if (!existsSync(manifest)) continue;
      const real = realpathSync(skillDir);
      const fields = frontMatter(read(manifest));
      const openai = read(join(skillDir, 'agents', 'openai.yaml'));
      const implicit = openai === null ? null : !/^\s*allow_implicit_invocation:\s*false\s*$/m.test(openai);
      const skill = {
        path: toPosix(relative(root, skillDir)),
        name: fields.name ?? entry,
        imported: imported.has(entry),
        tracked: files.includes(`${skillRoot}/${entry}/SKILL.md`),
        explicitOnlyWording: EXPLICIT_ONLY.test(fields.description ?? ''),
        disableModelInvocation: fields['disable-model-invocation'] === 'true',
        codexImplicitInvocation: implicit,
      };
      const previous = seen.get(skill.name);
      if (previous && previous.real === real) continue;
      skill.duplicateOf = previous?.path ?? null;
      seen.set(skill.name, { real, path: skill.path });
      result.push(skill);
    }
  }
  return result;
}

export function skillFindings(list) {
  const findings = [];
  for (const skill of list) {
    if (skill.duplicateOf) findings.push({ kind: 'skill-duplicate', path: skill.path, detail: `same name as ${skill.duplicateOf} in a separate directory` });
    if (skill.imported) continue;
    const claudeOff = skill.disableModelInvocation;
    const codexOff = skill.codexImplicitInvocation === false;
    if (skill.explicitOnlyWording && !claudeOff) findings.push({ kind: 'skill-explicit-only-without-claude-setting', path: skill.path, detail: 'description asks for explicit invocation, but SKILL.md lacks disable-model-invocation: true' });
    if (skill.explicitOnlyWording && !codexOff) findings.push({ kind: 'skill-explicit-only-without-codex-setting', path: skill.path, detail: 'description asks for explicit invocation, but agents/openai.yaml does not set policy.allow_implicit_invocation: false' });
    if (claudeOff !== codexOff && !skill.explicitOnlyWording) findings.push({ kind: 'skill-invocation-mismatch', path: skill.path, detail: `Claude Code implicit invocation is ${claudeOff ? 'off' : 'on'}, Codex is ${codexOff ? 'off' : 'on'}` });
  }
  return findings;
}

export function packages(root, files) {
  return files
    .filter(path => posix.basename(path) === 'package.json' && !path.split('/').includes('node_modules') && path !== 'package.json')
    .map(path => {
      let json = {};
      try { json = JSON.parse(read(join(root, path))); } catch { /* reported as an empty package */ }
      const dir = posix.dirname(path);
      return { dir, name: json.name ?? null, nameDiffersFromDir: json.name ? json.name.split('/').pop() !== posix.basename(dir) : false, scripts: Object.keys(json.scripts ?? {}).sort() };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

// Extracts the commands of `run:` steps, including block scalars.
export function workflowCommands(text) {
  const commands = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const step = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!step) continue;
    const value = step[2].trim();
    if (value && !/^[|>][-+]?$/.test(value)) {
      commands.push({ line: i + 1, command: value.replace(/^(['"])(.*)\1$/, '$2') });
      continue;
    }
    const indent = step[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].search(/\S/) <= indent) break;
      const command = lines[j].trim();
      if (!command.startsWith('#')) commands.push({ line: j + 1, command });
      i = j;
    }
  }
  return commands;
}

export function commandKey(command) {
  const tokens = command.replace(/^(?:sudo|env \S+=\S+)\s+/, '').split(/\s+/);
  if (!CI_TOOLS.has(tokens[0]) && !/^(?:\.\/)?scripts\//.test(tokens[0])) return null;
  const key = tokens.slice(0, 2);
  if (RUNNERS.has(tokens[1]) && tokens[2]) key.push(tokens[2]);
  if (tokens[1] === 'exec' && RUNNERS.has(tokens[3]) && tokens[4]) key.push(tokens[3], tokens[4]);
  return key.filter(token => token && !token.startsWith('-')).join(' ');
}

export function ciCommands(root, files, instructionText) {
  const result = [];
  for (const path of files.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).sort()) {
    for (const { line, command } of workflowCommands(read(join(root, path)) ?? '')) {
      const key = commandKey(command);
      if (key) result.push({ workflow: path, line, command, key, mentioned: instructionText.includes(key) });
    }
  }
  return result;
}

// Returns each distinct code span once per line.
function codeSpans(text) {
  const spans = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const code = match[1].trim();
      spans.set(`${index + 1}\0${code}`, { line: index + 1, code });
    }
  });
  return [...spans.values()];
}

export function instructionFindings(root, path, text, packageList) {
  const findings = [];
  const names = new Set(packageList.map(pkg => pkg.name).filter(Boolean));
  const dir = posix.dirname(path);
  for (const { line, code } of codeSpans(text)) {
    for (const { pattern, hint } of INTERACTIVE) {
      if (pattern.test(code)) findings.push({ kind: 'interactive-command', path, line, detail: `\`${code}\` ${hint}; check that a non-interactive alternative is documented` });
    }
    for (const match of code.matchAll(/--filter[= ]([^\s'"]+)/g)) {
      const filter = match[1];
      if (/^[!.]|[<*{]|\.\.\.$/.test(filter) || names.has(filter)) continue;
      findings.push({ kind: 'unknown-package-filter', path, line, detail: `--filter=${filter} matches no package name; use a package name or a ./ path filter` });
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]*$/.test(code) || code.startsWith('@')) continue;
    const first = code.split('/')[0];
    const bases = [root, join(root, dir)].filter(base => existsSync(join(base, first)));
    if (bases.length && !bases.some(base => existsSync(join(base, code)))) findings.push({ kind: 'missing-path', path, line, detail: `\`${code}\` does not exist; check whether it is planned, renamed or removed` });
  }
  text.split(/\r?\n/).forEach((content, index) => {
    for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
      if (!existsSync(resolve(root, dir, decodeURI(target)))) findings.push({ kind: 'broken-link', path, line: index + 1, detail: `link target ${target} does not exist` });
    }
  });
  return findings;
}

export function audit(rootArg) {
  const root = git(resolve(rootArg), ['rev-parse', '--show-toplevel']).trim();
  const files = listFiles(root);
  const instructions = instructionFiles(files);
  const texts = Object.fromEntries(instructions.map(path => [path, read(join(root, path)) ?? '']));
  const packageList = packages(root, files);
  const skillList = skills(root, files);
  const findings = [
    ...claudeShadowing(root, instructions),
    ...skillFindings(skillList),
    ...instructions.flatMap(path => instructionFindings(root, path, texts[path], packageList)),
  ];
  return {
    version: 1,
    root,
    instructionFiles: instructions.map(path => ({ path, lines: texts[path].split('\n').length, symlink: isLink(join(root, path)) })),
    skills: skillList,
    packages: packageList,
    ciCommands: ciCommands(root, files, Object.values(texts).join('\n')),
    findings,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'audit', root = '.'] = process.argv.slice(2);
  if (command !== 'audit') {
    console.error('usage: audit.mjs audit [repository-path]');
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(audit(root), null, 2)}\n`);
  } catch (error) {
    console.error(`audit failed: ${error.message}`);
    process.exit(1);
  }
}
