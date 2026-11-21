#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { check, cli } from './helper-common.mjs';

// Reports measured device resources. The coordinator decides the worker count from them.
export function parseMeminfo(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) fields[match[1]] = Number(match[2]) * 1024;
  }
  check(Number.isSafeInteger(fields.MemTotal) && Number.isSafeInteger(fields.MemAvailable), 'Missing MemTotal or MemAvailable');
  return { totalBytes: fields.MemTotal, availableBytes: fields.MemAvailable, source: '/proc/meminfo MemAvailable' };
}

function readMeminfo() {
  try { return readFileSync('/proc/meminfo', 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function deviceResources(probe = {}) {
  const platform = probe.platform ?? process.platform;
  const cpuCount = probe.cpuCount ?? os.availableParallelism();
  const loadAverage = probe.loadAverage ?? os.loadavg();
  check(Number.isSafeInteger(cpuCount) && cpuCount > 0, 'Invalid CPU count');
  check(Array.isArray(loadAverage) && loadAverage.length === 3 && loadAverage.every(n => Number.isFinite(n) && n >= 0), 'Invalid load average');
  const meminfo = platform === 'linux' ? (probe.meminfo !== undefined ? probe.meminfo : readMeminfo()) : null;
  const memory = meminfo
    ? parseMeminfo(meminfo)
    : { totalBytes: probe.totalBytes ?? os.totalmem(), availableBytes: probe.freeBytes ?? os.freemem(), source: 'os.freemem (underestimates reclaimable cache)' };
  const gib = n => Math.round((n / 2 ** 30) * 10) / 10;
  return {
    version: 1,
    platform,
    cpuCount,
    loadAverage: loadAverage.map(n => Math.round(n * 100) / 100),
    idleCpuEstimate: Math.max(0, Math.round((cpuCount - loadAverage[0]) * 10) / 10),
    memory: { ...memory, totalGiB: gib(memory.totalBytes), availableGiB: gib(memory.availableBytes) },
  };
}

cli(import.meta.url, 'device-resources.mjs', args => {
  check(args.length === 0, 'device-resources.mjs takes no arguments');
  return deviceResources();
});
