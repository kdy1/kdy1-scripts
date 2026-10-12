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

export function workerSettings(role, runtime = 'codex', complexity = 'standard') {
  runtimeName(runtime);
  check(settings.has(role), 'Unknown worker role');
  check(['simple', 'standard'].includes(complexity), 'Unknown worker complexity');
  const [model, defaultEffort] = settings.get(role);
  const reasoning_effort = complexity === 'simple' && ['investigation', 'implementation'].includes(role) ? 'medium' : defaultEffort;
  if (runtime === 'claude-code') return { subagent_type: 'general-purpose', model: 'sonnet', effort: reasoning_effort };
  return { model, reasoning_effort, fork_turns: 'none' };
}

cli(import.meta.url, 'worker-settings.mjs <role> [--runtime codex|claude-code] [--complexity simple|standard]', args => {
  check(args.length > 0 && args.length % 2 === 1, 'Expected role and complete option pairs');
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    check(['--runtime', '--complexity'].includes(key) && !Object.hasOwn(options, key), 'Unknown or duplicate worker option');
    options[key] = args[i + 1];
  }
  return workerSettings(args[0], options['--runtime'], options['--complexity']);
});
