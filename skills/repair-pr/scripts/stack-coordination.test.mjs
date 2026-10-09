import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CoordinationStore, canonicalPr, planBatch } from "./stack-coordination.mjs";

const helper = fileURLToPath(new URL("./stack-coordination.mjs", import.meta.url));
const url = (n) => `https://github.com/owner/repo/pull/${n}`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "stack-coordination-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CoordinationStore(join(dir, "state"));
  const registration = (id = "s1", numbers = [1, 2]) => ({
    id, batch: "batch", repository: "github.com/owner/repo", ledger: join(dir, "ledger.json"),
    layers: numbers.map((n) => ({ branch: `layer-${n}`, pr: url(n) })),
  });
  const ready = (id, numbers) => store.register(registration(id, numbers), "builder", undefined, true);
  return { dir, store, registration, ready };
}

test("construction protects unpublished branches and cannot release partial publication", (t) => {
  const { store, registration } = fixture(t);
  const input = registration();
  input.layers[1].pr = null;
  const stack = store.register(input, "builder");
  assert.equal(stack.phase, "building");
  assert.equal(store.read().stacks[0].layers[1].branch, "layer-2");
  assert.throws(() => store.acquire("s1", "repair", "repair", url(1)), /owned/);
  assert.throws(() => store.ready("s1", "builder", stack.lock.token), /all published/);
  assert.throws(() => store.release("s1", "builder", stack.lock.token), /incomplete build/);
  store.register(registration(), "builder", stack.lock.token);
  store.ready("s1", "builder", stack.lock.token);
  assert.equal(store.read().stacks[0].lock, null);
  assert.equal(store.acquire("s1", "repair", "repair", url(2)).pr, url(2));
});

test("same stack excludes another PR and different stacks can own repairs concurrently", (t) => {
  const { store, ready } = fixture(t);
  ready("s1", [1, 2]); ready("s2", [3]);
  const first = store.acquire("s1", "a", "repair", url(1));
  assert.throws(() => store.acquire("s1", "b", "repair", url(2)), /owned/);
  const second = store.acquire("s2", "b", "repair", url(3));
  assert.notEqual(first.token, second.token);
  assert.equal(store.read().stacks.filter((stack) => stack.lock).length, 2);
});

test("reservation excludes other managers and may be consumed once for its assigned PR", (t) => {
  const { store, ready } = fixture(t); ready();
  const reservation = store.acquire("s1", "coordinator-attempt", "reserved", url(2));
  assert.throws(() => store.acquire("s1", "other-watch", "reserved", url(1)), /owned/);
  assert.throws(() => store.claim("s1", reservation.token, url(1), "child"), /does not match/);
  const claimed = store.claim("s1", reservation.token, url(2), "child");
  assert.notEqual(claimed.token, reservation.token);
  assert.throws(() => store.claim("s1", reservation.token, url(2), "second-child"), /does not match/);
  assert.throws(() => store.release("s1", "coordinator-attempt", reservation.token), /mismatch/);
  store.release("s1", "child", claimed.token);
});

test("owner and current token are required, including for an old attempt by the same owner", (t) => {
  const { store, ready } = fixture(t); ready();
  const old = store.acquire("s1", "a", "edit", url(1));
  assert.throws(() => store.release("s1", "b", old.token), /mismatch/);
  store.release("s1", "a", old.token);
  const next = store.acquire("s1", "a", "edit", url(1));
  assert.throws(() => store.release("s1", "a", old.token), /mismatch/);
  assert.equal(store.read().stacks[0].lock.token, next.token);
});

test("shared catalog serializes catalog changes without releasing stack protection", (t) => {
  const { store, ready } = fixture(t); ready("s1", [1]); ready("s2", [2]);
  const a = store.acquire("s1", "a", "edit", url(1));
  const b = store.acquire("s2", "b", "edit", url(2));
  const catalog = store.catalogAcquire("s1", "a", a.token);
  assert.throws(() => store.catalogAcquire("s2", "b", b.token), /catalog is owned/);
  assert.throws(() => store.release("s1", "a", a.token), /catalog lock first/);
  store.catalogRelease("a", catalog.token);
  store.catalogAcquire("s2", "b", b.token);
  assert.equal(store.read().stacks[0].lock.token, a.token);
});

test("interrupted build recovery requires evidence and preserves building state", (t) => {
  const { store, registration } = fixture(t);
  const stack = store.register(registration(), "old");
  const evidence = { ledger: stack.ledger, ownerStopped: true, gitOperationsClear: true, remoteReconciled: true, summary: "Stopped old owner; clean worktrees; verified remote heads." };
  assert.throws(() => store.recover("s1", stack.lock.token, "new", { ...evidence, ownerStopped: false }), /Recovery requires/);
  assert.throws(() => store.recover("s1", stack.lock.token, "new", { ...evidence, ledger: "/wrong" }), /ledger/);
  const resumed = store.recover("s1", stack.lock.token, "new", evidence);
  assert.throws(() => store.recover("s1", stack.lock.token, "third", evidence), /token changed/);
  assert.equal(store.read().stacks[0].phase, "building");
  assert.equal(store.read().recoveries.length, 1);
  assert.throws(() => store.acquire("s1", "repair", "repair", url(1)), /owned/);
  store.ready("s1", "new", resumed.token);
});

test("registration preserves identities and rejects overlapping or replaced layers", (t) => {
  const { store, registration } = fixture(t);
  const old = store.register(registration(), "builder");
  assert.throws(() => store.register(registration("s2"), "another", undefined, true), /already belongs/);
  const replaced = registration(); replaced.layers[0].pr = url(9);
  assert.throws(() => store.register(replaced, "builder", old.lock.token), /replace PRs/);
  const moved = registration(); moved.layers.reverse();
  assert.throws(() => store.register(moved, "builder", old.lock.token), /reorder/);
  const outside = registration(); outside.layers[0].pr = "https://github.com/other/repo/pull/1";
  assert.throws(() => store.register(outside, "builder", old.lock.token), /outside/);
  assert.equal(canonicalPr("https://GitHub.com/Owner/Repo/pull/1/"), url(1));
});

