#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { check, version, nonempty, absolute, readJson, load, save, lock, cli } from './helper-common.mjs';
const initial = { version: 1, cache: {}, cooldowns: {}, writes: {}, observations: [] };
export function authentication(host) {
  const token = (host === 'github.com' ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN : process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN) || (() => {
    const result = spawnSync('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8' });
    check(result.status === 0, 'Cannot obtain authenticated gh token'); return result.stdout.trim();
  })();
  nonempty(token, 'authentication token');
  return { token, namespace: createHash('sha256').update(token).digest('hex') };
}
function urlFor(input) {
  check(typeof input.host === 'string' && /^[\w.-]+$/.test(input.host), 'Invalid GitHub host');
  const origin = input.host === 'github.com' ? 'https://api.github.com' : `https://${input.host}`;
  const prefix = input.host === 'github.com' ? '' : input.endpoint === '/graphql' ? '/api' : '/api/v3';
  check(typeof input.endpoint === 'string' && input.endpoint.startsWith('/') && !input.endpoint.startsWith('//') && !input.endpoint.includes('#'), 'Expected REST endpoint path');
  const url = new URL(`${origin}${prefix}${input.endpoint}`);
  check(url.origin === origin, 'Endpoint origin changed');
  for (const [key, value] of Object.entries(input.parameters ?? {})) url.searchParams.set(key, String(value));
  url.searchParams.sort(); return url;
}
function headersOf(headers) { return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])); }
export async function fetchTransport(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: await response.text() };
}
export async function request(input, { transport = fetchTransport, auth, now = Date.now } = {}) {
  version(input); absolute(input.statePath);
  const method = input.method ?? 'GET'; check(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), 'Unsupported method');
  check(!input.paginate || method === 'GET', 'Pagination requires GET');
  const graphqlRead = input.operation === 'graphql-read';
  if (graphqlRead) check(method === 'POST' && input.endpoint === '/graphql' && typeof input.body?.query === 'string' && /^\s*(query\b|\{)/.test(input.body.query) && !/\bmutation\b/.test(input.body.query), 'GraphQL read requires an explicit query operation');
  const first = urlFor(input), write = method !== 'GET' && !graphqlRead, cacheable = method === 'GET';
  if (write) nonempty(input.attempt, 'write attempt id');
  const release = lock(input.statePath);
  if (!release) return { version: 1, complete: false, status: 'busy', retryAt: null };
  try {
    const state = load(input.statePath, initial); version(state);
    check(state.cache && state.cooldowns && state.writes && Array.isArray(state.observations), 'Corrupt request state');
    const resource = input.resource ?? (input.endpoint === '/graphql' ? 'graphql' : input.endpoint.startsWith('/search/') ? 'search' : 'core');
    const cooldown = Math.max(state.cooldowns.all ?? 0, state.cooldowns[resource] ?? 0);
    if (cooldown > now()) return { version: 1, complete: false, status: 'cooldown', resource, retryAt: cooldown };
    if (write && state.writes[input.attempt]) return { version: 1, complete: false, status: 'blocked', reason: 'Write attempt already recorded; reconcile before a new attempt', attempt: state.writes[input.attempt] };
    if (write && Object.values(state.writes).some(a => a.status === 'uncertain' && !a.reconciled && a.host === input.host)) return { version: 1, complete: false, status: 'uncertain', reason: 'Prior unknown write must be reconciled' };
    const identity = auth ?? authentication(input.host);
    nonempty(identity.namespace, 'authentication namespace'); nonempty(identity.token, 'token');
    if (state.namespace !== identity.namespace) { state.cache = {}; state.namespace = identity.namespace; }
    if (write) {
      state.cache = {};
      state.writes[input.attempt] = { status: 'uncertain', host: input.host, endpoint: input.endpoint, method, startedAt: now() };
    }
    save(input.statePath, state);
    let url = first, pages = [], seen = new Set();
    do {
      check(!seen.has(url.href), 'Pagination cycle'); seen.add(url.href);
      check(seen.size <= (input.maxPages ?? 10000), 'Pagination limit exceeded');
      const key = `${input.host}:${identity.namespace}:${input.apiVersion ?? 'default'}:${url.href}`;
      const cached = cacheable ? state.cache[key] : null;
      const headers = { Authorization: `Bearer ${identity.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
      if (input.apiVersion) headers['X-GitHub-Api-Version'] = input.apiVersion;
      if (cacheable && cached?.text !== undefined) {
        if (cached.etag) headers['If-None-Match'] = cached.etag;
        else if (cached.lastModified) headers['If-Modified-Since'] = cached.lastModified;
      }
      let response;
      try { response = await transport(url.href, { method, headers, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) }); }
      catch {
        state.observations.push({ at: now(), resource, outcome: write ? 'uncertain' : 'incomplete' });
        save(input.statePath, state);
        return { version: 1, complete: false, status: write ? 'uncertain' : 'incomplete', reason: 'Transport failed; no automatic retry', pages };
      }
      const h = headersOf(response.headers), reset = Number(h['x-ratelimit-reset']) * 1000;
      const primary = h['x-ratelimit-remaining'] === '0';
      const limited = response.status === 429 || (response.status === 403 && (primary || h['retry-after'] || /rate limit|secondary|abuse/i.test(response.text)));
      if (primary) state.cooldowns[h['x-ratelimit-resource'] ?? resource] = Number.isFinite(reset) && reset > now() ? reset : now() + 60000;
      if (limited && !primary) {
        state.secondaryCount = Math.min((state.secondaryCount ?? 0) + 1, 6);
        const retry = Number(h['retry-after']);
        const retryTime = Number.isFinite(retry) ? now() + retry * 1000 : Date.parse(h['retry-after']);
        state.cooldowns.all = Math.max(Number.isFinite(retryTime) ? retryTime : 0, now() + 60000 * 2 ** (state.secondaryCount - 1));
      }
      state.observations.push({ at: now(), resource: h['x-ratelimit-resource'] ?? resource, status: response.status, reset: Number.isFinite(reset) ? reset : null, outcome: response.status === 304 ? 'revalidated' : 'response' });
      if (write) { state.cache = {}; state.writes[input.attempt].status = response.status >= 500 ? 'uncertain' : 'responded'; state.writes[input.attempt].httpStatus = response.status; }
      save(input.statePath, state);
      if (limited) return { version: 1, complete: false, status: write && response.status >= 500 ? 'uncertain' : 'cooldown', resource, retryAt: Math.max(state.cooldowns.all ?? 0, state.cooldowns[resource] ?? 0), pages };
      if (!(response.status >= 200 && response.status < 300) && response.status !== 304) return { version: 1, complete: false, status: write && response.status >= 500 ? 'uncertain' : 'failed', httpStatus: response.status, pages };
      check(response.status !== 304 || (!write && cached?.text !== undefined && (cached.etag || cached.lastModified)), '304 without exact cached representation');
      const text = response.status === 304 ? cached.text : response.text;
      let data; try { data = text === '' ? null : JSON.parse(text); } catch { if (write) { state.writes[input.attempt].status = 'uncertain'; save(input.statePath, state); } return { version: 1, complete: false, status: write ? 'uncertain' : 'incomplete', reason: 'Invalid JSON representation', pages }; }
      const link = response.status === 304 ? (h.link ?? cached.link) : h.link;
      if (graphqlRead && (data?.errors?.length || !data?.data)) return { version: 1, complete: false, status: 'incomplete', reason: 'GraphQL query returned errors or no data', pages };
      if (cacheable) state.cache[key] = { text, link: link ?? null, etag: h.etag ?? (response.status === 304 ? cached.etag : null), lastModified: h['last-modified'] ?? (response.status === 304 ? cached.lastModified : null) };
      save(input.statePath, state);
      pages.push({ url: url.href, data, revalidated: response.status === 304 });
      if (input.paginate && link?.includes('rel="next"')) check(/<[^>]+>;\s*rel="next"/.test(link), 'Malformed next page link');
      const next = link?.match(/<([^>]+)>;\s*rel="next"/);
      if (input.paginate && next) {
        url = new URL(next[1], url);
        check(url.origin === first.origin && url.pathname === first.pathname && !url.username && !url.password, 'Unsafe pagination URL');
        if (Math.max(state.cooldowns.all ?? 0, state.cooldowns[resource] ?? 0) > now()) return { version: 1, complete: false, status: 'cooldown', pages };
      } else url = null;
    } while (url);
    return { version: 1, complete: true, status: 'complete', pages, mutationResponseOnly: write };
  } finally { release(); }
}
export function requestStatus(input) {
  version(input); absolute(input.statePath); const state = load(input.statePath, initial); version(state);
  return { version: 1, cooldowns: state.cooldowns, writes: state.writes, observations: state.observations, authenticationNamespace: state.namespace ?? null, cachedRepresentations: Object.keys(state.cache).length };
}
export function control(input) {
  version(input); absolute(input.statePath); const release = lock(input.statePath); check(release, 'Request state busy or interrupted; reconcile owner');
  try {
    const state = load(input.statePath, initial); version(state);
    if (input.action === 'invalidate') state.cache = {};
    else if (input.action === 'observe-cli') {
      nonempty(input.entryPoint, 'CLI entry point');
      state.observations.push({ at: Date.now(), entryPoint: input.entryPoint, outcome: input.limited ? 'limit-without-headers' : 'unintercepted', exactRequestCount: null });
      if (input.limited) state.cooldowns.all = Math.max(state.cooldowns.all ?? 0, Date.now() + 60000);
    } else if (input.action === 'reconcile-write') {
      nonempty(input.evidence, 'reconciliation evidence'); check(state.writes[input.attempt], 'Unknown write attempt');
      state.writes[input.attempt] = { ...state.writes[input.attempt], reconciled: true, evidence: input.evidence };
    } else throw new Error('Unknown request control action');
    save(input.statePath, state); return { version: 1, status: 'recorded' };
  } finally { release(); }
}
cli(import.meta.url, 'github-request.mjs <request|control|status> input.json', async ([command, path]) => {
  check(path && ['request', 'control', 'status'].includes(command), 'Usage: github-request.mjs <request|control|status> input.json');
  const input = readJson(path); return command === 'request' ? request(input) : command === 'status' ? requestStatus(input) : control(input);
});
