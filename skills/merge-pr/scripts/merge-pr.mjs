#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const help = `Usage:
  node merge-pr.mjs resolve-current
  node merge-pr.mjs merge <PR_URL|number>... [--repo [HOST/]OWNER/REPO]
      [--no-auto] [--match-head-commit SHA]

Outputs JSON. Handoff options require exactly one PR.
The caller owns authorization, target selection, readiness gates, and stack progression.
Exit code: 0 for verified merged/pending results; 1 for errors or unverified results.
`;

function parseArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const [command, ...rest] = args;
  if (command === "resolve-current") {
    if (rest.length) throw new Error("resolve-current accepts no arguments");
    return { command };
  }
  if (command !== "merge") throw new Error("Expected resolve-current or merge; use --help for usage");
  const options = { command, targets: [], auto: true };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (["--repo", "--match-head-commit", "--no-auto"].includes(arg)) {
      if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(arg);
      if (arg === "--no-auto") options.auto = false;
      else {
        const value = rest[++i];
        if (!value || value.startsWith("-")) throw new Error(`Missing value for ${arg}`);
        if (arg === "--repo") {
          if (!/^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
            throw new Error("Expected --repo [HOST/]OWNER/REPO");
          }
          options.repo = value;
        } else {
          if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error("Expected a full 40-character head SHA");
          options.head = value;
        }
      }
    } else {
      if (arg.startsWith("-")) throw new Error(`Unsupported option: ${arg}`);
      if (!/^[1-9][0-9]*$/.test(arg) && !pullRequestIdentity(arg)) {
        throw new Error(`Expected a PR URL or positive PR number: ${arg}`);
      }
      options.targets.push(arg);
    }
  }
  if (!options.targets.length) throw new Error("At least one PR is required");
  if ((!options.auto || options.head) && options.targets.length !== 1) {
    throw new Error("Handoff options require exactly one PR");
  }
  return options;
}

function pullRequestIdentity(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !match) return null;
    return { host: url.host, repo: `${match[1]}/${match[2]}`, number: match[3] };
  } catch { return null; }
}

function repositoryIdentity(value) {
  if (!value) return null;
  const parts = value.split("/");
  return parts.length === 3
    ? { host: parts[0], repo: `${parts[1]}/${parts[2]}` }
    : { host: "github.com", repo: value };
}

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? (result.signal ? `Terminated by ${result.signal}` : null),
  };
}

function readJson(result) {
  if (result.exitCode !== 0 || result.error) {
    throw new Error(result.error || result.stderr.trim() || `gh exited with code ${result.exitCode}`);
  }
  const value = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a PR JSON object");
  return value;
}

function confirmsQueue(merge, url) {
  const identity = pullRequestIdentity(url);
  if (!identity) return false;
  // Only the CLI's explicit confirmation counts. Future queue eligibility does not.
  // https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/merge/merge.go
  const output = `${merge.stdout}\n${merge.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*(?:[!✓✔]\s+)?Pull request (\S+)#([1-9][0-9]*) is already queued to merge\s*$/);
    return match && match[1] === identity.repo && match[2] === identity.number;
  });
}

function attempt(target, options) {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const args = ["pr", "merge", target, "--squash"];
  if (options.auto) args.push("--auto");
  if (options.head) args.push("--match-head-commit", options.head);
  const merge = runGh([...args, ...repoArgs]);
  let identity = pullRequestIdentity(target);
  let lookup = null;
  if (!identity && options.repo) identity = { ...repositoryIdentity(options.repo), number: target };
  if (!identity) {
    lookup = runGh(["pr", "view", target, "--json", "url"]);
    try { identity = pullRequestIdentity(readJson(lookup).url); } catch { /* Preserve lookup failure as verification evidence. */ }
  }
  const verification = identity
    ? runGh(["api", "--hostname", identity.host, `repos/${identity.repo}/pulls/${identity.number}`])
    : lookup;
  const result = {
    target, url: pullRequestIdentity(target) ? target : null,
    outcome: "unverified", mergeCommitSha: null, state: null, mergedAt: null,
    autoMergeRequest: null, merge, verification: { ...verification, error: null },
  };
  try {
    if (!identity) throw new Error(lookup?.error || lookup?.stderr.trim() || "Cannot identify PR repository");
    const pr = readJson(verification);
    const actual = pullRequestIdentity(pr.html_url);
    if (!actual || actual.host !== identity.host || actual.repo.toLowerCase() !== identity.repo.toLowerCase() || actual.number !== identity.number) throw new Error("Missing or mismatched PR URL");
    result.url = pr.html_url;
    if (typeof pr.merged !== "boolean" || !["open", "closed"].includes(pr.state)) throw new Error("Missing or invalid PR state");
    result.state = pr.merged ? "MERGED" : pr.state.toUpperCase();
    result.mergedAt = pr.merged_at ?? null;
    result.mergeCommitSha = typeof pr.merge_commit_sha === "string" && pr.merge_commit_sha.trim() ? pr.merge_commit_sha : null;
    result.autoMergeRequest = pr.auto_merge ?? null;
    if (result.state === "MERGED") {
      if (!result.mergeCommitSha) throw new Error("Merged PR has no merge commit SHA");
      result.outcome = "merged";
    } else if (result.state === "OPEN" && confirmsQueue(merge, pr.html_url)) {
      result.outcome = "queued";
    } else if (result.state === "OPEN" && pr.auto_merge != null) {
      result.outcome = "auto_merge_pending";
    } else throw new Error("PR result is not confirmed as merged, queued, or auto-merge pending");
  } catch (error) { result.verification.error = error.message; }
  return result;
}

function main(args) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(help); return; }
  if (options.command === "resolve-current") {
    const lookup = runGh(["pr", "view", "--json", "url"]);
    let url = null;
    let error = null;
    try {
      const pr = readJson(lookup);
      if (!pullRequestIdentity(pr.url)) throw new Error("Missing or invalid current-branch PR URL");
      url = pr.url;
    } catch (failure) { error = failure.message; }
    process.stdout.write(`${JSON.stringify({ url, lookup, error }, null, 2)}\n`);
    process.exitCode = error ? 1 : 0;
    return;
  }
  const results = options.targets.map((target) => attempt(target, options));
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  process.exitCode = results.some((result) =>
    result.merge.exitCode !== 0 || result.merge.error || result.outcome === "unverified",
  ) ? 1 : 0;
}

try { main(process.argv.slice(2)); }
catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
