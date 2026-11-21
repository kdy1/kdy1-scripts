#!/usr/bin/env node

// gh-bot-auth: run gh and git as a GitHub App bot in registered agent threads.
//
// The gh and git shims (shim.sh) call this command only in a registered
// thread. It mints installation access tokens for the owner of the target
// repository and caches them until shortly before they expire.

import { createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Usage:
  gh-bot-auth status [--json]
  gh-bot-auth activate [--repo OWNER/REPO]
  gh-bot-auth deactivate
  gh-bot-auth whoami [--human]
  gh-bot-auth token [--owner OWNER | --repo OWNER/REPO]
  gh-bot-auth gh-token -- <gh arguments>
  gh-bot-auth identity --shell
  gh-bot-auth git-credential <get|store|erase>

activate registers the current agent thread (CODEX_THREAD_ID, else
T3CODE_THREAD_ID). In a registered thread, the gh and git shims use the bot.
GH_BOT_AUTH=1 forces the bot and GH_BOT_AUTH=0 forces the normal account.
`;

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
// Mint a new token when the cached one expires in less than this time.
const TOKEN_MARGIN_MS = 10 * 60 * 1000;
const INSTALLATIONS_TTL_MS = 60 * 60 * 1000;

export function paths(env = process.env) {
  const home = env.HOME || homedir();
  const config = env.GH_BOT_AUTH_CONFIG || join(env.XDG_CONFIG_HOME || join(home, ".config"), "gh-bot-auth", "config.json");
  const state = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "gh-bot-auth");
  const cache = join(env.XDG_CACHE_HOME || join(home, ".cache"), "gh-bot-auth");
  return { home, config, state, cache, threads: join(state, "threads"), identity: join(state, "identity") };
}

// The thread key is the innermost agent thread: a Codex thread (also a Codex
// subagent) has its own CODEX_THREAD_ID, and Claude Code subagents share the
// T3CODE_THREAD_ID of their T3 Code thread.
export function threadKey(env = process.env) {
  for (const [prefix, name] of [["codex", "CODEX_THREAD_ID"], ["t3", "T3CODE_THREAD_ID"]]) {
    const id = env[name];
    if (id && /^[A-Za-z0-9._-]+$/.test(id)) return `${prefix}-${id}`;
  }
  return null;
}

export function readConfig(env = process.env) {
  const p = paths(env);
  if (!existsSync(p.config)) return null;
  const raw = JSON.parse(readFileSync(p.config, "utf8"));
  const appId = String(raw.appId ?? "").trim();
  if (!appId) throw new Error(`${p.config}: appId is required`);
  const keyPath = String(raw.privateKeyPath ?? "").replace(/^~(?=\/|$)/, p.home);
  if (!keyPath) throw new Error(`${p.config}: privateKeyPath is required`);
  return { appId, keyPath, defaultOwner: raw.defaultOwner ? String(raw.defaultOwner) : null };
}

function requireConfig(env) {
  const config = readConfig(env);
  if (!config) throw new Error(`gh-bot-auth is not configured: ${paths(env).config} does not exist`);
  return config;
}

export function threadRecord(env = process.env) {
  if (env.GH_BOT_AUTH === "0") return null;
  const key = threadKey(env);
  const file = key && join(paths(env).threads, key);
  if (file && existsSync(file)) {
    try { return { key, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { return { key }; }
  }
  return env.GH_BOT_AUTH === "1" ? { key, forced: true } : null;
}

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

const b64url = (data) => Buffer.from(data).toString("base64url");

export function appJwt(config, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(readFileSync(config.keyPath, "utf8"), "base64url")}`;
}

export class Client {
  constructor({ env = process.env, fetch = globalThis.fetch, now = Date.now } = {}) {
    this.env = env; this.fetch = fetch; this.now = now;
    this.paths = paths(env); this.config = requireConfig(env);
  }

