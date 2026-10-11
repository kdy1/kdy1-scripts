#!/usr/bin/env node
import { request } from './github-request.mjs';
import { check, version, nonempty, readJson, cli } from './helper-common.mjs';
export function canonicalIssues(input, observation) {
  version(input); version(observation); nonempty(input.query, 'exact query');
  check(/^[\w.-]+\/[\w.-]+$/.test(input.repository), 'Expected owner/repository');
  const incomplete = reason => ({ version: 1, complete: false, status: 'blocked', reason, query: input.query, issues: [] });
  if (!observation.complete || !Array.isArray(observation.pages) || !observation.pages.length) return incomplete('Incomplete search observation');
  let total, count = 0; const issues = [], seen = new Set();
  for (const { data } of observation.pages) {
    if (!data || data.incomplete_results !== false || !Number.isSafeInteger(data.total_count) || !Array.isArray(data.items)) return incomplete('Missing or incomplete search page');
    if (data.total_count > 1000) return incomplete('Search exceeds 1000-result cap');
    if (total !== undefined && total !== data.total_count) return incomplete('Search total changed during collection');
    total = data.total_count; count += data.items.length;
    for (const item of data.items) {
      if (item.pull_request) continue;
      const url = new URL(item.html_url);
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/);
      if (url.protocol !== 'https:' || url.hostname !== input.host || !match || `${match[1]}/${match[2]}`.toLowerCase() !== input.repository.toLowerCase() || Number(match[3]) !== item.number) return incomplete('Issue outside selected repository or invalid identity');
      const key = `${input.host}/${input.repository}/${item.number}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); issues.push({ key, number: item.number, url: item.html_url, canonicalOrder: issues.length }); }
    }
  }
  if (count !== total) return incomplete('Pagination count differs from reported total');
  return { version: 1, complete: true, status: 'complete', query: input.query, host: input.host, repository: input.repository, total, issues };
}
export async function collectIssues(input, options) {
  version(input); nonempty(input.query, 'exact query');
  // The coordinator owns query interpretation; this helper never adds or rewrites qualifiers.
  const result = await request({ version: 1, statePath: input.statePath, host: input.host, endpoint: '/search/issues', resource: 'search', parameters: { q: input.query, per_page: 100 }, paginate: true, maxPages: 10 }, options);
  return canonicalIssues(input, result);
}
cli(import.meta.url, 'collect-issues.mjs input.json', ([path]) => { check(path, 'Missing input file'); return collectIssues(readJson(path)); });