function inventory(numbers, ended = false) {
  return { implementationEnded: ended, activeStackIds: [], prs: numbers.map((n) =>
    ({ url: url(n), state: "OPEN", headSha: `head-${n}`, baseSha: `base-${n}`, repairSignal: true, readComplete: true })) };
}

test("partially published batch runs ready stacks and includes upper PRs", (t) => {
  const { store, ready, registration } = fixture(t);
  ready("s1", [1, 2]);
  const building = registration("s2", [3]); building.layers[0].pr = null;
  store.register(building, "builder");
  const snapshot = inventory([1, 2]); snapshot.prs[0].repairSignal = false;
  const plan = planBatch(store.read(), "batch", snapshot);
  assert.deepEqual(plan.candidates.map((item) => item.pr), [url(2)]);
  assert.equal(plan.stop, false);
});

test("bottom-first scheduling re-evaluates upper signals after lower repair", (t) => {
  const { store, ready } = fixture(t); ready("s1", [1, 2]); ready("s2", [3]);
  const snapshot = inventory([1, 2, 3]);
  assert.deepEqual(planBatch(store.read(), "batch", snapshot).candidates.map((item) => item.pr), [url(1), url(3)]);
  const lock = store.acquire("s1", "attempt", "reserved", url(1));
  assert.deepEqual(planBatch(store.read(), "batch", snapshot).candidates.map((item) => item.pr), [url(3)]);
  store.release("s1", "attempt", lock.token);
  snapshot.prs[0].repairSignal = false;
  snapshot.prs[1].headSha = "restacked-head"; snapshot.prs[1].baseSha = "repaired-parent";
  snapshot.prs[1].repairSignal = false;
  assert.deepEqual(planBatch(store.read(), "batch", snapshot).candidates.map((item) => item.pr), [url(3)]);
  snapshot.prs[1].repairSignal = true;
  assert.equal(planBatch(store.read(), "batch", snapshot).candidates[0].headSha, "restacked-head");
});

test("complete terminal states end only a finished batch with no active ownership", (t) => {
  const { store, ready } = fixture(t); ready();
  const snapshot = inventory([1, 2]);
  snapshot.prs[0].state = "CLOSED"; snapshot.prs[1].state = "MERGED";
  assert.equal(planBatch(store.read(), "batch", snapshot).stop, false);
  snapshot.implementationEnded = true;
  assert.equal(planBatch(store.read(), "batch", snapshot).stop, true);
  snapshot.activeStackIds = ["s1"];
  assert.equal(planBatch(store.read(), "batch", snapshot).stop, false);
  snapshot.activeStackIds = [];
  snapshot.prs.pop();
  assert.equal(planBatch(store.read(), "batch", snapshot).complete, false);
  assert.deepEqual(planBatch(store.read(), "batch", snapshot).candidates, []);
  snapshot.prs.push({ ...inventory([2]).prs[0], readComplete: false });
  assert.equal(planBatch(store.read(), "batch", snapshot).stop, false);
  snapshot.prs.push(inventory([99]).prs[0]);
  assert.throws(() => planBatch(store.read(), "batch", snapshot), /unrelated/);
});

test("interrupted registry transactions fail closed and recover only with explicit evidence", (t) => {
  const { store, ready } = fixture(t); ready();
  mkdirSync(store.gatePath);
  assert.equal(store.status().transaction.token, "incomplete");
  assert.throws(() => store.acquire("s1", "a", "repair", url(1)), /transaction busy/);
  const evidence = { ownerStopped: true, gitOperationsClear: true, remoteReconciled: true, summary: "All helpers stopped; state inspected; remote outcomes known." };
  assert.throws(() => store.recoverGate("wrong", evidence), /token changed/);
  store.recoverGate("incomplete", evidence);
  store.acquire("s1", "a", "repair", url(1));
  assert.equal(store.status().transaction, null);
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cli(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("real linked worktrees share state and concurrent CLI acquisitions have one winner", async (t) => {
  const { dir, registration } = fixture(t);
  const repo = join(dir, "repo"), worktree = join(dir, "linked"); mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const input = join(dir, "registration.json"); writeFileSync(input, JSON.stringify(registration()));
  const registered = await cli(repo, ["register", "--file", input, "--owner", "builder", "--published"]);
  assert.equal(registered.code, 0, registered.stderr);
  const original = JSON.parse((await cli(repo, ["status"])).stdout);
  const linked = JSON.parse((await cli(worktree, ["status"])).stdout);
  assert.equal(original.root, linked.root);
  const lookup = await cli(worktree, ["lookup", "--pr", url(2)]);
  assert.equal(JSON.parse(lookup.stdout).stacks[0].id, "s1");
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(i % 2 ? repo : worktree,
    ["acquire", "--stack", "s1", "--owner", `attempt-${i}`, "--mode", "repair", "--pr", url(i % 2 + 1)])));
  assert.equal(outcomes.filter((item) => item.code === 0).length, 1);
  assert.ok(outcomes.filter((item) => item.code !== 0).every((item) => item.code === 75));
  const final = JSON.parse((await cli(worktree, ["status"])).stdout);
  assert.equal(final.stacks[0].lock.mode, "repair");
  assert.equal(final.transaction, null);
  assert.equal(JSON.parse(readFileSync(join(final.root, "state.json"), "utf8")).stacks.length, 1);
});
