#!/usr/bin/env node
import { check, cli } from './helper-common.mjs';
import { runtimeName } from './runtime.mjs';

const settings = new Map([
  ['investigation', ['gpt-6.1-sol', 'high']],
  ['preparation', ['gpt-6.1-sol', 'medium']],
  ['implementation', ['gpt-6.1-sol', 'high']],
  ['stack-execution', ['gpt-6.1-sol', 'medium']],
  ['maintenance', ['gpt-6.1-sol', 'medium']],
  ['inventory', ['gpt-6-luna', 'low']],
  ['repair', ['gpt-6-luna', 'high']],
  ['publication', ['gpt-6.1-sol', 'medium']],
]);

export function workerSettings(role, runtime = 'codex') {
  runtimeName(runtime);
  check(settings.has(role), 'Unknown worker role');
  const [model, reasoning_effort] = settings.get(role);
  if (runtime === 'claude-code') return { subagent_type: 'general-purpose', model: 'sonnet', effort: reasoning_effort };
  return { model, reasoning_effort, fork_turns: 'none' };
}

cli(import.meta.url, 'worker-settings.mjs <role> [--runtime codex|claude-code]', args => {
  check(args.length === 1 || (args.length === 3 && args[1] === '--runtime'), 'Expected one worker role and optional --runtime');
  return workerSettings(args[0], args[2]);
});
