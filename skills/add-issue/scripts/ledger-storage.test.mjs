import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hash, save } from './common.mjs';
import { readLedger, resolveHistoryPayload, saveLedger } from './ledger-storage.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-ledger-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json'), payload = { version: 1, evidence: 'source\n'.repeat(200000), candidates: ['alpha'] };
  const ledger = { version: 1, payloadHash: hash({ current: true }), candidates: { alpha: { ops: { create: { status: 'uncertain', receipt: null, startedAt: '2026-10-12T00:00:00Z' } }, creationAttempts: [{ receipt: 'retained' }], attachments: { image: 'native-url' } } }, history: [1, 2].map(i => ({ previousHash: hash(payload), payloadHash: hash({ i }), previousPayload: payload, review: { reason: `review ${i}` }, provenance: 'trusted' })) };
  save(path, ledger);
  return { path, payload, ledger, original: readFileSync(path) };
}

test('migrates legacy history losslessly with identical receipts and hashes', t => {
  const s = fixture(t), loaded = readLedger(s.path);
  saveLedger(s.path, loaded);
  const compact = readLedger(s.path);
  assert.deepEqual(compact.candidates, s.ledger.candidates);
  assert.equal(compact.payloadHash, s.ledger.payloadHash);
  assert.ok(statSync(s.path).size < s.original.length / 10);
  for (let i = 0; i < compact.history.length; i++) {
    const { previousPayloadRef, ...entry } = compact.history[i];
    assert.deepEqual({ ...entry, previousPayload: resolveHistoryPayload(s.path, compact.history[i]) }, s.ledger.history[i]);
    assert.equal(previousPayloadRef.payloadHash, hash(s.payload));
  }
  const files = readdirSync(`${s.path}.objects`);
  assert.equal(files.filter(f => !f.startsWith('legacy-')).length, 1);
  assert.deepEqual(readFileSync(join(`${s.path}.objects`, `legacy-${hash(s.original)}.json`)), s.original);
  for (const f of files) assert.equal(statSync(join(`${s.path}.objects`, f)).mode & 0o777, 0o600);
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${s.path}.objects`).mode & 0o777, 0o700);
  const bytes = readFileSync(s.path); saveLedger(s.path, compact);
  assert.deepEqual(readFileSync(s.path), bytes);
  assert.equal(readdirSync(`${s.path}.objects`).length, files.length);
});

test('failed migration keeps original ledger and caller history intact', t => {
  const s = fixture(t), loaded = readLedger(s.path);
  assert.throws(() => saveLedger(s.path, loaded, { beforeCommit: () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.deepEqual(readFileSync(s.path), s.original);
  assert.deepEqual(loaded, s.ledger);
  assert.equal(readdirSync(`${s.path}.objects`).some(f => f.endsWith('.tmp')), false);
  saveLedger(s.path, loaded); assert.deepEqual(resolveHistoryPayload(s.path, readLedger(s.path).history[0]), s.payload);
});

test('missing and corrupt history objects block ledger use', t => {
  const s = fixture(t); saveLedger(s.path, readLedger(s.path));
  const compact = readLedger(s.path), ref = compact.history[0].previousPayloadRef, target = join(`${s.path}.objects`, ref.file), original = readFileSync(target);
  rmSync(target); assert.throws(() => readLedger(s.path), /Missing ledger payload object/);
  writeFileSync(target, 'tampered'); assert.throws(() => readLedger(s.path), /Corrupt ledger payload object/);
  writeFileSync(target, original); assert.deepEqual(resolveHistoryPayload(s.path, readLedger(s.path).history[0]), s.payload);
  compact.history[0].previousPayloadRef.file = '../outside.json'; save(s.path, compact);
  assert.throws(() => readLedger(s.path), /Invalid ledger object path/);
});

test('canonical mismatch blocks migration without replacing legacy evidence', t => {
  const s = fixture(t), ledger = readLedger(s.path); ledger.history[0].previousHash = hash('wrong');
  assert.throws(() => saveLedger(s.path, ledger), /Legacy history payload hash mismatch/);
  assert.deepEqual(readFileSync(s.path), s.original);
});

test('legacy byte archive is referenced and its corruption blocks recording', t => {
  const s = fixture(t); saveLedger(s.path, readLedger(s.path));
  const ledger = readLedger(s.path), ref = ledger.legacyArchives[0], target = join(`${s.path}.objects`, ref.file);
  writeFileSync(target, 'lost evidence');
  assert.throws(() => readLedger(s.path), /Corrupt legacy ledger archive/);
  const bytes = readFileSync(s.path);
  assert.throws(() => saveLedger(s.path, ledger), /Corrupt legacy ledger archive/);
  assert.deepEqual(readFileSync(s.path), bytes);
});

test('cached validation detects same-size object changes before save or read', t => {
  const s = fixture(t); saveLedger(s.path, readLedger(s.path));
  const ledger = readLedger(s.path), ref = ledger.history[0].previousPayloadRef, target = join(`${s.path}.objects`, ref.file);
  const bytes = readFileSync(target), modified = Buffer.from(bytes);
  modified[modified.indexOf(Buffer.from('source'))] = 'S'.charCodeAt(0);
  writeFileSync(target, modified);
  assert.equal(statSync(target).size, bytes.length);
  assert.throws(() => saveLedger(s.path, ledger), /Corrupt ledger payload object/);
  assert.throws(() => readLedger(s.path), /Corrupt ledger payload object/);
  assert.throws(() => resolveHistoryPayload(s.path, ledger.history[0]), /Corrupt ledger payload object/);
  writeFileSync(target, bytes);
  assert.deepEqual(resolveHistoryPayload(s.path, readLedger(s.path).history[0]), s.payload);
});
