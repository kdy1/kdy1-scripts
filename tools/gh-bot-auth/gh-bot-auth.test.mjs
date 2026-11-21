import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appJwt, Client, main, ownerFromGhArgs, ownerFromUrl, threadKey } from "./gh-bot-auth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function scratch(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-bot-auth-"));
    try {
      const key = join(dir, "key.pem");
      writeFileSync(key, privateKey.export({ type: "pkcs1", format: "pem" }));
      const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_CACHE_HOME: join(dir, "cache"), PATH: process.env.PATH };
      mkdirSync(join(dir, "config", "gh-bot-auth"), { recursive: true });
      writeFileSync(join(dir, "config", "gh-bot-auth", "config.json"), JSON.stringify({ appId: 42, privateKeyPath: key, defaultOwner: "home" }));
      await fn({ dir, env });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

function fakeGitHub({ installations = [{ id: 1, account: { login: "home" } }, { id: 2, account: { login: "Org" } }] } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, options) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ path, method: options.method, auth: options.headers.Authorization });
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), headers: { get: () => null } });
    if (path.startsWith("/app/installations?")) return json(installations);
    const token = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (token) return json({ token: `tok-${token[1]}-${++n}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (path === "/app") return json({ slug: "my-bot" });
    if (path === "/users/my-bot%5Bbot%5D") return json({ id: 99 });
    return { ok: false, status: 404, text: async () => "not found", headers: { get: () => null } };
  };
  return { fetch, calls };
}

test("threadKey prefers the Codex thread and makes a safe file name", () => {
  assert.equal(threadKey({ CODEX_THREAD_ID: "abc", T3CODE_THREAD_ID: "t" }), "codex-abc");
  assert.equal(threadKey({ T3CODE_THREAD_ID: "5730-ab" }), "t3-5730-ab");
  assert.equal(threadKey({ T3CODE_THREAD_ID: "thread:project:a-1:b-2" }), "t3-thread:project:a-1:b-2");
  assert.equal(threadKey({ T3CODE_THREAD_ID: "thread:delegated-task:command%3Amcp%3Aa-1" }), "t3-thread:delegated-task:command_3Amcp_3Aa-1");
  assert.equal(threadKey({ T3CODE_THREAD_ID: "../x" }), "t3-.._x");
  assert.equal(threadKey({}), null);
});

test("ownerFromGhArgs finds the target owner", () => {
  const cases = [
    [["pr", "view", "1", "-R", "o/r"], "o"],
    [["pr", "view", "--repo=github.com/o2/r"], "o2"],
    [["pr", "merge", "https://github.com/o3/r/pull/4"], "o3"],
    [["api", "-X", "POST", "repos/o4/r/issues", "-f", "title=x"], "o4"],
    [["api", "/orgs/o5/members"], "o5"],
    [["api", "graphql", "-f", "query=query { x }", "-F", "owner=o6"], "o6"],
    [["api", "graphql", "-f", 'query=query { repository(owner: "o7", name: "r") { id } }'], "o7"],
    [["search", "issues", "is:open repo:o8/r"], "o8"],
    [["api", "--method", "GET", "search/issues?q=repo%3Ao10%2Fr+is%3Aissue"], "o10"],
    [["api", "repos/{owner}/{repo}/pulls"], null],
    [["pr", "list"], null],
  ];
  for (const [args, owner] of cases) assert.equal(ownerFromGhArgs(args, {}), owner, args.join(" "));
  assert.equal(ownerFromGhArgs(["pr", "list"], { GH_REPO: "o9/r" }), "o9");
});

test("ownerFromUrl reads https and ssh remotes of github.com only", () => {
  assert.equal(ownerFromUrl("https://github.com/o/r.git"), "o");
  assert.equal(ownerFromUrl("git@github.com:o/r.git"), "o");
  assert.equal(ownerFromUrl("ssh://git@github.com/o/r"), "o");
  assert.equal(ownerFromUrl("https://gitlab.com/o/r.git"), null);
});

test("appJwt is an RS256 token for the app", scratch(async ({ env }) => {
  const { readConfig } = await import("./gh-bot-auth.mjs");
  const [h, p, s] = appJwt(readConfig(env), 1_700_000_000_000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_699_999_940, exp: 1_700_000_480, iss: "42" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(s, "base64url")));
}));

test("tokens are minted per installation and cached", scratch(async ({ env }) => {
  const gh = fakeGitHub();
  const client = new Client({ env, fetch: gh.fetch });
  assert.equal(await client.token("org"), "tok-2-1");
  assert.equal(await client.token("ORG"), "tok-2-1");
  assert.equal(await client.token("home"), "tok-1-2");
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 2);
  assert.ok(gh.calls.every((c) => c.auth.startsWith("Bearer ")));
}));

test("an owner without an installation falls back to the thread repository, then defaultOwner", scratch(async ({ env }) => {
  const gh = fakeGitHub();
  assert.equal(await new Client({ env, fetch: gh.fetch }).token("stranger"), "tok-1-1");
  const threads = join(env.XDG_STATE_HOME, "gh-bot-auth", "threads");
  mkdirSync(threads, { recursive: true });
  writeFileSync(join(threads, "t3-a"), JSON.stringify({ repo: "Org/r" }));
  assert.equal(await new Client({ env: { ...env, T3CODE_THREAD_ID: "a" }, fetch: gh.fetch }).token("stranger"), "tok-2-2");
  const none = { ...env };
  writeFileSync(join(env.XDG_CONFIG_HOME, "gh-bot-auth", "config.json"), JSON.stringify({ appId: 42, privateKeyPath: join(env.HOME, "key.pem") }));
  await assert.rejects(new Client({ env: none, fetch: gh.fetch }).token("stranger"), /not installed for stranger/);
}));

test("identity uses the bot user id in the noreply email", scratch(async ({ env }) => {
  const gh = fakeGitHub();
  const identity = await new Client({ env, fetch: gh.fetch }).identity();
  assert.equal(identity.login, "my-bot[bot]");
  assert.equal(identity.email, "99+my-bot[bot]@users.noreply.github.com");
  assert.equal(readFileSync(join(env.XDG_STATE_HOME, "gh-bot-auth", "identity"), "utf8"), "my-bot[bot]\n99+my-bot[bot]@users.noreply.github.com\n");
  assert.equal(gh.calls.find((c) => c.path.startsWith("/users/")).auth, undefined);
  // The git shim needs the identity file even when only the cache remains.
  rmSync(join(env.XDG_STATE_HOME, "gh-bot-auth", "identity"));
  await new Client({ env, fetch: gh.fetch }).identity();
  assert.equal(readFileSync(join(env.XDG_STATE_HOME, "gh-bot-auth", "identity"), "utf8"), "my-bot[bot]\n99+my-bot[bot]@users.noreply.github.com\n");
}));

test("git-credential answers only for https://github.com, with the owner of the path", scratch(async ({ env }) => {
  const gh = fakeGitHub();
  let out = "";
  await main(["git-credential", "get"], { env, fetch: gh.fetch, stdin: () => "protocol=https\nhost=github.com\npath=Org/r.git\n", out: (s) => { out += s; } });
  assert.equal(out, "username=x-access-token\npassword=tok-2-1\n");
  out = "";
  await main(["git-credential", "get"], { env, fetch: gh.fetch, stdin: () => "protocol=https\nhost=example.com\n", out: (s) => { out += s; } });
  assert.equal(out, "");
}));

test("activate reports inactive without configuration or a thread", scratch(async ({ env }) => {
  let out = "";
  await main(["activate"], { env, out: (s) => { out += s; } });
  assert.deepEqual(JSON.parse(out), { active: false, reason: "no CODEX_THREAD_ID or T3CODE_THREAD_ID" });
  out = "";
  await main(["activate"], { env: { ...env, T3CODE_THREAD_ID: "a", GH_BOT_AUTH_CONFIG: "/nonexistent" }, out: (s) => { out += s; } });
  assert.deepEqual(JSON.parse(out), { active: false, reason: "not configured" });
}));

// Run the real shim with fake gh and git that print what they received.
test("the shims pass through outside a registered thread and use the bot inside it", scratch(async ({ dir, env }) => {
  const shims = join(dir, "shims"), real = join(dir, "real");
  mkdirSync(shims); mkdirSync(real);
  for (const name of ["gh", "git"]) symlinkSync(join(here, "shim.sh"), join(shims, name));
  symlinkSync(join(here, "gh-bot-auth.mjs"), join(shims, "gh-bot-auth"));
  writeFileSync(join(real, "gh"), '#!/bin/sh\necho "gh token=${GH_TOKEN:-none} args=$*"\n');
  writeFileSync(join(real, "git"), '#!/bin/sh\necho "git author=${GIT_AUTHOR_EMAIL:-none} count=${GIT_CONFIG_COUNT:-0} args=$*"\n');
  for (const name of ["gh", "git"]) chmodSync(join(real, name), 0o755);
  // Cached installations, token, and identity, so that the CLI makes no request.
  const cache = join(env.XDG_CACHE_HOME, "gh-bot-auth");
  mkdirSync(join(cache, "tokens"), { recursive: true });
  writeFileSync(join(cache, "installations.json"), JSON.stringify({ appId: "42", fetchedAt: Date.now(), items: [{ id: 1, owner: "home" }, { id: 2, owner: "Org" }] }));
  writeFileSync(join(cache, "tokens", "2.json"), JSON.stringify({ token: "cached-2", expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  const state = join(env.XDG_STATE_HOME, "gh-bot-auth");
  mkdirSync(join(state, "threads"), { recursive: true });
  writeFileSync(join(state, "identity"), "my-bot[bot]\n99+my-bot[bot]@users.noreply.github.com\n");

  const run = (name, args, extra = {}) => {
    const r = spawnSync(join(shims, name), args, { encoding: "utf8", env: { ...env, PATH: `${shims}:${real}:${process.env.PATH}`, ...extra } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const thread = { T3CODE_THREAD_ID: "a" };
  assert.equal(run("gh", ["pr", "list", "-R", "Org/r"], thread), "gh token=none args=pr list -R Org/r");
  assert.equal(run("git", ["status"], thread), "git author=none count=0 args=status");

  writeFileSync(join(state, "threads", "t3-a"), JSON.stringify({ repo: "Org/r" }));
  assert.equal(run("gh", ["pr", "list", "-R", "Org/r"], thread), "gh token=cached-2 args=pr list -R Org/r");
  assert.equal(run("git", ["push"], { ...thread, GIT_CONFIG_COUNT: "1" }), "git author=99+my-bot[bot]@users.noreply.github.com count=8 args=push");
  assert.equal(run("gh", ["pr", "list", "-R", "Org/r"], { ...thread, GH_BOT_AUTH: "0" }), "gh token=none args=pr list -R Org/r");
  assert.equal(run("gh", ["pr", "list"], { CODEX_THREAD_ID: "other" }), "gh token=none args=pr list");

  // A delegated T3 Code thread id has characters that the key replaces.
  const delegated = { T3CODE_THREAD_ID: "thread:delegated-task:command%3Amcp%3Ab" };
  assert.equal(run("gh", ["pr", "list", "-R", "Org/r"], delegated), "gh token=none args=pr list -R Org/r");
  writeFileSync(join(state, "threads", threadKey(delegated)), JSON.stringify({ repo: "Org/r" }));
  assert.equal(run("gh", ["pr", "list", "-R", "Org/r"], delegated), "gh token=cached-2 args=pr list -R Org/r");
}));