  // Without a token, authenticate as the app with a JWT. With anonymous, send
  // no credentials: the app JWT works only for the /app endpoints.
  async api(path, { method = "GET", token, anonymous = false, body } = {}) {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "gh-bot-auth", "X-GitHub-Api-Version": API_VERSION };
    if (!anonymous) headers.Authorization = token ? `token ${token}` : `Bearer ${appJwt(this.config, this.now())}`;
    const response = await this.fetch(`${API}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
    return { data: text ? JSON.parse(text) : null, link: response.headers.get("link") };
  }

  async installations({ refresh = false } = {}) {
    const file = join(this.paths.cache, "installations.json");
    const cached = readJson(file);
    if (!refresh && cached?.appId === this.config.appId && this.now() - cached.fetchedAt < INSTALLATIONS_TTL_MS) return cached.items;
    const items = [];
    let path = "/app/installations?per_page=100";
    while (path) {
      const { data, link } = await this.api(path);
      for (const x of data) items.push({ id: x.id, owner: x.account.login });
      const next = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/);
      path = next ? next[1] : null;
    }
    writePrivate(file, JSON.stringify({ appId: this.config.appId, fetchedAt: this.now(), items }));
    return items;
  }

  // Select the installation for an owner. An owner without an installation
  // falls back to the thread's repository owner, then to defaultOwner, so that
  // reads of public repositories still work. Writes to that owner then fail
  // with a clear 403 from GitHub.
  async installationFor(owner) {
    const thread = threadRecord(this.env);
    const fallbacks = [thread?.repo?.split("/")[0], this.config.defaultOwner].filter(Boolean);
    const find = (items, name) => items.find((x) => x.owner.toLowerCase() === String(name).toLowerCase());
    let items = await this.installations();
    if (owner && !find(items, owner)) {
      const cached = readJson(join(this.paths.cache, "installations.json"));
      if (this.now() - (cached?.fetchedAt ?? 0) > 60 * 1000) items = await this.installations({ refresh: true });
    }
    const exact = owner && find(items, owner);
    if (exact) return exact;
    for (const name of fallbacks) {
      const x = find(items, name);
      if (x) {
        if (owner) process.stderr.write(`gh-bot-auth: the app is not installed for ${owner}; using the installation for ${x.owner}\n`);
        return x;
      }
    }
    if (!owner && items.length === 1) return items[0];
    if (!items.length) throw new Error("The GitHub App has no installations");
    throw new Error(owner ? `The GitHub App is not installed for ${owner}` : "Cannot select an installation: set defaultOwner in the config or pass --owner");
  }

  async token(owner) {
    const installation = await this.installationFor(owner);
    const file = join(this.paths.cache, "tokens", `${installation.id}.json`);
    const cached = readJson(file);
    if (cached?.token && Date.parse(cached.expiresAt) - this.now() > TOKEN_MARGIN_MS) return cached.token;
    const { data } = await this.api(`/app/installations/${installation.id}/access_tokens`, { method: "POST" });
    writePrivate(file, JSON.stringify({ owner: installation.owner, token: data.token, expiresAt: data.expires_at }));
    return data.token;
  }

  async identity() {
    const file = join(this.paths.cache, "identity.json");
    const cached = readJson(file);
    if (cached?.appId === this.config.appId) {
      if (!existsSync(this.paths.identity)) writePrivate(this.paths.identity, `${cached.name}\n${cached.email}\n`);
      return cached;
    }
    const { data: app } = await this.api("/app");
    const login = `${app.slug}[bot]`;
    const { data: user } = await this.api(`/users/${encodeURIComponent(login)}`, { anonymous: true });
    const identity = { appId: this.config.appId, slug: app.slug, login, name: login, email: `${user.id}+${login}@users.noreply.github.com` };
    writePrivate(file, JSON.stringify(identity));
    // The git shim reads the name and the email from this file.
    writePrivate(this.paths.identity, `${identity.name}\n${identity.email}\n`);
    return identity;
  }
}

const ownerOf = (repo) => {
  const parts = String(repo).replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] !== "github.com") return null;
  return parts.length >= 2 ? parts[parts.length - 2] : null;
};

export function ownerFromUrl(url) {
  const m = String(url).match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/[^/]+?(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// Value-taking flags of `gh api`, whose values are not the endpoint.
const API_VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--hostname", "-q", "--jq", "-t", "--template", "--input", "--cache", "-p", "--preview"]);

// Find the repository owner that a gh command targets, from the most specific
// source to the least specific one. Returns null when the arguments do not
// name one; the caller then uses the current repository.
export function ownerFromGhArgs(args, env = process.env) {
  if (env.GH_REPO) return ownerOf(env.GH_REPO);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-R" || a === "--repo") && args[i + 1]) return ownerOf(args[i + 1]);
    if (a.startsWith("--repo=")) return ownerOf(a.slice(7));
    if (/^-R[^-]/.test(a)) return ownerOf(a.slice(2));
  }
  for (const a of args) {
    const url = a.match(/https?:\/\/github\.com\/([^/\s]+)\/[^/\s]+/);
    if (url) return url[1];
  }
  const texts = [...args];
  if (args[0] === "api") {
    let endpoint = null;
    for (let i = 1; i < args.length; i++) {
      if (API_VALUE_FLAGS.has(args[i])) { i++; continue; }
      if (!args[i].startsWith("-")) { endpoint = args[i]; break; }
    }
    const m = endpoint?.replace(/^\//, "").match(/^(?:repos|orgs|users)\/([^/?{]+)/);
    if (m) return decodeURIComponent(m[1]);
    // A search endpoint has its qualifiers in the encoded query string.
    if (endpoint) { try { texts.push(decodeURIComponent(endpoint.replace(/\+/g, " "))); } catch { /* not encoded */ } }
    for (let i = 1; i < args.length; i++) {
      if (!["-f", "-F", "--field", "--raw-field"].includes(args[i])) continue;
      const field = args[i + 1] ?? "";
      const named = field.match(/^(?:owner|login|org)=([^\s{]+)$/);
      if (named) return named[1];
      const repo = field.match(/^(?:repo|repository|nameWithOwner)=([^/\s]+)\/[^\s]+$/);
      if (repo) return repo[1];
      const literal = field.match(/^query=[\s\S]*?\b(?:owner|login)\s*:\s*"([^"]+)"/);
      if (literal) return literal[1];
    }
  }
  for (const a of texts) {
    const q = a.match(/\b(?:repo:([^/\s]+)\/|org:|user:)([^\s/]+)?/);
    if (q) return q[1] ?? q[2];
  }
  return null;
}

// The owner of the repository in the working directory, as gh resolves it: the
// remote that `gh repo set-default` marked, else upstream, github, origin.
export function ownerFromCwd(cwd = process.cwd(), env = process.env) {
  const r = spawnSync("git", ["-C", cwd, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], { encoding: "utf8", env: { ...env, GH_BOT_AUTH: "0" } });
  if (r.status !== 0) return null;
  const remotes = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^remote\.(.+)\.(url|gh-resolved) (.+)$/);
    if (!m) continue;
    const entry = remotes.get(m[1]) ?? {};
    entry[m[2]] = m[3];
    remotes.set(m[1], entry);
  }
  for (const entry of remotes.values()) {
    if (!entry["gh-resolved"]) continue;
    if (entry["gh-resolved"] === "base") { const o = ownerFromUrl(entry.url); if (o) return o; }
    else { const o = ownerOf(entry["gh-resolved"]); if (o) return o; }
  }
  const names = ["upstream", "github", "origin", ...remotes.keys()];
  for (const name of names) {
    const o = remotes.has(name) && ownerFromUrl(remotes.get(name).url);
    if (o) return o;
  }
  return null;
}

function parseCredential(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  return fields;
}

function humanLogin(env) {
  const clean = { ...env, GH_BOT_AUTH: "0" };
  delete clean.GH_TOKEN; delete clean.GITHUB_TOKEN;
  const r = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", env: clean });
  if (r.status !== 0) throw new Error(`Cannot read the human account: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function shimStatus(name, env) {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env });
  const path = r.stdout.trim();
  if (!path) return { path: null, shim: false };
  let shim = false;
  try { shim = readFileSync(path, "utf8").includes("gh-bot-auth shim"); } catch { /* a binary */ }
  return { path, shim };
}

