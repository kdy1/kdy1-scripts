---
name: fork-gungraun-optimize
description: Update or configure Gungraun measurement infrastructure on a personal fork's default branch on top of the latest upstream code, then validate optimization PR candidates with profiles and benchmarks from fork CI. Use for ForkGungraunOptimize requests or performance optimization based on a personal fork. Create each upstream PR only after human approval of that candidate.
---

# Fork Gungraun Optimize

Profile a personal fork with Gungraun and validate optimization candidates.
First bring the Gungraun CI branch onto the latest upstream code: rebase existing infrastructure or configure it on a fresh upstream base. Integrate and verify it on the fork's default branch before proceeding.
A request to write or modify this skill is not itself a request to run optimizations.

The reference implementation is Gungraun Optimize in the [PrimJS comparison diff](https://github.com/lynx-family/primjs/compare/develop...kdy1:primjs:develop).
Read [references/fork-ci.md](references/fork-ci.md) when configuring CI for a repository.
Do not apply the reference repository's name, default branch, or build commands unchanged to another project.

## 1. Identify the fork and default branches

- Check repository instructions and user changes. Use GitHub metadata to verify the authenticated GitHub user, the actual personal fork, its parent upstream, and both repositories' default branches and SHAs. Do not assume that `origin` is the fork.
- Use the repository specified by the user, if any. Otherwise, identify it from the current repository and its fork relationship to the authenticated user. Ask only if you cannot determine the target among multiple forks. If no fork exists, report that fact and confirm the target.
- Fetch the verified upstream default branch and record its latest full SHA as the starting upstream revision. Fetch the fork branches as well. Check whether the Gungraun CI branch contains that upstream revision; existing CI files alone do not establish that its code is current.
- Inspect **files on the fork's remote default branch**. A workflow that exists only on a working branch does not establish readiness.
- Check the Gungraun harness, representative workloads, runnable fork-only CI, exact base/head comparisons, profiles with symbols, result and metadata artifacts, and parsers. Verify that an actual same-SHA comparison succeeds, not just that the files exist.
- Reuse adequate infrastructure. If it is partially complete, add only what is missing. Also check existing performance criteria and repository instructions.

## 2. Configure the required measurement infrastructure

An optimization execution request includes updating the Gungraun CI base to the latest upstream and any necessary setup of the fork's measurement infrastructure. Do not ask for approval unnecessarily before completing the preparation that you can do.

- If infrastructure exists on an older upstream base, create a task-owned copy of its branch and rebase its fork-only infrastructure commits onto the fetched upstream SHA. Resolve conflicts and adapt the harness and workflow to the updated code. Inspect the commit range first; do not replay unrelated fork changes as infrastructure or discard user changes.
- If infrastructure is absent, or replaying it would carry unrelated history, create a separate infrastructure branch directly from the fetched upstream SHA. Configure or transfer only the required Gungraun library or binary benchmark suited to the project, reproducible build, deterministic inputs and result assertions, base/head parser, and fork-only workflow.
- Verify that the pinned upstream SHA is an ancestor of the prepared CI branch and review its diff against upstream. Do not treat an unchanged CI branch on an older base as ready. If upstream advances during preparation, refresh the base before the initial validation, then pin it for the optimization session.
- Validate the infrastructure changes and integrate them into the fork's default branch. Use the repository's normal integration process, respecting protection rules and required approvals. Do not force-push or bypass protections. Publish rebased infrastructure under a new task-owned branch when updating the existing remote branch would require a force-push. After integration, verify that the remote default branch contains the pinned upstream SHA and the intended infrastructure. Do not submit fork CI configuration changes upstream.
- Before integration into the default branch, you may bootstrap through a push trigger restricted to the infrastructure branch. After integration, verify `workflow_dispatch` on the default branch and the actual artifacts.
- After the upstream update and infrastructure integration, compare the pinned starting upstream SHA as both base and head using the updated harness/workflow. Repeat this validation after any further base or infrastructure change. Verify successful completion, identical cases and inputs, the expected comparison results, function names, and self/inclusive costs. Resolve the cause of any differences. A same-SHA comparison is not an optimization result.
- Report actual blockers precisely, such as disabled Actions, permissions, runners, secrets, or protection rules. Request only the necessary user action. Do not evaluate performance until the infrastructure is usable.

## 3. Select a hypothesis from profiles

- Specify the fork repository in CI and artifact commands. Obtain comparative performance evidence from fork CI. Local runs may be used to check builds, correctness, and the harness.
- The default metric is Callgrind `Ir`. Before using other metrics, such as cache or allocation metrics, prepare the corresponding Gungraun tool and parser. Do not describe an `Ir` improvement as an execution-time improvement.
- Before changing code, fix the starting upstream SHA, harness/workflow SHA, toolchain, runner, build options, metrics, target/related/protected cases, and frequencies. If actual frequencies are unknown, use 1 for each case and state this explicitly.
- Read self/inclusive costs and call relationships in the initial profiles, then select one bottleneck hypothesis. Verify that the workload exercises that path. Fix any new workload first and apply it identically to both sides.
- Prefer focused changes to shared implementations. Preserve semantics, error behavior, ownership, and public compatibility. Do not claim effects on other platforms based only on the measured platform. Architecture-specific changes require a corresponding request and execution evidence.

## 4. Implement candidates and compare them in CI

- Implement the candidate and correctness tests on a branch owned by the task. Keep temporary benchmark changes and permanent fork infrastructure separate from the production changes to be submitted.
- Run relevant correctness tests and required repository checks. Do not claim that workload assertions alone verify overall correctness.
- Push the candidate branch to the verified fork remote. Dispatch fork CI with the exact full base/head SHAs, without creating an experimental PR.
- Restrict experimental and submission branches to branches owned by the task. Do not push optimization candidates directly to either repository's default branch.
- Cross-check the run ID, workflow SHA, comparison SHAs, cases and input hashes, features, tool versions, and artifact completion status. Do not select a run merely because it is the most recent. Missing, added, or renamed cases, or different inputs, make the results incomparable.
- A candidate that depends on previously accepted changes must pass both an incremental comparison against the most recently accepted revision and a cumulative comparison against the initial starting revision. One comparison is sufficient if the bases are identical.
- Review summaries and raw profiles together. A green CI run with valid results can still fail the performance criteria. Incomplete metadata or failed artifacts are not evidence of a pass.

## 5. Evaluate performance

For each comparison, calculate `score = sum(frequency * head) / sum(frequency * base)` and the improvement as `1 - score`.
Use only complete, positive counts. Also check per-case changes, weighted absolute changes, and the geometric mean as a supplementary metric.

- The default criteria are a portfolio improvement of **at least 1%**, regressions of **less than 1%** in every target/related case, and passing correctness checks. Apply these criteria to both incremental and cumulative comparisons.
- Preserve the reference skill's exceptions. An improvement below 1% may be accepted only if both portfolios improve, the code is equally simple or simpler, and every individual regression is below 1%.
- A regression of at least 1% but less than 3% in a single unprotected case may be considered if both portfolios improve by at least 5% each, the regression does not recur across the workload family, and the profiles explain its cause. Do not label this as a pass under the default criteria. Disclose the exception and tradeoff.
- A regression of at least 1% in a protected case, or at least 3% in any case, requires user judgment before publication. Reject an incremental portfolio deterioration or widespread regressions. Do not change cases, frequencies, or criteria after seeing the results to make a candidate pass.
- If results are near a threshold or profiles conflict with aggregate results, repeat the comparison once under identical conditions. If the repeat is inconsistent, withhold a conclusion. Distinguish infrastructure failures from performance regressions. Retry a transient infrastructure failure once, then report the blocker if it persists.

## 6. Prepare upstream PRs and obtain human approval

- Transfer only one accepted optimization and its correctness tests to a clean publication branch based on upstream. Check the full diff and ancestry for fork skills, workflows, harnesses, and unrelated fork commits.
- Verify that the measured production sources match the submission sources, and record the measured and submission SHAs. If a rebase, conflict resolution, or base change alters production content, remeasure the actual submission revision.
- Before requesting approval, complete the implementation, validation, comparisons, publication branch, and **exact PR title and body**. Present the upstream/base, fork head/branch/SHA, reviewable diff, run and artifact evidence, per-case numbers and assessment, correctness results, limitations, and tradeoffs.
- **Create each upstream PR only after explicit human approval. This also applies to draft PRs.** Authorization to run optimizations, passing performance criteria, or acceptance of a regression tradeoff does not itself authorize PR publication. Do not create a PR or delegate publication while awaiting approval.
- Record the approved repository/base/head SHA and content. Do not request approval again for the same proposal. If the implementation, target, or material PR content changes, finish validation and obtain approval for the revised proposal. Do not publish a rejected proposal.
- After approval, pass the explicit target repository, head repository, base, exact branch/SHA, checkout, and approval and validation evidence to the installed `$create-pr` skill, and create the PR as a **draft**. Do not let that skill infer the target from the default remote. If the skill is unavailable, preserve the candidate and evidence and report the missing publication dependency.
- Include the bottleneck and effect of the change, base/head metrics, individual regressions, portfolio results, run and artifact links with SHA mappings, actual tests, and measurement limitations in the PR. Follow contribution guidelines and AI-use disclosure requirements.
- Create separate PRs for independent candidates. Do not silently include earlier unmerged changes in later PRs. For dependent PRs, first resolve the constraint that the base must belong to the target repository. If the host provides a PR-linking tool, register the PR with the thread immediately after creation and check the list before finishing. Do not merge or enable auto-merge.

Continue examining evidence-based hypotheses within the user's requested scope. Do not force a candidate into existence.
Put a candidate on hold when approval is pending, results are incomparable, correctness fails, or user judgment is required.
After preserving evidence, clean up only temporary or rejected branches owned by the task. Keep permanent infrastructure and accepted candidate branches.
The final report must include infrastructure status, candidates awaiting approval or created PRs, exact measurements and CI links, test coverage, rejected attempts, and remaining blockers.
