import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deviceResources, parseMeminfo } from './device-resources.mjs';

const script = fileURLToPath(new URL('./device-resources.mjs', import.meta.url));
const meminfo = 'MemTotal:       67108864 kB\nMemFree:         1048576 kB\nMemAvailable:   33554432 kB\n';

test('Linux memory uses MemAvailable, not MemFree', () => {
  const result = deviceResources({ platform: 'linux', cpuCount: 16, loadAverage: [6, 5, 4], meminfo });
  assert.equal(result.cpuCount, 16);
  assert.equal(result.idleCpuEstimate, 10);
  assert.equal(result.memory.availableGiB, 32);
  assert.equal(result.memory.totalGiB, 64);
  assert.match(result.memory.source, /MemAvailable/);
});

test('other platforms fall back to os memory and idle CPU never goes negative', () => {
  const result = deviceResources({ platform: 'darwin', cpuCount: 4, loadAverage: [9, 8, 7], totalBytes: 2 ** 34, freeBytes: 2 ** 32 });
  assert.equal(result.idleCpuEstimate, 0);
  assert.equal(result.memory.availableGiB, 4);
  assert.match(result.memory.source, /os\.freemem/);
});

test('invalid probes and meminfo fail', () => {
  assert.throws(() => parseMeminfo('MemTotal: 1 kB\n'), /MemAvailable/);
  assert.throws(() => deviceResources({ platform: 'darwin', cpuCount: 0 }), /CPU count/);
  assert.throws(() => deviceResources({ platform: 'darwin', cpuCount: 2, loadAverage: [1] }), /load average/);
});

test('CLI prints measured resources and rejects arguments', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, 1);
  assert.ok(parsed.cpuCount > 0 && parsed.memory.availableBytes > 0);
  const bad = spawnSync(process.execPath, [script, 'extra'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
});
