import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./repair-pr.mjs", import.meta.url));
const bot = "chatgpt-codex-connector[bot]";
const comment = (author, body = author) => ({
  author: author === null ? null : { login: author }, body,
  url: `https://github.com/owner/repo/pull/1#${body}`,
});
const connection = (nodes, cursor = null) => ({
  nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const thread = (id, authors, extra = {}) => ({
  id, path: "file.js", line: 1, isResolved: false, isOutdated: false,
  comments: connection(authors.map((author) => comment(author))), ...extra,
});

function fixture(t, data) {
  const dir = mkdtempSync(join(tmpdir(), "repair-pr-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(data));
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.env.REPAIR_PR_FIXTURE, "utf8"));
const args = process.argv.slice(2);
let result;
if (args[0] === "pr" && args[1] === "view") {
  result = { number: 1, title: "Example", url: "https://github.com/owner/repo/pull/1",
    baseRefName: "main", headRefName: "fix", mergeStateStatus: "CLEAN", isDraft: false };
} else if (args[0] === "pr" && args[1] === "checks") {
  result = [];
} else if (args[0] === "api" && args[1] === "graphql") {
  const query = args.find(arg => arg.startsWith("query=")) || "";
  if (query.includes("mutation")) throw new Error("Unexpected mutation");
  const cursor = args.find(arg => arg.startsWith("cursor="))?.slice(7) || "first";
  if (query.includes("$owner:")) {
    if (!query.includes("viewer")) throw new Error("Missing viewer query");
    result = { data: { viewer: data.viewer,
      repository: { pullRequest: { reviewThreads: data.pages[cursor] } } } };
  } else {
    result = { data: { node: { comments: data.comments[cursor] } } };
  }
} else throw new Error("Unexpected gh command: " + args.join(" "));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
  return (...args) => spawnSync(process.execPath, [helper, "status", "--pr", "1", ...args], {
    encoding: "utf8", env: { ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      REPAIR_PR_FIXTURE: join(dir, "fixture.json") },
  });
}

test("status includes bot and @me inline threads once and preserves JSON compatibility", (t) => {
  const run = fixture(t, { viewer: { login: "Alice" }, pages: { first: connection([
    thread("bot", [bot]), thread("bot-alias", ["chatgpt-codex-connector"]),
    thread("me", ["other", "aLiCe"]), thread("mixed", [bot, "Alice"]),
    thread("other", ["other"]), thread("deleted", [null]),
    thread("resolved", ["Alice"], { isResolved: true }),
    thread("outdated", [bot], { isOutdated: true }),
    thread("suffix", ["Alice[bot]"]),
  ]) } });
  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.reviewAuthor, bot);
  assert.deepEqual(report.reviewAuthors, [bot, "Alice"]);
  assert.deepEqual(report.unresolvedReviewThreads.map(x => x.id), ["bot", "bot-alias", "me", "mixed"]);
  const me = report.unresolvedReviewThreads.find(x => x.id === "me");
  assert.equal(me.url, comment("aLiCe").url);
  assert.equal(me.comments.length, 2);
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Unresolved chatgpt-codex-connector\[bot\] and Alice review threads: 4/);
});

test("status finds @me across review-thread and comment pagination", (t) => {
  const run = fixture(t, { viewer: { login: "Alice" }, pages: {
    first: connection([thread("bot", [bot])], "threads-next"),
    "threads-next": connection([thread("later", [], {
      comments: connection([comment("other")], "comments-next"),
    })]),
  }, comments: { "comments-next": connection([comment("Alice")]) } });
  const result = run("--json");
  assert.equal(result.status, 0, result.stderr);
  const threads = JSON.parse(result.stdout).unresolvedReviewThreads;
  assert.deepEqual(threads.map(x => x.id), ["bot", "later"]);
  assert.equal(threads[1].url, comment("Alice").url);
});

test("status fails without an authenticated login even when there are no threads", (t) => {
  for (const viewer of [null, {}, { login: "" }, { login: " " }]) {
    const run = fixture(t, { viewer, pages: { first: connection([]) } });
    const result = run("--json");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /authenticated user's login \(@me\)/);
    assert.equal(result.stdout, "");
  }
});
