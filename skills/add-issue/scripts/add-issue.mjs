#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { check, readJson, result, save, outside, version } from './common.mjs';
import { snapshot, compare } from './workspace.mjs';
import { validatePayload, images } from './payload.mjs';
import { collect, GitHub } from './github.mjs';
import { preflight } from './preflight.mjs';
import { verifyRecording } from './verify-recording.mjs';
import { record } from './record.mjs';
import { refresh } from './refresh.mjs';
import { recoverCreate } from './recover-create.mjs';

export function dispatch(command, input) {
  version(input);
  if (command === 'snapshot') return result('verified', [], { baseline: snapshot(input.repo, input) });
  if (command === 'compare') return compare(input.baseline);
  if (command === 'validate') { const p = input.payload; const valid = validatePayload(p); const checks = p.candidates.map(c => ({ candidateId: c.id, ...images(c.images) })); return result(checks.every(x => x.complete) ? 'verified' : 'blocked', checks.flatMap(x => x.errors), { payloadHash: valid.payloadHash }); }
  if (command === 'images') return images(input.images);
  if (command === 'collect') return collect(input);
  if (command === 'record') return record(input);
  if (command === 'recover-create') return recoverCreate(input);
  if (command === 'refresh') return refresh(input);
  if (command === 'preflight' || command === 'verify') {
    validatePayload(input.payload);
    const c = input.payload.candidates.find(x => x.id === input.candidateId); check(c, 'Unknown candidate');
    const client = new GitHub(input.payload.target);
    return command === 'preflight' ? preflight(input.payload, c, client, input.context, input.state) : verifyRecording(input.payload, c, client, input.state, input.omissions);
  }
  throw new Error('Unknown command');
}
export function main(args) {
  const [command, path, output] = args;
  if (command === '--help') return { help: 'node add-issue.mjs snapshot|compare|validate|images|collect|preflight|refresh|recover-create|record|verify /absolute/input.json [/absolute/output.json]' };
  check(command && path && args.length <= 3, 'Expected command and absolute JSON input path');
  const input = readJson(path);
  if (output) {
    const repos = input.payload?.candidates?.map(c => c.workspace.baseline.repo) ?? [input.repo ?? input.baseline?.repo].filter(Boolean);
    for (const repo of repos) outside(output, repo);
  }
  const value = dispatch(command, input);
  if (output) { save(output, value); return { ...result(value.status ?? 'verified', value.errors ?? []), output, ...(value.payloadHash ? { payloadHash: value.payloadHash } : {}), ...(value.baseline ? { baselineRef: value.baseline.ref } : {}) }; }
  return value;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const value = main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); if (value.complete === false) process.exitCode = value.status === 'uncertain' ? 3 : 2; }
  catch (e) { process.stdout.write(`${JSON.stringify(result('failed', [e.message]))}\n`); process.exitCode = 1; }
}
