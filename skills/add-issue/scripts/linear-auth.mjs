import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { absolute, check, readJson, save } from './common.mjs';

// The Linear API key lives in the login Keychain, one item per workspace URL key.
// Only non-secret workspace bookkeeping is written to the config file.
export const SERVICE = 'kdy1-scripts.add-issue.linear';
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export function configPath(env = process.env) { return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kdy1-scripts', 'add-issue', 'linear.json'); }
export function readConfig(path = configPath()) { return existsSync(path) ? readJson(path) : { version: 1, default: null, workspaces: {} }; }

function security(args, input, transport) {
  const r = transport('security', args, { input, encoding: 'utf8', timeout: 30000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', status: r.status };
}
const spawn = (program, args, options) => spawnSync(program, args, options);

export class Keychain {
  constructor({ transport = spawn, platform = process.platform } = {}) { this.transport = transport; this.platform = platform; }
  available() { return this.platform === 'darwin'; }
  read(workspace) {
    if (!this.available()) return null;
    const r = security(['find-generic-password', '-s', SERVICE, '-a', workspace, '-w'], undefined, this.transport);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  }
  write(workspace, key) {
    check(this.available(), 'macOS Keychain is unavailable; set LINEAR_API_KEY for this session instead');
    check(KEY_PATTERN.test(key) && WORKSPACE_PATTERN.test(workspace), 'Unexpected Linear API key or workspace format');
    // `security -i` reads the command from stdin, so the key never appears in argv.
    const r = security(['-i'], `add-generic-password -U -s "${SERVICE}" -a "${workspace}" -l "Linear API key (${workspace})" -w "${key}"\n`, this.transport);
    check(r.ok, 'Cannot store the Linear API key in the Keychain');
    check(this.read(workspace) === key, 'Keychain read-back of the Linear API key failed');
  }
  remove(workspace) {
    if (!this.available()) return false;
    return security(['delete-generic-password', '-s', SERVICE, '-a', workspace], undefined, this.transport).ok;
  }
}

// Resolution order: LINEAR_API_KEY, then the Keychain item for the workspace
// (or the configured default workspace when none is named).
export function resolveToken(workspace, { env = process.env, keychain = new Keychain(), config = readConfig(configPath(env)) } = {}) {
  if (env.LINEAR_API_KEY?.trim()) return { token: env.LINEAR_API_KEY.trim(), source: 'env', workspace: workspace ?? null };
  const selected = workspace ?? config.default;
  if (!selected) return { token: null, source: null, workspace: null };
  const token = keychain.read(selected);
  return { token, source: token ? 'keychain' : null, workspace: selected };
}

export function readKeyFile(path) {
  const key = readFileSync(absolute(path), 'utf8').trim();
  check(KEY_PATTERN.test(key), 'The supplied value is not a Linear personal API key');
  return key;
}

export function rememberWorkspace(info, { makeDefault = false, path = configPath() } = {}) {
  const config = readConfig(path);
  config.workspaces[info.workspace] = { organization: info.organization, viewerId: info.viewer.id, viewer: info.viewer.email, storedAt: new Date().toISOString() };
  if (makeDefault || !config.default || !config.workspaces[config.default]) config.default = info.workspace;
  save(path, config);
  return config;
}

export function forgetWorkspace(workspace, path = configPath()) {
  const config = readConfig(path);
  delete config.workspaces[workspace];
  if (config.default === workspace) config.default = Object.keys(config.workspaces)[0] ?? null;
  save(path, config);
  return config;
}
