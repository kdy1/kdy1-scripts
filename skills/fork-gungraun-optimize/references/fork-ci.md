# Gungraun CI setup for personal forks

## Reference implementation

Inspected revision: `kdy1/primjs@dcb6d7bc964791577e9db3be8e777c27e5e209af`.

- [Original skill](https://github.com/kdy1/primjs/blob/dcb6d7bc964791577e9db3be8e777c27e5e209af/.agents/skills/gungraun-optimize/SKILL.md)
- [CI documentation](https://github.com/kdy1/primjs/blob/dcb6d7bc964791577e9db3be8e777c27e5e209af/.agents/skills/gungraun-optimize/references/gungraun-ci.md)
- [Workflow](https://github.com/kdy1/primjs/blob/dcb6d7bc964791577e9db3be8e777c27e5e209af/.github/workflows/gungraun.yml)
- [Harness directory](https://github.com/kdy1/primjs/tree/dcb6d7bc964791577e9db3be8e777c27e5e209af/tools/gungraun)

Read required reference files at the pinned revision. For other repositories, adapt the build, inputs, repository guard, and artifact metadata. When changing tool syntax or versions, check the official Gungraun and GitHub documentation.

## Choose a harness for the project

Rust libraries can use library benchmarks. Native programs, such as C/C++ programs, can use a small Rust binary benchmark driver to invoke the executable. Verify that Valgrind can measure the actual execution path on the selected Linux runner and target.

The reference uses Gungraun and runner `0.20.0`, Rust `1.95.0`, and Ubuntu `24.04`. Its infrastructure consists of Cargo.toml and a lockfile, benches/qjs.rs, build.sh, compare.py, report.py, fixtures/, and parser and input tests under `tools/gungraun/`. These versions and commands are reference examples, not fixed requirements for every project. Pin the selected versions consistently across the harness and runner, and validate the summary schema. The reference parser expects schema `7`.

PrimJS builds a release Linux x64 qjs_exe with tools/envsetup.sh, `hab sync . -f`, and GN/ninja. It disables snapshots, compatible memory management, and tracing GC. These results do not provide evidence for the disabled paths or ARM64 assembly.

Even with `symbol_level=2`, the regular out/gungraun/qjs is stripped. The measured executable is out/gungraun/exe.unstripped/qjs, with DWARF verified. The reference uses Ubuntu 24.04 because Valgrind 3.18 on Ubuntu 22.04 cannot read the reference Clang's DWARF 5. For other projects, also verify symbols and Valgrind compatibility through actual profiles.

The reference starter cases are arithmetic, objects, and strings. They do not represent the entire engine. Take workloads from the pinned workflow checkout and pass them identically to both binaries. Measurement covers the entire process, including startup, parsing, and teardown. To measure only a specific section, first define separate instrumentation and measurement boundaries.

## Workflow contract

- A fork repository guard and `contents: read` permissions. The benchmark job does not create PRs or comments. Checkouts do not persist credentials. Do not bypass fork restrictions with pull_request_target that executes candidate code or with write permissions.
- A workflow_dispatch registered on the default branch. Inputs include full base/head SHAs, a case filter, and any required workload inputs. During infrastructure setup, restrict push triggers to the infrastructure branch owned by the task.
- In a single run, check out, build, and measure the base and head sources separately with a pinned harness. Use identical inputs, toolchain, runner, and build options, and verify actual SHAs. If pinned dependencies differ, investigate before interpreting the effects.
- Metadata containing comparison SHAs, workflow SHA, run URL, tool versions, features, cases, input hashes, binary hashes, and harness hashes. Upload available artifacts even on failure and state whether they are complete.
- Per-case base/head counts, percentage changes, portfolio results, and assessments. Fail on missing, duplicate, or unexpected cases, unknown schemas, missing baselines, or counts of 0 or less. Distinguish failure to meet performance criteria from measurement execution failure.
- Preserve raw Callgrind profiles, Gungraun summaries, self/inclusive annotations, logs, the exact unstripped executable, and build options. The reference annotations use `callgrind_annotate --show=Ir --sort=Ir --threshold=100 --auto=no --tree=both --inclusive=no` and `--inclusive=yes` to retain function costs and call relationships. Functions that did not execute do not appear.
- Independent concurrency per run and bounded timeouts. Prevent incremental and cumulative runs from cancelling each other. Preserve the evidence required for approval before artifacts expire. The reference retention period is 30 days.

## Validation and execution

For configuration changes, run relevant checks, such as harness compilation, parser rejection of incomplete inputs and boundary-value tests, workload selection tests, workflow linting, and shell syntax checks. Then verify fork CI bootstrap and dispatch from the default branch. Do not claim that local compilation alone verifies Linux Valgrind execution.

The following is an example of the reference input contract. Set variables to actual verified values. If an existing workflow has a different contract, follow that contract.

```sh
gh workflow run gungraun.yml --repo "$FORK" --ref "$WORKFLOW_REF" \
  -f base_ref="$BASE_SHA" -f head_ref="$HEAD_SHA" -f filter="$CASE_FILTER"
gh run list --repo "$FORK" --workflow gungraun.yml \
  --event workflow_dispatch --branch "$WORKFLOW_REF" \
  --json databaseId,headSha,createdAt,status,url
gh run view "$RUN_ID" --repo "$FORK"
gh run download "$RUN_ID" --repo "$FORK" --dir "$EVIDENCE_DIR"
```

The reference custom input is `-f workloads='["path/to/workload.js"]'`. Paths refer to deterministic JS files within the pinned workflow checkout, executed without additional arguments. Normalized case IDs must be unique. For other projects, define the contract using that project's input format.

Record the dispatch time, workflow SHA, exact base/head, inputs, and run ID. Do not automatically reuse the most recent run. Use a bounded wait for the specified run. The host's PR watcher and benchmark run management are separate features.
