import { check } from './helper-common.mjs';

// Only absent fields default to Codex; malformed or unknown runtimes fail closed.
export function runtimeName(value = 'codex') {
  check(value === 'codex' || value === 'claude-code', 'Unknown batch runtime');
  return value;
}

export function ledgerRuntime(ledger) {
  return runtimeName(ledger.context?.runtime);
}

export function matchRuntime(value, expected) {
  const runtime = runtimeName(value);
  check(runtime === runtimeName(expected), 'Runtime differs from ledger');
  return runtime;
}
