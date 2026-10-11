import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./merge-pr.mjs", import.meta.url));
const url = "https://github.com/owner/repo/pull/1";
const sha = "a".repeat(40);
const fields = "url,state,mergedAt,mergeCommit,autoMergeRequest";
const merged = { url, state: "MERGED", mergedAt: "2026-10-11T00:00:00Z", mergeCommit: { oid: sha }, autoMergeRequest: null };
const open = { url, state: "OPEN", mergedAt: null, mergeCommit: null, autoMergeRequest: null };
const view = (target = url, extra = []) => ["pr", "view", target, "--json", fields, ...extra];
const merge = (target = url, extra = ["--auto"]) => ["pr", "merge", target, "--squash", ...extra];

function fixture(t, steps) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(dir, "steps.json"), JSON.stringify(steps));
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const path = process.env.MERGE_PR_TEST_DIR;
const calls = fs.readFileSync(path + "/calls.jsonl", "utf8").trim().split("\\n").filter(Boolean);
const args = process.argv.slice(2);
fs.appendFileSync(path + "/calls.jsonl", JSON.stringify(args) + "\\n");
const step = JSON.parse(fs.readFileSync(path + "/steps.json", "utf8"))[calls.length];
if (!step || JSON.stringify(args) !== JSON.stringify(step.args)) {
  process.stderr.write("Unexpected command: " + JSON.stringify(args)); process.exit(99);
}
process.stdout.write(step.stdout ?? (step.json === undefined ? "" : JSON.stringify(step.json)));
process.stderr.write(step.stderr ?? "");
process.exit(step.exitCode ?? 0);
`, { mode: 0o755 });
  return (...args) => {
    const result = spawnSync(process.execPath, [helper, ...args], {
      encoding: "utf8", env: { ...process.env, MERGE_PR_TEST_DIR: dir, PATH: `${dir}${delimiter}${process.env.PATH}` },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, steps.length, result.stdout + result.stderr);
    assert.deepEqual(calls, steps.map((step) => step.args));
    return { ...result, report: JSON.parse(result.stdout) };
  };
}

test("default merge runs first, verifies its SHA, and uses only squash/auto", (t) => {
  const run = fixture(t, [{ args: merge() }, { args: view(), json: merged }]);
  const result = run("merge", url);
  assert.equal(result.status, 0);
  assert.equal(result.report.results[0].outcome, "merged");
  assert.equal(result.report.results[0].mergeCommitSha, sha);
  assert.equal(result.report.results[0].url, url);
});

test("handoff passes the exact head and omits auto; repo applies to both commands", (t) => {
  const repo = ["--repo", "github.example.com/owner/repo"];
  const run = fixture(t, [
    { args: merge("1", ["--match-head-commit", sha, ...repo]) },
    { args: view("1", repo), json: merged },
  ]);
  assert.equal(run("merge", "1", "--no-auto", "--match-head-commit", sha, ...repo).status, 0);
});

test("head matching alone retains auto", (t) => {
  const run = fixture(t, [
    { args: merge(url, ["--auto", "--match-head-commit", sha]) },
    { args: view(), json: merged },
  ]);
  assert.equal(run("merge", url, "--match-head-commit", sha).status, 0);
});

test("no-auto alone supports a single target", (t) => {
  const run = fixture(t, [{ args: merge(url, []) }, { args: view(), json: merged }]);
  assert.equal(run("merge", url, "--no-auto").status, 0);
});

test("multiple PRs preserve order and continue after an individual merge failure", (t) => {
  const run = fixture(t, [
    { args: merge("2"), exitCode: 1, stderr: "Permission denied", stdout: "attempt output" },
    { args: view("2"), json: { ...open, url: url.replace(/1$/, "2") } },
    { args: merge("1") }, { args: view("1"), json: merged },
  ]);
  const result = run("merge", "2", "1");
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.results.map((pr) => pr.target), ["2", "1"]);
  assert.deepEqual(result.report.results.map((pr) => pr.outcome), ["unverified", "merged"]);
  assert.equal(result.report.results[0].merge.stderr, "Permission denied");
  assert.equal(result.report.results[0].merge.stdout, "attempt output");
});

test("a failed command retains a separately verified merged outcome", (t) => {
  const run = fixture(t, [{ args: merge(), exitCode: 1, stderr: "CLI error" }, { args: view(), json: merged }]);
  const result = run("merge", url);
  assert.equal(result.status, 1);
  assert.equal(result.report.results[0].outcome, "merged");
  assert.equal(result.report.results[0].merge.exitCode, 1);
  assert.equal(result.report.results[0].verification.error, null);
});

test("explicit queue confirmation takes precedence over auto-merge pending", (t) => {
  const run = fixture(t, [
    { args: merge(), stderr: "! Pull request owner/repo#1 is already queued to merge\n" },
    { args: view(), json: { ...open, autoMergeRequest: { enabledAt: "today" } } },
  ]);
  const result = run("merge", url);
  assert.equal(result.status, 0);
  assert.equal(result.report.results[0].outcome, "queued");
});

for (const [name, output] of [
  ["future queue eligibility", "✓ Pull request owner/repo#1 will be added to the merge queue for main when ready\n"],
  ["unknown queue wording", "queue request accepted"],
  ["confirmation for another PR", "! Pull request owner/repo#2 is already queued to merge\n"],
  ["confirmation for another repo", "! Pull request other/repo#1 is already queued to merge\n"],
  ["suppressed output", ""],
]) {
  test(`${name} does not establish queue registration`, (t) => {
    const run = fixture(t, [{ args: merge(), stderr: output }, { args: view(), json: open }]);
    const result = run("merge", url);
    assert.equal(result.status, 1);
    assert.equal(result.report.results[0].outcome, "unverified");
  });
}

test("auto-merge request confirms pending despite future queue wording", (t) => {
  const run = fixture(t, [
    { args: merge(), stdout: "will be added to the merge queue when ready" },
    { args: view(), json: { ...open, autoMergeRequest: { enabledAt: "today" } } },
  ]);
  const result = run("merge", url);
  assert.equal(result.status, 0);
  assert.equal(result.report.results[0].outcome, "auto_merge_pending");
});

for (const [name, response] of [
  ["missing merge SHA", { json: { ...merged, mergeCommit: null } }],
  ["empty merge SHA", { json: { ...merged, mergeCommit: { oid: "" } } }],
  ["unreadable state", { json: { url } }],
  ["missing URL", { json: { ...merged, url: null } }],
  ["closed PR", { json: { ...open, state: "CLOSED" } }],
  ["verification command failure", { exitCode: 1, stderr: "Network unavailable" }],
  ["malformed JSON", { stdout: "not JSON" }],
  ["non-object JSON", { json: null }],
]) {
  test(`${name} is unverified and preserves verification evidence`, (t) => {
    const run = fixture(t, [{ args: merge() }, { args: view(), ...response }]);
    const result = run("merge", url);
    assert.equal(result.status, 1);
    assert.equal(result.report.results[0].outcome, "unverified");
    assert.ok(result.report.results[0].verification.error);
    if (response.stderr) assert.equal(result.report.results[0].verification.stderr, response.stderr);
  });
}

test("merged result takes precedence over historical queue output", (t) => {
  const run = fixture(t, [
    { args: merge(), stderr: "! Pull request owner/repo#1 is already queued to merge\n" },
    { args: view(), json: merged },
  ]);
  assert.equal(run("merge", url).report.results[0].outcome, "merged");
});

test("verification failure does not stop remaining targets", (t) => {
  const run = fixture(t, [
    { args: merge("2") }, { args: view("2"), exitCode: 1, stderr: "Lookup failed" },
    { args: merge("1") }, { args: view("1"), json: merged },
  ]);
  const result = run("merge", "2", "1");
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.results.map((pr) => pr.outcome), ["unverified", "merged"]);
});

test("missing gh executable reports both execution and verification errors", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-no-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [helper, "merge", url], {
    encoding: "utf8", env: { ...process.env, PATH: dir },
  });
  const pr = JSON.parse(result.stdout).results[0];
  assert.equal(result.status, 1);
  assert.equal(pr.outcome, "unverified");
  assert.equal(pr.merge.exitCode, null);
  assert.match(pr.merge.error, /ENOENT/);
  assert.match(pr.verification.error, /ENOENT/);
});

for (const [name, response, success] of [
  ["success", { json: { url } }, true],
  ["CLI failure", { exitCode: 1, stderr: "No PR for branch" }, false],
  ["invalid JSON", { stdout: "bad" }, false],
  ["missing URL", { json: {} }, false],
]) {
  test(`resolve-current ${name} performs only the branch lookup`, (t) => {
    const run = fixture(t, [{ args: ["pr", "view", "--json", "url"], ...response }]);
    const result = run("resolve-current");
    assert.equal(result.status, success ? 0 : 1);
    assert.equal(result.report.url, success ? url : null);
    assert.equal(Boolean(result.report.error), !success);
  });
}

for (const args of [
  [], ["unknown"], ["merge"], ["resolve-current", "1"],
  ["merge", "1", "--subject", "subject"], ["merge", "1", "-t", ""],
  ["merge", "1", "--admin"], ["merge", "1", "--delete-branch"],
  ["merge", "1", "--repo"], ["merge", "1", "--repo", "bad"],
  ["merge", "1", "--no-auto", "--no-auto"],
  ["merge", "1", "2", "--no-auto"], ["merge", "1", "2", "--match-head-commit", sha],
  ["merge", "1", "--match-head-commit", "bad"],
  ["merge", "--"], ["merge", "0"], ["merge", "branch"],
  ["merge", "https://github.com/owner/repo/pull/1?bad=1"],
]) {
  test(`invalid arguments invoke no gh: ${JSON.stringify(args)}`, (t) => {
    const result = fixture(t, [])(...args);
    assert.equal(result.status, 1);
    assert.ok(result.report.error);
  });
}
