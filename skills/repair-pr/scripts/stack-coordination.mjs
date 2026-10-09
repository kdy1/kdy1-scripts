#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CoordinationError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function requireValue(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new CoordinationError(`Missing ${name}`);
  return value;
}

export function canonicalRepository(value) {
  const parts = requireValue(value, "repository (host/owner/repo)").toLowerCase().split("/");
  if (parts.length !== 3 || parts.some((part) => !/^[\w.-]+$/.test(part))) {
    throw new CoordinationError("Repository must be host/owner/repo");
  }
  return parts.join("/");
}

export function canonicalPr(value) {
  const url = new URL(requireValue(value, "PR URL"));
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !match) {
    throw new CoordinationError("Expected an HTTPS PR URL");
  }
  return `https://${url.hostname.toLowerCase()}/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`;
}

function repositoryOfPr(pr) {
  const url = new URL(pr);
  return `${url.hostname}/${url.pathname.split("/").slice(1, 3).join("/")}`;
}

const emptyState = () => ({ version: 1, stacks: [], catalog: null, recoveries: [] });

export class CoordinationStore {
  constructor(root) {
    this.root = root;
    this.statePath = join(root, "state.json");
    this.gatePath = join(root, "transaction");
  }

  read() {
    let state;
    try {
      state = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
    if (state.version !== 1 || !Array.isArray(state.stacks) || !Array.isArray(state.recoveries)) {
      throw new CoordinationError("Unsupported or corrupt coordination state; reconcile before writes");
    }
    return state;
  }

  transaction(action) {
    mkdirSync(this.root, { recursive: true });
    try {
      mkdirSync(this.gatePath);
    } catch (error) {
      if (error.code === "EEXIST") throw new CoordinationError("Registry transaction busy or interrupted; inspect status before retrying", 75);
      throw error;
    }
    const gate = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
    const temp = join(this.root, `state-${gate.token}.tmp`);
    try {
      writeFileSync(join(this.gatePath, "owner.json"), JSON.stringify(gate));
      const state = this.read();
      const result = action(state);
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
      renameSync(temp, this.statePath);
      return result;
    } finally {
      rmSync(temp, { force: true });
      rmSync(this.gatePath, { recursive: true });
    }
  }

  status() {
    let transaction = null;
    try {
      transaction = JSON.parse(readFileSync(join(this.gatePath, "owner.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An interrupted mkdir before owner.json is written is also a blocker.
      try {
        if (statSync(this.gatePath).isDirectory()) transaction = { token: "incomplete" };
      } catch (probe) {
        if (probe.code !== "ENOENT") throw probe;
      }
    }
    return { root: this.root, ...this.read(), transaction };
  }

  register(input, owner, token, published = false) {
    requireValue(owner, "owner");
    const repository = canonicalRepository(input.repository);
    const id = requireValue(input.id, "stack id");
    const batch = requireValue(input.batch, "batch id (use an existing-stack task id outside a batch)");
    const ledger = requireValue(input.ledger, "absolute ledger path");
    if (!ledger.startsWith("/") || !Array.isArray(input.layers) || input.layers.length === 0) {
      throw new CoordinationError("Registration requires an absolute ledger path and at least one layer");
    }
    const layers = input.layers.map((layer) => {
      const pr = layer.pr == null ? null : canonicalPr(layer.pr);
      if (pr && repositoryOfPr(pr) !== repository) throw new CoordinationError("PR is outside the registered repository");
      return { branch: requireValue(layer.branch, "layer branch"), headRepository: canonicalRepository(layer.headRepository ?? repository), pr };
    });
    if (published && layers.some((layer) => !layer.pr)) throw new CoordinationError("Published registration requires every PR");
    return this.transaction((state) => {
      const previous = state.stacks.find((stack) => stack.id === id);
      if (previous) {
        this.assertOwner(previous.lock, owner, token);
        if (previous.phase !== "building" || previous.repository !== repository || previous.batch !== batch || previous.ledger !== ledger) {
          throw new CoordinationError("Only the building owner may extend the same registration");
        }
        if (layers.length < previous.layers.length || previous.layers.some((old, i) =>
          old.branch !== layers[i].branch || old.headRepository !== layers[i].headRepository || (old.pr && old.pr !== layers[i].pr))) {
          throw new CoordinationError("Registration cannot remove or reorder existing layers or replace PRs");
        }
      }
      for (const stack of state.stacks) {
        if (stack.id === id) continue;
        if (stack.layers.some((old) => layers.some((layer) =>
          (old.headRepository === layer.headRepository && old.branch === layer.branch) || (old.pr && old.pr === layer.pr)))) {
          throw new CoordinationError(`Layer already belongs to stack ${stack.id}`);
        }
      }
      if (new Set(layers.map((layer) => `${layer.headRepository}/${layer.branch}`)).size !== layers.length ||
          new Set(layers.filter((layer) => layer.pr).map((layer) => layer.pr)).size !== layers.filter((layer) => layer.pr).length) {
        throw new CoordinationError("Duplicate layer identity");
      }
      const stack = previous ?? { id, batch, repository, ledger, phase: published ? "ready" : "building", lock: published ? null : this.newLock(owner, "build") };
      stack.layers = layers;
      if (!previous) state.stacks.push(stack);
      return stack;
    });
  }

  newLock(owner, mode, pr = null) {
    return { owner: requireValue(owner, "owner"), token: randomUUID(), mode, pr, createdAt: new Date().toISOString() };
  }

  stack(state, id) {
    const stack = state.stacks.find((item) => item.id === id);
    if (!stack) throw new CoordinationError(`Unknown stack ${id}`);
    return stack;
  }

  assertOwner(lock, owner, token) {
    if (!lock || lock.owner !== owner || lock.token !== token) throw new CoordinationError("Lock owner/token mismatch", 75);
  }

  acquire(id, owner, mode, pr) {
    if (!["repair", "edit", "reserved"].includes(mode)) throw new CoordinationError("Mode must be repair, edit, or reserved");
    pr = pr == null ? null : canonicalPr(pr);
    return this.transaction((state) => {
      const stack = this.stack(state, id);
      if (stack.phase !== "ready" || stack.lock) throw new CoordinationError(`Stack ${id} is ${stack.phase} or owned; no mutation permitted`, 75);
      if (!pr || !stack.layers.some((layer) => layer.pr === pr)) throw new CoordinationError("Lock requires a member PR URL");
      stack.lock = this.newLock(owner, mode, pr);
      return stack.lock;
    });
  }

  claim(id, token, pr, owner) {
    pr = canonicalPr(pr);
    return this.transaction((state) => {
      const stack = this.stack(state, id);
      if (stack.phase !== "ready" || stack.lock?.mode !== "reserved" || stack.lock.token !== token || stack.lock.pr !== pr) {
        throw new CoordinationError("Reservation does not match this PR/token", 75);
      }
      stack.lock = this.newLock(owner, "repair", pr);
      return stack.lock;
    });
  }

  ready(id, owner, token) {
    return this.transaction((state) => {
      const stack = this.stack(state, id);
      this.assertOwner(stack.lock, owner, token);
      if (stack.lock.mode !== "build" || stack.layers.some((layer) => !layer.pr)) throw new CoordinationError("Ready requires building ownership and all published PRs");
      if (state.catalog?.stack === id) throw new CoordinationError("Release the catalog lock first");
      stack.phase = "ready";
      stack.lock = null;
      return stack;
    });
  }

  release(id, owner, token) {
    return this.transaction((state) => {
      const stack = this.stack(state, id);
      this.assertOwner(stack.lock, owner, token);
      if (stack.phase !== "ready") throw new CoordinationError("An incomplete build must remain locked; resume it before ready");
      if (state.catalog?.stack === id) throw new CoordinationError("Release the catalog lock first");
      stack.lock = null;
      return stack;
    });
  }

  catalogAcquire(id, owner, token) {
    return this.transaction((state) => {
      this.assertOwner(this.stack(state, id).lock, owner, token);
      if (state.catalog) throw new CoordinationError("Shared gh-stack catalog is owned", 75);
      state.catalog = { ...this.newLock(owner, "catalog"), stack: id };
      return state.catalog;
    });
  }

  catalogRelease(owner, token) {
    return this.transaction((state) => {
      this.assertOwner(state.catalog, owner, token);
      state.catalog = null;
      return { released: true };
    });
  }

  evidence(input) {
    if (input.ownerStopped !== true || input.gitOperationsClear !== true || input.remoteReconciled !== true ||
        typeof input.summary !== "string" || !input.summary.trim()) {
      throw new CoordinationError("Recovery requires ownerStopped, gitOperationsClear, remoteReconciled, and a concrete summary");
    }
  }

  recover(id, token, owner, input, catalog = false) {
    this.evidence(input);
    return this.transaction((state) => {
      const stack = this.stack(state, id);
      const lock = catalog ? state.catalog : stack.lock;
      if (!lock || lock.token !== token || (catalog && lock.stack !== id)) throw new CoordinationError("Recovery token changed; reconcile again", 75);
      if (input.ledger !== stack.ledger) throw new CoordinationError("Recovery must identify this stack's ledger");
      if (!catalog && state.catalog?.stack === id) throw new CoordinationError("Recover and release the catalog lock first");
      const replacement = { ...lock, owner: requireValue(owner, "new owner"), token: randomUUID() };
      state.recoveries.push({ stack: id, catalog, previous: lock, replacement, evidence: input, at: new Date().toISOString() });
      if (catalog) state.catalog = replacement;
      else stack.lock = replacement;
      return replacement;
    });
  }

  recoverGate(token, input) {
    this.evidence(input);
    const gate = this.status().transaction;
    if (!gate || gate.token !== token) throw new CoordinationError("Transaction token changed; reconcile again", 75);
    // Caller must first establish that every old helper process is stopped.
    writeFileSync(join(this.root, `transaction-recovery-${randomUUID()}.json`), JSON.stringify({ gate, evidence: input }));
    rmSync(this.gatePath, { recursive: true });
    return { recovered: gate };
  }
}

export function planBatch(state, batch, inventory) {
  const stacks = state.stacks.filter((stack) => stack.batch === batch);
  if (!stacks.length) throw new CoordinationError(`Unknown batch ${batch}`);
  if (typeof inventory.implementationEnded !== "boolean" || !Array.isArray(inventory.prs) || !Array.isArray(inventory.activeStackIds)) {
    throw new CoordinationError("Inventory requires implementationEnded, prs, and activeStackIds");
  }
  const urls = stacks.flatMap((stack) => stack.layers.map((layer) => layer.pr).filter(Boolean));
  const snapshots = new Map();
  for (const pr of inventory.prs) {
    const url = canonicalPr(pr.url);
    if (!urls.includes(url) || snapshots.has(url)) throw new CoordinationError("Inventory contains an unrelated or duplicate PR");
    snapshots.set(url, pr);
  }
  const complete = urls.every((url) => {
    const pr = snapshots.get(url);
    return pr?.readComplete === true && ["OPEN", "CLOSED", "MERGED"].includes(pr.state) &&
      typeof pr.headSha === "string" && !!pr.headSha && typeof pr.baseSha === "string" && !!pr.baseSha &&
      typeof pr.repairSignal === "boolean";
  });
  const candidates = [];
  if (complete) for (const stack of stacks) {
    if (stack.phase !== "ready" || stack.lock || inventory.activeStackIds.includes(stack.id)) continue;
    const layer = stack.layers.find((item) => item.pr && snapshots.get(item.pr).state === "OPEN" && snapshots.get(item.pr).repairSignal);
    if (layer) candidates.push({ stack: stack.id, pr: layer.pr, headSha: snapshots.get(layer.pr).headSha, baseSha: snapshots.get(layer.pr).baseSha });
  }
  const stop = complete && inventory.implementationEnded && stacks.every((stack) =>
    stack.phase === "ready" && !stack.lock && !inventory.activeStackIds.includes(stack.id)) &&
    urls.every((url) => snapshots.get(url).state !== "OPEN");
  return { complete, candidates, stop };
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!name.startsWith("--") || Object.hasOwn(options, name.slice(2))) throw new CoordinationError(`Unexpected argument ${name}`);
    if (name === "--published" || name === "--catalog") options[name.slice(2)] = true;
    else options[name.slice(2)] = requireValue(rest[++i], name);
  }
  const allowed = {
    status: [], lookup: ["pr", "branch", "repository"], register: ["file", "owner", "token", "published"],
    acquire: ["stack", "owner", "mode", "pr"], claim: ["stack", "token", "pr", "owner"],
    ready: ["stack", "owner", "token"], release: ["stack", "owner", "token"],
    "catalog-acquire": ["stack", "owner", "token"], "catalog-release": ["owner", "token"],
    recover: ["stack", "token", "owner", "evidence-file", "catalog"],
    "recover-transaction": ["token", "evidence-file"], plan: ["batch", "file"],
  };
  if (!Object.hasOwn(allowed, command)) throw new CoordinationError(`Unknown command ${command}`);
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new CoordinationError(`Unknown option --${key}`);
  return { command, options };
}

function main() {
  if (process.argv.length === 2 || process.argv.includes("--help")) {
    process.stdout.write("Usage: stack-coordination.mjs <status|lookup|register|acquire|claim|ready|release|catalog-acquire|catalog-release|recover|recover-transaction|plan> [options]\nSee ../references/stack-coordination.md for arguments and recovery rules.\n");
    return;
  }
  const { command, options: o } = parseArgs(process.argv.slice(2));
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (git.status !== 0) throw new CoordinationError(git.stderr.trim() || "Not in a Git repository");
  const store = new CoordinationStore(join(git.stdout.trim(), "codex-stack-coordination"));
  const jsonFile = (file) => JSON.parse(readFileSync(requireValue(file, "JSON input file"), "utf8"));
  let result;
  switch (command) {
    case "status": result = store.status(); break;
    case "lookup": {
      if ((!o.pr && !o.branch) || (o.branch && !o.repository)) throw new CoordinationError("Lookup requires --pr or --branch with --repository");
      const pr = o.pr ? canonicalPr(o.pr) : null;
      const repository = o.branch ? canonicalRepository(o.repository) : null;
      const status = store.status();
      result = { root: status.root, transaction: status.transaction, stacks: status.stacks.filter((stack) => stack.layers.some((layer) =>
        (pr && layer.pr === pr) || (o.branch && layer.branch === o.branch && layer.headRepository === repository))) };
      break;
    }
    case "register": result = store.register(jsonFile(o.file), o.owner, o.token, o.published); break;
    case "acquire": result = store.acquire(o.stack, o.owner, o.mode, o.pr); break;
    case "claim": result = store.claim(o.stack, o.token, o.pr, o.owner); break;
    case "ready": result = store.ready(o.stack, o.owner, o.token); break;
    case "release": result = store.release(o.stack, o.owner, o.token); break;
    case "catalog-acquire": result = store.catalogAcquire(o.stack, o.owner, o.token); break;
    case "catalog-release": result = store.catalogRelease(o.owner, o.token); break;
    case "recover": result = store.recover(o.stack, o.token, o.owner, jsonFile(o["evidence-file"]), o.catalog); break;
    case "recover-transaction": result = store.recoverGate(o.token, jsonFile(o["evidence-file"])); break;
    case "plan": result = planBatch(store.read(), o.batch, jsonFile(o.file)); break;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`stack-coordination: ${error.message}\n`);
    process.exitCode = error.code && Number.isInteger(error.code) ? error.code : 1;
  }
}
