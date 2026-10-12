import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { absolute, check, hash, readJson, save, version, outside, lock, result } from './common.mjs';
import { validatePayload, executionGate } from './payload.mjs';

// Refresh history retains complete payloads, but repeated full inline snapshots
// can exceed V8's string limit before an operation receipt can be journaled.
// Keep immutable payload objects beside the original private ledger instead.
const objectDir = path => `${absolute(path)}.objects`;
const legacyLedgers = new WeakSet();
const validatedObjects = new Map();
const digestPattern = /^[a-f0-9]{64}$/;
function fileHash(path) {
  const h = createHash('sha256'), fd = openSync(path, 'r'), chunk = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, count)); }
  finally { closeSync(fd); }
  return h.digest('hex');
}
function syncFile(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function installObject(path, destination, bytes) {
  if (existsSync(destination)) { check(fileHash(destination) === hash(bytes), 'Corrupt immutable ledger object'); return; }
  mkdirSync(objectDir(path), { recursive: true, mode: 0o700 });
  chmodSync(objectDir(path), 0o700);
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); syncFile(temp);
    // Ledger callers hold the same existing lock; objects are never replaced.
    renameSync(temp, destination);
  } finally { rmSync(temp, { force: true }); }
}
function verifyObject(target, byteHash, payloadHash = null, materialize = false) {
  check(existsSync(target), payloadHash ? 'Missing ledger payload object' : 'Missing legacy ledger archive');
  const info = lstatSync(target, { bigint: true });
  check(info.isFile(), payloadHash ? 'Missing ledger payload object' : 'Missing legacy ledger archive');
  const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(':');
  const key = `${target}:${byteHash}:${payloadHash ?? ''}`;
  let payload;
  if (validatedObjects.get(key) !== fingerprint) {
    check(fileHash(target) === byteHash, payloadHash ? 'Corrupt ledger payload object' : 'Corrupt legacy ledger archive');
    if (payloadHash) {
      payload = readJson(target);
      check(hash(payload) === payloadHash, 'Ledger payload canonical hash mismatch');
    }
    // Retain only file identity, never the large parsed payload. Any replacement
    // or metadata/content change requires complete validation again.
    validatedObjects.set(key, fingerprint);
  }
  return materialize ? payload ?? readJson(target) : undefined;
}
function verifyHistoryPayload(path, entry, materialize = false) {
  if (Object.hasOwn(entry, 'previousPayload')) {
    check(hash(entry.previousPayload) === entry.previousHash, 'Legacy history payload hash mismatch');
    return materialize ? entry.previousPayload : undefined;
  }
  const ref = entry.previousPayloadRef;
  check(ref?.version === 1 && digestPattern.test(ref.sha256) && digestPattern.test(ref.payloadHash), 'Invalid ledger payload reference');
  check(ref.payloadHash === entry.previousHash, 'Ledger reference does not match history hash');
  check(ref.file === `${ref.sha256}.json`, 'Invalid ledger object path');
  return verifyObject(join(objectDir(path), ref.file), ref.sha256, ref.payloadHash, materialize);
}
export function resolveHistoryPayload(path, entry) { return verifyHistoryPayload(path, entry, true); }
export function readLedger(path) {
  const ledger = readJson(path); version(ledger);
  for (const entry of ledger.history ?? []) verifyHistoryPayload(path, entry);
  if ((ledger.history ?? []).some(e => Object.hasOwn(e, 'previousPayload'))) legacyLedgers.add(ledger);
  for (const ref of ledger.legacyArchives ?? []) verifyLegacyArchive(path, ref);
  return ledger;
}
function verifyLegacyArchive(path, ref) {
  check(ref?.version === 1 && digestPattern.test(ref.sha256) && ref.file === `legacy-${ref.sha256}.json`, 'Invalid legacy archive reference');
  verifyObject(join(objectDir(path), ref.file), ref.sha256);
}
export function saveLedger(path, ledger, { beforeCommit = () => {} } = {}) {
  absolute(path); version(ledger);
  // Build a new manifest without altering the caller's evidence if preparation
  // fails. Successfully installed objects remain harmless retained evidence.
  const history = (ledger.history ?? []).map(entry => {
    if (!Object.hasOwn(entry, 'previousPayload')) { verifyHistoryPayload(path, entry); return entry; }
    const payloadHash = hash(entry.previousPayload);
    check(payloadHash === entry.previousHash, 'Legacy history payload hash mismatch');
    const bytes = `${JSON.stringify(entry.previousPayload)}\n`, sha256 = hash(bytes);
    installObject(path, join(objectDir(path), `${sha256}.json`), bytes);
    const { previousPayload, ...rest } = entry;
    return { ...rest, previousPayloadRef: { version: 1, file: `${sha256}.json`, sha256, payloadHash } };
  });
  // Preserve the exact original bytes once when migrating a legacy ledger.
  // Copy avoids turning a near-limit ledger into another giant JS string.
  const archives = [...(ledger.legacyArchives ?? [])];
  for (const ref of archives) verifyLegacyArchive(path, ref);
  if (existsSync(path) && legacyLedgers.has(ledger)) {
    const digest = fileHash(path), destination = join(objectDir(path), `legacy-${digest}.json`);
    if (existsSync(destination)) check(fileHash(destination) === digest, 'Corrupt legacy ledger archive');
    else {
      const temp = `${destination}.${randomUUID()}.tmp`;
      try { copyFileSync(path, temp); chmodSync(temp, 0o600); syncFile(temp); check(fileHash(temp) === digest, 'Legacy ledger changed during migration'); renameSync(temp, destination); }
      finally { rmSync(temp, { force: true }); }
    }
    if (!archives.some(ref => ref.sha256 === digest)) archives.push({ version: 1, file: `legacy-${digest}.json`, sha256: digest });
  }
  const compact = { ...ledger, ...(ledger.history ? { history } : {}), ...(archives.length ? { legacyArchives: archives } : {}) };
  beforeCommit(compact);
  save(path, compact);
  if (ledger.history) ledger.history = history;
  if (archives.length) ledger.legacyArchives = archives;
  legacyLedgers.delete(ledger);
}

export function migrateLedger(input) {
  version(input); validatePayload(input.payload);
  const gate = executionGate(input.payload, input.context); if (!gate.complete) return gate;
  for (const c of input.payload.candidates) outside(input.statePath, c.workspace.baseline.repo);
  const release = lock(input.statePath);
  if (!release) return result('blocked', ['Recording ledger is locked']);
  try {
    const ledger = readLedger(input.statePath), payloadHash = hash(input.payload);
    check(ledger.payloadHash === payloadHash, 'Ledger belongs to another payload');
    const candidateHash = hash(ledger.candidates);
    const historyHashes = (ledger.history ?? []).map(entry => entry.previousHash);
    saveLedger(input.statePath, ledger);
    const verified = readLedger(input.statePath);
    check(verified.payloadHash === payloadHash && hash(verified.candidates) === candidateHash, 'Ledger migration changed recording state');
    check(hash((verified.history ?? []).map(entry => entry.previousHash)) === hash(historyHashes), 'Ledger migration changed history');
    return result('verified', [], { payloadHash, candidatesPreserved: true, historyEntries: historyHashes.length, legacyArchives: verified.legacyArchives ?? [] });
  } finally { release(); }
}
