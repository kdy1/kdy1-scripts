import { assert, parseOptions, readJSON, withSessionLock } from './common.mjs';
import { preflight } from './preflight.mjs';
import { initSession, loadSession, recordSession, verifySession } from './session.mjs';
import { publish } from './publish.mjs';
import { finishThreads } from './threads.mjs';
import { ciLogs } from './ci-logs.mjs';

export function workflowCommand(command, args) {
  const action = command === 'session' ? args.shift() : null;
  const allowed = {
    preflight: ['pr', 'json', 'help', 'stack-file'], session: ['file', 'pr', 'input', 'stack-file', 'json', 'help'],
    publish: ['session', 'json', 'help'], 'finish-threads': ['session', 'json', 'help'], 'ci-logs': ['session', 'output-dir', 'json', 'help'],
  };
  const o = parseOptions(args, allowed[command]);
  if (o.help) {
    process.stdout.write(`Usage:\n  repair-pr.mjs preflight [--pr <number-or-url>] [--stack-file <ownership.json>] [--json]\n  repair-pr.mjs session init --file <path> [--pr <number-or-url>] [--stack-file <ownership.json>]\n  repair-pr.mjs session record --file <path> --input <record.json>\n  repair-pr.mjs session verify --file <path>\n  repair-pr.mjs ci-logs --session <path> --output-dir <directory>\n  repair-pr.mjs publish --session <path>\n  repair-pr.mjs finish-threads --session <path>\nSee references/repair-session.md for record schemas and recovery.\n`); return;
  }
  let result;
  if (command === 'preflight') {
    result = preflight(o.pr, o['stack-file'] ? readJSON(o['stack-file']) : null);
    if (!result.ready) process.exitCode = 1;
  } else if (command === 'session') {
    assert(['init', 'record', 'verify'].includes(action), 'Expected session init, record, or verify');
    assert(o.file, 'Missing --file');
    if (action === 'verify') result = verifySession(loadSession(o.file));
    else result = withSessionLock(o.file, file => {
      if (action === 'init') return initSession(file, o.pr, o['stack-file']);
      assert(o.input, 'Missing --input'); return recordSession(file, readJSON(o.input));
    });
  } else {
    assert(o.session, 'Missing --session');
    if (command === 'ci-logs') { assert(o['output-dir'], 'Missing --output-dir'); result = ciLogs(o.session, o['output-dir']); if (!result.complete) process.exitCode = 1; }
    else result = withSessionLock(o.session, file => command === 'publish' ? publish(file) : finishThreads(file));
    if (result.complete === false) process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
