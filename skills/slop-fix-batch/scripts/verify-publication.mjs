#!/usr/bin/env node
import { check, version, sha, readJson, cli } from './helper-common.mjs';
import { runtimeName, matchRuntime } from './runtime.mjs';
import { closesReference, isLinearReference, linksLinearIssue, referenceLine } from './issue-refs.mjs';
export function verifyPublication(input, expectedRuntime) {
  version(input); const { expected, observed } = input; const errors = [];
  const runtime = runtimeName(input.runtime);
  if (expectedRuntime !== undefined) matchRuntime(runtime, expectedRuntime);
  check(expected && observed && Array.isArray(expected.layers) && expected.layers.length, 'Missing publication prefix');
  if (observed.complete !== true) errors.push('Incomplete PR/stack observations');
  if (runtime === 'codex' && observed.attachmentComplete !== true) errors.push('Incomplete attachment observations');
  if (runtime === 'claude-code' && (observed.attachmentStatus !== 'not-applicable' || observed.attachmentComplete !== undefined || !Array.isArray(observed.attachments) || observed.attachments.length)) errors.push('Claude Code requires explicit not-applicable attachment status and no attached PR claims');
  if (expected.stackId !== observed.stackId) errors.push('Stack identity mismatch');
  const layers = observed.layers ?? [];
  if (layers.length !== expected.layers.length) errors.push('Prefix membership differs');
  const urls = new Set();
  expected.layers.forEach((layer, i) => {
    sha(layer.headSha); sha(layer.baseSha);
    check(Array.isArray(layer.closes) && typeof layer.body === 'string' && typeof layer.title === 'string', 'Missing expected publication content');
    check(layer.refs === undefined || Array.isArray(layer.refs), 'Invalid expected refs');
    check(!(layer.refs ?? []).some(issue => layer.closes.includes(issue)), 'Conflicting issue references');
    check(layer.baseBranch === (i === 0 ? expected.baseBranch : expected.layers[i - 1].headBranch), 'Invalid expected base chain');
    if (i > 0) check(layer.baseSha === expected.layers[i - 1].headSha, 'Invalid expected base SHA chain');
    const actual = layers[i];
    if (!actual) { errors.push(`Missing layer ${i + 1}`); return; }
    for (const key of ['url', 'headRepository', 'headBranch', 'headSha', 'baseBranch', 'baseSha', 'title', 'body']) {
      if (typeof layer[key] !== 'string' || !layer[key] || layer[key] !== actual[key]) errors.push(`Layer ${i + 1}: ${key} mismatch`);
    }
    if (urls.has(actual.url)) errors.push('Duplicate PR identity'); urls.add(actual.url);
    if (actual.state !== 'OPEN' || actual.isDraft !== false) errors.push(`Layer ${i + 1}: expected open non-draft PR`);
    if (runtime === 'codex' && !(observed.attachments ?? []).includes(actual.url)) errors.push(`Layer ${i + 1}: missing attachment`);
    const hasLine = line => actual.body?.split('\n').some(x => x.trim() === line);
    for (const issue of layer.refs ?? []) {
      if (!hasLine(referenceLine('refs', issue))) errors.push(`Layer ${i + 1}: missing standalone ${referenceLine('refs', issue)}`);
      if (closesReference(actual.body, issue)) errors.push(`Layer ${i + 1}: premature closure of ${issue}`);
      if (isLinearReference(issue) && (linksLinearIssue(actual.title, issue) || linksLinearIssue(actual.headBranch, issue))) errors.push(`Layer ${i + 1}: title or branch links ${issue} for closure`);
    }
    for (const issue of layer.closes) if (!hasLine(referenceLine('closes', issue))) errors.push(`Layer ${i + 1}: missing standalone Closes ${issue}`);
  });
  return { version: 1, runtime, attachmentStatus: runtime === 'claude-code' ? 'not-applicable' : (errors.length ? 'unverified' : 'verified'), complete: errors.length === 0, status: errors.length ? 'blocked' : 'verified', publicationOnly: true, stackId: expected.stackId, errors, verifiedLayers: errors.length ? [] : structuredClone(expected.layers) };
}
cli(import.meta.url, 'verify-publication.mjs input.json', ([path]) => { check(path, 'Missing input file'); return verifyPublication(readJson(path)); });
