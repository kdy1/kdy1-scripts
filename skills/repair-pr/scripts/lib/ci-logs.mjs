import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, readPR, readChecks, isFailingCheck, api, run, outsideSource } from './common.mjs';
import { loadSession } from './session.mjs';

export function ciLogs(file, directory) {
  const s = loadSession(file), pr = readPR(s.pr.url);
  assert(pr.headRepository === s.pr.headRepository && pr.headBranch === s.branch, 'PR head identity changed');
  directory = outsideSource(directory); mkdirSync(directory, { recursive: true });
  const checks = readChecks(pr.url);
  const results = [], cache = new Map(), metadataCache = new Map();
  for (const check of checks.items.filter(isFailingCheck)) {
    const result = { name: check.name, link: check.link };
    try {
      const url = new URL(check.link);
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(?:\/job\/(\d+))?\/?$/);
      if (!match || url.hostname.toLowerCase() !== pr.host) { results.push({ ...result, state: 'external', error: 'No accessible GitHub Actions run/job identity' }); continue; }
      assert(`${pr.host}/${match[1]}`.toLowerCase() === pr.repository, 'Check log repository mismatch');
      const runID = match[2], jobID = match[4];
      const runKey = `${match[1]}/${runID}`;
      if (!metadataCache.has(runKey)) metadataCache.set(runKey, api(pr.host, `repos/${match[1]}/actions/runs/${runID}`));
      const metadata = metadataCache.get(runKey);
      assert(metadata.head_sha === pr.headSha && metadata.repository?.full_name?.toLowerCase() === match[1].toLowerCase(), 'Stale run head or mismatched repository');
      const attempt = match[3] ?? String(metadata.run_attempt);
      assert(/^\d+$/.test(attempt), 'Missing run attempt');
      if (jobID) {
        const jobKey = `${match[1]}/job/${jobID}`;
        if (!metadataCache.has(jobKey)) metadataCache.set(jobKey, api(pr.host, `repos/${match[1]}/actions/jobs/${jobID}`));
        const job = metadataCache.get(jobKey);
        assert(String(job.run_id) === runID && job.head_sha === pr.headSha && String(job.run_attempt) === attempt, 'Job/run/head/attempt mismatch');
      }
      const key = `${runID}-${jobID ?? 'run'}-${attempt}`;
      if (!cache.has(key)) {
        const log = run('gh', ['run', 'view', runID, '--repo', `${pr.host}/${match[1]}`, '--attempt', attempt, ...(jobID ? ['--job', jobID] : []), '--log']);
        const path = join(directory, `${key}.log`); writeFileSync(path, log.stdout, { mode: 0o600 }); cache.set(key, path);
      }
      results.push({ ...result, state: 'collected', path: cache.get(key), runID, jobID: jobID ?? null, attempt, headSha: pr.headSha });
    } catch (error) { results.push({ ...result, state: 'unavailable', error: error.message }); }
  }
  // A concurrent head change invalidates this inventory instead of making it healthy.
  const after = readPR(s.pr.url);
  const complete = checks.complete && after.headSha === pr.headSha && after.headRepository === pr.headRepository;
  return { complete, headSha: pr.headSha, checksError: checks.error, error: after.headSha !== pr.headSha ? 'PR head changed while collecting logs' : null, results };
}
