import { readFileSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { absolute, check, readJson, save } from './common.mjs';

// The Linear API key is stored once per workspace URL key:
// - macOS: the login Keychain (`security`).
// - Linux and other platforms: the Secret Service keyring (`secret-tool`, for example gnome-keyring or KWallet)
//   when one is running, otherwise a mode-0600 key file in the config directory.
// Only non-secret workspace bookkeeping is written to the config file.
export const SERVICE = 'kdy1-scripts.add-issue.linear';
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const TIMEOUT = 30000;

const configDir = env => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kdy1-scripts', 'add-issue');
export function configPath(env = process.env) { return join(configDir(env), 'linear.json'); }
export function keyFilePath(env = process.env) { return join(configDir(env), 'linear-keys.json'); }
export function readConfig(path = configPath()) { return existsSync(path) ? readJson(path) : { version: 1, default: null, workspaces: {} }; }

const spawn = (program, args, options) => spawnSync(program, args, options);
function exec(transport, program, args, input) {
  const r = transport(program, args, { input, encoding: 'utf8', timeout: TIMEOUT });
  return { ok: !r.error && r.status === 0, missing: r.error?.code === 'ENOENT', stdout: r.stdout ?? '', status: r.status };
}
function checkEntry(workspace, key) { check(KEY_PATTERN.test(key) && WORKSPACE_PATTERN.test(workspace), 'Unexpected Linear API key or workspace format'); }

export class Keychain {
  constructor({ transport = spawn, platform = process.platform } = {}) { this.transport = transport; this.platform = platform; this.source = 'keychain'; }
  available() { return this.platform === 'darwin'; }
  read(workspace) {
    if (!this.available()) return null;
    const r = exec(this.transport, 'security', ['find-generic-password', '-s', SERVICE, '-a', workspace, '-w']);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  }
  write(workspace, key) {
    check(this.available(), 'macOS Keychain is unavailable');
    checkEntry(workspace, key);
    // `security -i` reads the command from stdin, so the key never appears in argv.
    const r = exec(this.transport, 'security', ['-i'], `add-generic-password -U -s "${SERVICE}" -a "${workspace}" -l "Linear API key (${workspace})" -w "${key}"\n`);
    check(r.ok, 'Cannot store the Linear API key in the Keychain');
    check(this.read(workspace) === key, 'Keychain read-back of the Linear API key failed');
  }
  remove(workspace) {
    if (!this.available()) return false;
    return exec(this.transport, 'security', ['delete-generic-password', '-s', SERVICE, '-a', workspace]).ok;
  }
}

// Secret Service (freedesktop.org) keyring through `secret-tool` from libsecret.
// state() reads the default collection's Locked property first, so a lookup never
// starts an unlock prompt that a non-interactive agent cannot answer.
export class SecretService {
  constructor({ transport = spawn, env = process.env } = {}) { this.transport = transport; this.env = env; this.source = 'secret-service'; }
  state() {
    if (!this.env.DBUS_SESSION_BUS_ADDRESS) return 'absent';
    const r = exec(this.transport, 'busctl', ['--user', 'get-property', 'org.freedesktop.secrets', '/org/freedesktop/secrets/aliases/default', 'org.freedesktop.Secret.Collection', 'Locked']);
    if (!r.ok) return 'absent';
    const locked = r.stdout.trim();
    if (locked === 'b true') return 'locked';
    if (locked !== 'b false') return 'absent';
    return exec(this.transport, 'secret-tool', ['--help']).missing ? 'no-tool' : 'unlocked';
  }
  read(workspace) {
    const r = exec(this.transport, 'secret-tool', ['lookup', 'service', SERVICE, 'account', workspace]);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  }
  write(workspace, key) {
    checkEntry(workspace, key);
    // `secret-tool store` reads the secret from stdin, so the key never appears in argv.
    const r = exec(this.transport, 'secret-tool', ['store', `--label=Linear API key (${workspace})`, 'service', SERVICE, 'account', workspace], key);
    check(r.ok, 'Cannot store the Linear API key in the Secret Service keyring');
    check(this.read(workspace) === key, 'Keyring read-back of the Linear API key failed');
  }
  remove(workspace) { return exec(this.transport, 'secret-tool', ['clear', 'service', SERVICE, 'account', workspace]).ok; }
}

// Fallback for hosts without a keyring: a JSON map from workspace to key, mode 0600 in a 0700 directory.
// The key is not encrypted at rest, so reads refuse a file that other users could read or replace.
export class KeyFile {
  constructor({ path = keyFilePath(), uid = process.getuid?.() } = {}) { this.path = path; this.uid = uid; this.source = 'file'; }
  load() {
    let stat;
    try { stat = lstatSync(this.path); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    check(stat.isFile(), `Linear key file ${this.path} is not a regular file`);
    check((stat.mode & 0o077) === 0 && (this.uid === undefined || stat.uid === this.uid), `Linear key file ${this.path} must be owned by you with mode 600`);
    return readJson(this.path).keys ?? {};
  }
  read(workspace) { return this.load()[workspace] ?? null; }
  write(workspace, key) {
    checkEntry(workspace, key);
    const keys = this.load(); keys[workspace] = key;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    save(this.path, { version: 1, keys });
    check(this.read(workspace) === key, 'Key file read-back of the Linear API key failed');
  }
  remove(workspace) {
    const keys = this.load(); if (!(workspace in keys)) return false;
    delete keys[workspace];
    if (Object.keys(keys).length) save(this.path, { version: 1, keys }); else rmSync(this.path, { force: true });
    return true;
  }
}

const LOCKED = 'The Secret Service keyring is locked. Log in to the desktop session (or unlock the keyring), then repeat the command';
const NO_TOOL = 'A Secret Service keyring is running but secret-tool is missing. Install it (for example `sudo apt install libsecret-tools`), then repeat the command';

// One store for every platform. read() returns {token, source, locked}; write() returns the source used.
export class KeyStore {
  constructor({ platform = process.platform, env = process.env, transport = spawn, keychain, secretService, keyFile } = {}) {
    this.platform = platform;
    this.keychain = keychain ?? new Keychain({ transport, platform });
    this.secretService = secretService ?? new SecretService({ transport, env });
    this.keyFile = keyFile ?? new KeyFile({ path: keyFilePath(env) });
  }
  read(workspace) {
    if (this.platform === 'darwin') { const token = this.keychain.read(workspace); return { token, source: token ? 'keychain' : null, locked: false }; }
    const state = this.secretService.state();
    if (state === 'unlocked') { const token = this.secretService.read(workspace); if (token) return { token, source: 'secret-service', locked: false }; }
    const token = this.keyFile.read(workspace);
    if (token) return { token, source: 'file', locked: false };
    return { token: null, source: null, locked: state === 'locked' };
  }
  // Never downgrades to the plain file while a keyring exists: a locked keyring or a missing
  // secret-tool is reported so the human can fix it, instead of writing the key unencrypted.
  write(workspace, key) {
    if (this.platform === 'darwin') { this.keychain.write(workspace, key); return 'keychain'; }
    const state = this.secretService.state();
    check(state !== 'locked', LOCKED);
    check(state !== 'no-tool', NO_TOOL);
    if (state === 'absent') { this.keyFile.write(workspace, key); return 'file'; }
    this.secretService.write(workspace, key);
    this.keyFile.remove(workspace); // Drop an older plain-file copy once the keyring holds the key.
    return 'secret-service';
  }
  remove(workspace) {
    if (this.platform === 'darwin') return this.keychain.remove(workspace);
    const state = this.secretService.state();
    check(state !== 'locked', LOCKED);
    const fromKeyring = state === 'unlocked' && this.secretService.remove(workspace);
    return this.keyFile.remove(workspace) || fromKeyring;
  }
}

// Resolution order: LINEAR_API_KEY, then the stored key for the workspace
// (or the configured default workspace when none is named).
export function resolveToken(workspace, { env = process.env, store = new KeyStore({ env }), config = readConfig(configPath(env)) } = {}) {
  if (env.LINEAR_API_KEY?.trim()) return { token: env.LINEAR_API_KEY.trim(), source: 'env', workspace: workspace ?? null, locked: false };
  const selected = workspace ?? config.default;
  if (!selected) return { token: null, source: null, workspace: null, locked: false };
  return { ...store.read(selected), workspace: selected };
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
