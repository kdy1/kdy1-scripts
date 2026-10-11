#!/usr/bin/env node
import { check, version, sha, readJson, cli } from './helper-common.mjs';
export function verifyPublication(input) {
  version(input); const { expected, observed } = input; const errors = [];
  check(expected && observed && Array.isArray(expected.layers) && expected.layers.length, 'Missing publication prefix');
  if (observed.complete !== true || observed.attachmentComplete !== true) errors.push('Incomplete PR/stack/attachment observations');
  if (expected.stackId !== observed.stackId) errors.push('Stack identity mismatch');
  const layers = observed.layers ?? [];
  if (layers.length !== expected.layers.length) errors.push('Prefix membership differs');
  const urls = new Set();
  expected.layers.forEach((layer, i) => {
    sha(layer.headSha); sha(layer.baseSha);
    check(Array.isArray(layer.closes) && typeof layer.body === 'string' && typeof layer.title === 'string', 'Missing expected publication content');
    check(layer.baseBranch === (i === 0 ? expected.baseBranch : expected.layers[i - 1].headBranch), 'Invalid expected base chain');
    if (i > 0) check(layer.baseSha === expected.layers[i - 1].headSha, 'Invalid expected base SHA chain');
    const actual = layers[i];
    if (!actual) { errors.push(`Missing layer ${i + 1}`); return; }
    for (const key of ['url', 'headRepository', 'headBranch', 'headSha', 'baseBranch', 'baseSha', 'title', 'body']) {
      if (typeof layer[key] !== 'string' || !layer[key] || layer[key] !== actual[key]) errors.push(`Layer ${i + 1}: ${key} mismatch`);
    }
    if (urls.has(actual.url)) errors.push('Duplicate PR identity'); urls.add(actual.url);
    if (actual.state !== 'OPEN' || actual.isDraft !== false) errors.push(`Layer ${i + 1}: expected open non-draft PR`);
    if (!(observed.attachments ?? []).includes(actual.url)) errors.push(`Layer ${i + 1}: missing attachment`);
    for (const issue of layer.closes) if (!actual.body?.split('\n').some(line => line.trim() === `Closes ${issue}`)) errors.push(`Layer ${i + 1}: missing standalone Closes ${issue}`);
  });
  return { version: 1, complete: errors.length === 0, status: errors.length ? 'blocked' : 'verified', publicationOnly: true, stackId: expected.stackId, errors, verifiedLayers: errors.length ? [] : structuredClone(expected.layers) };
}
cli(import.meta.url, 'verify-publication.mjs input.json', ([path]) => { check(path, 'Missing input file'); return verifyPublication(readJson(path)); });
