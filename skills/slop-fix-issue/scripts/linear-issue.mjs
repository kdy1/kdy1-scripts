#!/usr/bin/env node
// Linear operations for one $slop-fix-issue run. Reading, selection, and closure reuse the
// $slop-fix-batch Linear helper, which reuses the $add-issue Linear client and stored API key.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, cli, readJson, save } from '../../slop-fix-batch/scripts/helper-common.mjs';
import { run as batchLinear } from '../../slop-fix-batch/scripts/linear-issues.mjs';
import { closesReference, linksLinearIssue, referenceLine } from '../../slop-fix-batch/scripts/issue-refs.mjs';

const USAGE = [
  'linear-issue.mjs read <linear-issue-url>',
  'linear-issue.mjs collect <workspace> <filter.json>',
  'linear-issue.mjs close <linear-issue-url> <comment-file> <record-file> [completed-state-id]',
  'linear-issue.mjs check-pr <pr-url> <identifier> closes|refs',
].join('\n');
const ISSUE_URL = /^https:\/\/linear\.app\/([a-z0-9][a-z0-9-]*)\/issue\/([a-z][a-z0-9]*-[1-9]\d*)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const PULL_URL = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/;
const CLOSED = ['completed', 'canceled'];

export function parseIssueUrl(url) {
  const match = String(url ?? '').trim().match(ISSUE_URL);
  check(match, `Expected a Linear issue URL such as https://linear.app/<workspace>/issue/ENG-123: ${url}`);
  const workspace = match[1].toLowerCase(), identifier = match[2].toUpperCase();
  return { tracker: 'linear', workspace, identifier, url: `https://linear.app/${workspace}/issue/${identifier}` };
}

// Pass authentication and keyring results through unchanged, so the caller can follow
// the $add-issue authentication procedure.
const passthrough = (result, fields) => ({ ...result, ...fields });

async function read([url], deps) {
  const target = parseIssueUrl(url);
  const result = await deps.linear('read', { version: 1, workspace: target.workspace, identifiers: [target.identifier] });
  if (result.status !== 'verified') return passthrough(result, { target });
  const [issue] = result.issues;
  return {
    version: 1, complete: true, status: 'verified', tracker: 'linear', workspace: target.workspace,
    // Linear keeps old identifiers working after a team move; the current identifier is the one to reference.
    identifier: issue.identifier, requestedIdentifier: target.identifier, url: issue.url,
    closed: CLOSED.includes(issue.state.type), state: issue.state,
    // Linear attaches linked GitHub PRs to the issue; they show existing work for it.
    pullRequests: issue.attachments.map(a => a.url).filter(u => PULL_URL.test(u ?? '')),
    references: { closes: referenceLine('closes', issue.identifier), refs: referenceLine('refs', issue.identifier) },
    issue,
  };
}

async function collect([workspace, filterFile], deps) {
  check(workspace && filterFile, USAGE);
  return deps.linear('collect', { version: 1, workspace: workspace.toLowerCase(), filter: readJson(filterFile) });
}

// The record file keeps one client comment ID for every attempt to close this issue,
// so a retry after a lost response never posts a second evidence comment.
async function close([url, commentFile, recordFile, stateId], deps) {
  check(url && commentFile && recordFile, USAGE);
  const target = parseIssueUrl(url);
  const comment = resolve(commentFile), path = resolve(recordFile);
  let record;
  if (existsSync(path)) {
    record = readJson(path);
    check(record.version === 1 && record.workspace === target.workspace && record.identifier === target.identifier,
      `The record file ${path} belongs to another issue`);
    check(record.commentFile === comment, `The record file ${path} uses the comment file ${record.commentFile}`);
  } else {
    record = { version: 1, workspace: target.workspace, identifier: target.identifier, commentFile: comment, commentId: deps.uuid() };
    save(path, record);
  }
  const result = await deps.linear('close', {
    version: 1, workspace: target.workspace, identifier: target.identifier, commentFile: comment, commentId: record.commentId,
    ...(stateId ? { stateId } : {}),
  });
  return passthrough(result, { recordFile: path, commentId: record.commentId });
}

// Pure: check the issue reference of one published PR.
export function checkPullRequest(pr, identifier, kind) {
  check(['closes', 'refs'].includes(kind), 'Expected closes or refs');
  const errors = [];
  const lines = (pr.body ?? '').split(/\r?\n/).map(line => line.trim());
  const closes = referenceLine('closes', identifier), refs = referenceLine('refs', identifier);
  if (pr.isDraft) errors.push('The PR is a draft');
  if (pr.state !== 'OPEN') errors.push(`The PR state is ${pr.state}`);
  if (kind === 'closes') {
    if (!lines.includes(closes)) errors.push(`The body has no standalone "${closes}" line`);
    if (lines.includes(refs)) errors.push(`The body also has "${refs}"`);
  } else {
    if (!lines.includes(refs)) errors.push(`The body has no standalone "${refs}" line`);
    // Linear completes an issue when a merged PR uses a closing word for it, or names it in its title or head branch.
    if (closesReference(pr.body, identifier)) errors.push(`The body uses a Linear closing word for ${identifier}`);
    if (linksLinearIssue(pr.title, identifier)) errors.push(`The title contains ${identifier}`);
    if (linksLinearIssue(pr.headRefName, identifier)) errors.push(`The head branch contains ${identifier}`);
  }
  return { version: 1, complete: errors.length === 0, status: errors.length ? 'mismatch' : 'verified', url: pr.url, identifier, kind, errors };
}

async function checkPr([url, identifier, kind], deps) {
  check(url && identifier && kind, USAGE);
  check(/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(identifier), 'Expected an uppercase Linear identifier such as ENG-123');
  const pr = JSON.parse(deps.gh(['pr', 'view', url, '--json', 'url,title,headRefName,body,isDraft,state']));
  return checkPullRequest(pr, identifier, kind);
}

const commands = { read, collect, close, 'check-pr': checkPr };
export function main(args, deps = {}) {
  const [command, ...rest] = args;
  check(commands[command], USAGE);
  return commands[command](rest, {
    linear: deps.linear ?? batchLinear,
    uuid: deps.uuid ?? randomUUID,
    gh: deps.gh ?? (argv => execFileSync('gh', argv, { encoding: 'utf8' })),
  });
}
cli(import.meta.url, USAGE, args => main(args));
