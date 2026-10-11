#!/usr/bin/env node
import { check, cli } from './helper-common.mjs';

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

export function workerSettings(role) {
  check(settings.has(role), 'Unknown worker role');
  const [model, reasoning_effort] = settings.get(role);
  return { model, reasoning_effort, fork_turns: 'none' };
}

cli(import.meta.url, 'worker-settings.mjs <role>', args => {
  check(args.length === 1, 'Expected exactly one worker role');
  return workerSettings(args[0]);
});
