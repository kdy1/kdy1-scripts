#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { check, readJson, result, save, outside, version } from './common.mjs';
import { images } from './payload.mjs';
import { Keychain, configPath, forgetWorkspace, readConfig, readKeyFile, rememberWorkspace, resolveToken } from './linear-auth.mjs';
import { Linear, collect, preflight, record, refresh, validateLinearPayload, verifyRecording } from './linear.mjs';

const USAGE = 'node linear-issue.mjs auth-status [workspace] | auth-store /absolute/key-file [--default] | auth-delete workspace | validate|collect|preflight|refresh|record|verify /absolute/input.json [/absolute/output.json]';
const authRequired = (workspace, reason) => result('blocked', [reason], { authRequired: true, workspace: workspace ?? null, keyUrl: 'https://linear.app/settings/account/security' });

function workspaceOf(command, input) {
  return command === 'collect' ? input.target?.workspace : (input.payload ?? input.previousPayload)?.target?.workspace;
}

export async function dispatch(command, input, deps = {}) {
  version(input);
  if (command === 'validate') {
    const { payloadHash } = validateLinearPayload(input.payload);
    const checks = input.payload.candidates.map(c => ({ candidateId: c.id, ...images(c.images.filter(i => i.destination !== 'existing')) }));
    return result(checks.every(x => x.complete) ? 'verified' : 'blocked', checks.flatMap(x => x.errors), { payloadHash });
  }
  const workspace = workspaceOf(command, input);
  const { token } = resolveToken(workspace, deps);
  if (!token) return authRequired(workspace, `No Linear API key stored for workspace ${workspace}`);
  const client = deps.client ?? new Linear({ token, fetch: deps.fetch });
  try {
    if (command === 'collect') return await collect(input, client);
    if (command === 'record') return await record(input, client);
    if (command === 'refresh') return await refresh(input, client);
    if (command === 'preflight' || command === 'verify') {
      validateLinearPayload(input.payload);
      const c = input.payload.candidates.find(x => x.id === input.candidateId); check(c, 'Unknown candidate');
      return command === 'preflight' ? await preflight(input.payload, c, client, input.context, input.state) : await verifyRecording(input.payload, c, client, input.state);
    }
  } catch (e) {
    if (e.kind === 'auth') return authRequired(workspace, e.message);
    throw e;
  }
  throw new Error('Unknown command');
}

export async function auth(command, args, deps = {}) {
  const keychain = deps.keychain ?? new Keychain();
  const path = deps.configPath ?? configPath();
  if (command === 'auth-store') {
    const [file, flag] = args; check(file && (!flag || flag === '--default'), USAGE);
    const token = readKeyFile(file);
    let identity;
    try { identity = await new Linear({ token, fetch: deps.fetch }).identity(); }
    catch (e) { return result('blocked', [e.kind === 'auth' ? 'Linear rejected this API key' : e.message], { stored: false }); }
    const workspace = identity.organization.urlKey;
    keychain.write(workspace, token);
    const info = { workspace, organization: identity.organization.name, viewer: { id: identity.viewer.id, name: identity.viewer.name, email: identity.viewer.email } };
    const config = rememberWorkspace(info, { makeDefault: flag === '--default', path });
    return result('verified', [], { stored: true, ...info, default: config.default });
  }
  if (command === 'auth-delete') {
    const [workspace] = args; check(workspace, USAGE);
    const removed = keychain.remove(workspace); forgetWorkspace(workspace, path);
    return result('verified', [], { removed, workspace });
  }
  // auth-status: report where the key comes from and whom it authenticates. Never prints the key.
  const config = readConfig(path);
  const { token, source, workspace } = resolveToken(args[0], { env: deps.env ?? process.env, keychain, config });
  if (!token) return authRequired(workspace, workspace ? `No Linear API key stored for workspace ${workspace}` : 'No Linear workspace stored yet');
  try {
    const client = new Linear({ token, fetch: deps.fetch });
    const identity = await client.identity();
    if (workspace && identity.organization.urlKey !== workspace) return authRequired(workspace, `The ${source} key belongs to workspace ${identity.organization.urlKey}`);
    const teams = await client.teams();
    return result('verified', [], { source, workspace: identity.organization.urlKey, organization: identity.organization.name, viewer: identity.viewer, teams, stored: Object.keys(config.workspaces), default: config.default });
  } catch (e) {
    if (e.kind === 'auth') return authRequired(workspace, `${e.message} (${source})`);
    throw e;
  }
}

export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help') return { help: USAGE };
  if (command.startsWith('auth-')) return auth(command, rest);
  const [path, output] = rest;
  check(path && rest.length <= 2, 'Expected command and absolute JSON input path');
  const input = readJson(path);
  if (output) {
    const payload = input.payload ?? input.previousPayload;
    for (const repo of payload?.candidates?.map(c => c.workspace.baseline.repo) ?? []) outside(output, repo);
  }
  const value = await dispatch(command, input);
  if (!output) return value;
  save(output, value);
  return { ...result(value.status ?? 'verified', value.errors ?? []), output, ...(value.payloadHash ? { payloadHash: value.payloadHash } : {}), ...(value.authRequired ? { authRequired: true } : {}) };
}

// import.meta.url is the real path; argv[1] may run through a symlinked skill directory.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (value.complete === false) process.exitCode = value.status === 'uncertain' ? 3 : 2;
  }, e => { process.stdout.write(`${JSON.stringify(result('failed', [e.message]))}\n`); process.exitCode = 1; });
}
