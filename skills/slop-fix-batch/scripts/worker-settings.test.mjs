import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerSettings } from './worker-settings.mjs';

const script = fileURLToPath(new URL('./worker-settings.mjs', import.meta.url));
const expected = {
  investigation: ['gpt-6.1-sol', 'high'],
  preparation: ['gpt-6.1-sol', 'medium'],
  implementation: ['gpt-6.1-sol', 'high'],
  'stack-execution': ['gpt-6.1-sol', 'medium'],
  maintenance: ['gpt-6.1-sol', 'medium'],
  inventory: ['gpt-6-luna', 'low'],
  repair: ['gpt-6-luna', 'high'],
  publication: ['gpt-6.1-sol', 'medium'],
};

test('every role exposes its approved spawn arguments through the function and CLI', () => {
  for (const [role, [model, reasoning_effort]] of Object.entries(expected)) {
    const settings = { model, reasoning_effort, fork_turns: 'none' };
    assert.deepEqual(workerSettings(role), settings);
    const result = spawnSync(process.execPath, [script, role], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), settings);
    workerSettings(role).model = 'changed';
    assert.deepEqual(workerSettings(role), settings);
  }
});

test('invalid roles and CLI arguments fail without emitting usable settings', () => {
  for (const role of ['unknown', 'toString', '__proto__', undefined]) {
    assert.throws(() => workerSettings(role), /Unknown worker role/);
  }
  for (const args of [[], ['unknown'], ['repair', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length);
  }
});

test('Claude roles use Sonnet with native Agent settings through the function and CLI', () => {
  for (const [role, [, effort]] of Object.entries(expected)) {
    const settings = { subagent_type: 'general-purpose', model: 'sonnet', effort };
    assert.deepEqual(workerSettings(role, 'claude-code'), settings);
    const result = spawnSync(process.execPath, [script, role, '--runtime', 'claude-code'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), settings);
    assert.deepEqual(workerSettings(role, 'codex'), workerSettings(role));
  }
});

test('invalid runtimes and incomplete options cannot silently select Codex', () => {
  for (const runtime of ['unknown', '', null, {}, 'toString']) assert.throws(() => workerSettings('repair', runtime), /runtime/);
  for (const args of [['repair', '--runtime'], ['repair', '--runtime', 'unknown'], ['repair', '--other', 'codex'], ['repair', '--runtime', 'claude-code', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
