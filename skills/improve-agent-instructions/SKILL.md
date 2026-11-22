---
name: improve-agent-instructions
description: Audit a repository's agent instruction files (AGENTS.md, CLAUDE.md and scoped files) and workspace skills against the actual repository, CI and agent loading rules, then fix stale, missing or misleading guidance in separate verified commits. Use only when a human explicitly invokes $improve-agent-instructions or asks to improve the repository's agent instructions and skills so that AI agents work well.
disable-model-invocation: true
---

# Improve Agent Instructions

Make a repository's agent instructions and skills match the repository, so that agents run the right checks, find the right files and start skills only when they should. Fix only confirmed problems. Every change must be backed by evidence from the repository, its CI or the official agent documentation.

Run this skill only when a human explicitly invokes it. Editing, testing or reviewing this skill does not start it.

Write messages to the user in the language of the user's request. Write repository text in the language that the repository requires.

## Scope

- In scope: agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` and their scoped copies), repository-owned skills under `.agents/skills/`, `.claude/skills/` or `.codex/skills/`, and the repository documents that own the rules for these files.
- Out of scope: product source, CI workflows, imported skills and lock files. Imported skills are the entries in `skills-lock.json`; their content and hashes stay upstream. Report a problem in these files instead of changing it.
- Do not push, open a PR or post anything. When the human asks for a PR, use `$create-pr`.

## 1. Read the rules

1. Read the root instruction file and every scoped instruction file. Read the documentation catalog and the documents that the instructions name as owners of instruction, skill, validation, release and commit rules.
2. Record the repository's rules for this work: where each kind of rule lives (instruction file or contract document), rules against deleting or simplifying documentation, the required language, commit message format, formatter and pre-commit hooks.
3. Obey these rules in every later step. When a repository rule and this skill disagree, the repository rule wins.

## 2. Collect facts with the helper

Run the helper from any directory and save its JSON output in the task's temporary directory:

```sh
node <skill-dir>/scripts/audit.mjs audit <repository-path> > <tmp>/audit.json
```

The helper reads files only. It reports:

- `instructionFiles`: the instruction files and whether each one is a symlink.
- `skills`: each skill with its name, `imported` (listed in `skills-lock.json`), `explicitOnlyWording` (the description asks for explicit invocation), `disableModelInvocation` (Claude Code) and `codexImplicitInvocation` (`agents/openai.yaml`; `null` when the file does not exist).
- `packages`: workspace package directories, names and scripts. `nameDiffersFromDir` marks a package that a directory-name filter does not select.
- `ciCommands`: commands of `run:` steps in `.github/workflows/`, with `mentioned: false` when no instruction file contains the command key.
- `findings`: candidates of these kinds:
  - `claude-md-hides-agents-md`: a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` that neither imports nor links to `AGENTS.md`. Claude Code then reads it instead of the `AGENTS.md` files in that directory and below.
  - `skill-explicit-only-without-claude-setting` and `skill-explicit-only-without-codex-setting`: the description asks for explicit invocation, but an agent can still select the skill. The settings are `disable-model-invocation: true` in `SKILL.md` and `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
  - `skill-invocation-mismatch`: Claude Code and Codex differ about implicit invocation.
  - `skill-duplicate`: two directories with the same skill name.
  - `interactive-command`: an instruction tells agents to run a command that prompts in a terminal, such as `pnpm changeset`.
  - `unknown-package-filter`: a `--filter=` value that matches no package name.
  - `missing-path` and `broken-link`: a referenced path that does not exist.

Treat each finding as a candidate, not as a confirmed problem. For example, a `missing-path` can be a path that the documents mark as planned, and a path that an instruction forbids is not missing by mistake.

## 3. Check what the helper cannot

Compare each instruction with the repository. Check at least these areas:

1. **Loading.** Confirm how each agent that the repository supports reads its instruction files and skills. Read the current official documentation (for example the Claude Code memory and skills pages and the Codex `AGENTS.md` documentation); do not rely on memory, because loading rules change between versions. Check that each scoped rule sits where the agents load it.
2. **Validation commands.** For each source domain (for example Rust, Go, frontend, tooling scripts, workflows and schemas), compare the commands that the instructions tell agents to run with the commands that CI runs (`ciCommands`) and with the package scripts. Look for missing checks (for example a linter or formatter that only CI runs), commands that name only one of several packages, and filters that select nothing.
3. **Facts.** Check each concrete claim: file and script names, `dev` and `test` commands, package and project lists, tool versions and statements such as "every app does X". Open the files that the claim describes.
4. **Interactive steps.** For each command that prompts, check that the instructions give a way for an agent without a terminal: the file that the command writes, a non-interactive flag or a request to the human.
5. **Skills.** Check that each repository-owned skill's invocation settings match its description, that its referenced files and commands exist, and that the skill directories follow the repository's layout rules (for example a `.claude/skills` symlink to `.agents/skills`).
6. **Navigation.** Check that each scoped instruction file names the documents that own its directory, and that the root file routes to them.

Record each confirmed problem with its evidence: the file and line, the observed repository fact and the source of that fact.

## 4. Fix the confirmed problems

- Change the smallest text that fixes each problem. Keep the structure, voice and terms of the surrounding text.
- Put each rule in the file that the repository rules name as its owner. When a contract document owns the rule, change the document and keep the instruction file as a short pointer, as the repository already does.
- Do not delete, merge or simplify existing content unless it is confirmed wrong. When the intent of the existing text is not clear, ask the human before you change it.
- Before you document a command, run it, or run a dry run when it has side effects (for example `turbo run <task> --filter=<package> --dry=json`). Do not document a command that you could not run or confirm from CI.
- Do not add a `CLAUDE.md` to a repository that relies on `AGENTS.md` unless the repository rules ask for one. Check the current Claude Code loading rules first, because a `CLAUDE.md` can hide `AGENTS.md` files.
- Apply `$write-ste` to new prose when it is installed.

## 5. Commit

- Commit each coherent fix separately, for example one commit for the skill settings, one for the validation commands and one for one stale fact. Follow the repository's commit message rules.
- Before each commit, run the checks that apply to the changed files, at least the repository's formatter check. Let the pre-commit hooks run; never skip them.
- Stage only the files of that fix. Preserve unrelated changes in the checkout.

## 6. Report

Report in the user's language:

- A table with one row per commit: the commit, what changed and the evidence for it.
- The commands that you ran to verify the documented commands, with their results.
- The checks that you did not run, and why.
- Candidates that you did not fix, with the reason (for example planned paths, imported skills, CI changes or a decision that the human must make).
- An offer to publish the commits with `$create-pr`.