export async function main(argv, { env = process.env, fetch = globalThis.fetch, stdin = () => readFileSync(0, "utf8"), out = (s) => process.stdout.write(s) } = {}) {
  const [command, ...args] = argv;
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const p = paths(env);
  const client = () => new Client({ env, fetch });

  switch (command) {
    case "status": {
      const config = readConfig(env);
      const thread = threadRecord(env);
      const status = {
        configured: !!config,
        active: !!(config && thread),
        threadKey: threadKey(env),
        repo: thread?.repo ?? null,
        login: config ? (await client().identity()).login : null,
        installations: config ? (await client().installations()).map((x) => x.owner) : [],
        shims: { gh: shimStatus("gh", env), git: shimStatus("git", env) },
      };
      out(args.includes("--json") ? `${JSON.stringify(status, null, 2)}\n`
        : `configured: ${status.configured}\nactive: ${status.active}\nlogin: ${status.login ?? "-"}\ninstallations: ${status.installations.join(", ") || "-"}\n`);
      return 0;
    }
    case "activate": {
      const config = readConfig(env);
      const key = threadKey(env);
      const repo = option("--repo") ?? null;
      if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("--repo must be OWNER/REPO");
      const reason = !config ? "not configured" : !key ? "no CODEX_THREAD_ID or T3CODE_THREAD_ID" : null;
      if (reason) { out(`${JSON.stringify({ active: false, reason })}\n`); return 0; }
      const c = client();
      const identity = await c.identity();
      if (repo) await c.token(ownerOf(repo));
      const shims = { gh: shimStatus("gh", env).shim, git: shimStatus("git", env).shim };
      if (!shims.gh || !shims.git) { out(`${JSON.stringify({ active: false, reason: "the gh and git shims are not first in PATH", shims })}\n`); return 0; }
      writePrivate(join(p.threads, key), JSON.stringify({ repo, activatedAt: new Date().toISOString() }));
      out(`${JSON.stringify({ active: true, threadKey: key, login: identity.login, email: identity.email, repo })}\n`);
      return 0;
    }
    case "deactivate": {
      const key = threadKey(env);
      if (key) rmSync(join(p.threads, key), { force: true });
      out(`${JSON.stringify({ active: false, threadKey: key })}\n`);
      return 0;
    }
    case "whoami": {
      if (args.includes("--human")) { out(`${humanLogin(env)}\n`); return 0; }
      out(`${threadRecord(env) && readConfig(env) ? (await client().identity()).login : humanLogin(env)}\n`);
      return 0;
    }
    case "token": {
      const owner = option("--owner") ?? (option("--repo") && ownerOf(option("--repo"))) ?? ownerFromCwd(process.cwd(), env);
      out(`${await client().token(owner)}\n`);
      return 0;
    }
    case "gh-token": {
      // Called by the gh shim. Print nothing for a host other than github.com,
      // so that gh uses its normal authentication there.
      const ghArgs = args[0] === "--" ? args.slice(1) : args;
      const hostname = option("--hostname") ?? env.GH_HOST;
      if (hostname && hostname !== "github.com") return 0;
      const owner = ownerFromGhArgs(ghArgs, env) ?? ownerFromCwd(process.cwd(), env);
      out(`${await client().token(owner)}\n`);
      return 0;
    }
    case "identity": {
      const identity = await client().identity();
      out(args.includes("--shell") ? `${identity.name}\n${identity.email}\n` : `${JSON.stringify(identity)}\n`);
      return 0;
    }
    case "git-credential": {
      // Git calls the helper with get, store, or erase. The tokens are minted
      // here, so store and erase have nothing to do.
      if (args[0] !== "get") return 0;
      const fields = parseCredential(stdin());
      if (fields.protocol !== "https" || fields.host !== "github.com") return 0;
      const owner = fields.path ? fields.path.split("/")[0] : null;
      out(`username=x-access-token\npassword=${await client().token(owner || null)}\n`);
      return 0;
    }
    case undefined: case "-h": case "--help":
      out(help);
      return command ? 0 : 2;
    default:
      throw new Error(`Unknown command: ${command}\n${help}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`gh-bot-auth: ${error.message}\n`); process.exitCode = 1; }
}
