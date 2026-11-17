# Machine-wide agent instructions

## Temporary files in a T3 Code worktree

When the working directory is a T3 Code worktree (a path under
`~/.t3/worktrees/`), put everything temporary you create inside that
worktree, in `.t3-tmp/` at its root (`git rev-parse --show-toplevel`). This
covers scratch and review checkouts, `git worktree add` targets, skill run
directories, downloads, build and test output, and probe scripts. Settling
the thread deletes the worktree, and `.t3-tmp/` is deleted with it. Do not
put these files in `/tmp`, `$TMPDIR`, or any other path outside the
worktree: nothing deletes them there.

- Keep `.t3-tmp/` out of git before you put files in it. Create the
  directory first, then run `git check-ignore -q .t3-tmp`; the check fails
  for a directory that does not exist yet, even when it is ignored. If it
  fails, add the line `.t3-tmp/` to the file that
  `git rev-parse --git-path info/exclude` prints. Do not edit the
  repository's `.gitignore` for this.
- Run a script or skill helper that makes its own temporary directory with
  `TMPDIR="$(git rev-parse --show-toplevel)/.t3-tmp"`, so that its output
  also goes there. This applies even when the skill names another location.
- Create a linked checkout with
  `git worktree add --detach .t3-tmp/<name> <ref>`. A detached checkout
  holds no branch, so the entry that remains after the worktree is deleted
  blocks nothing, and `git worktree prune` removes it.
- If a tool that scans the whole worktree (a linter, a test runner, a
  workspace glob) reads files in `.t3-tmp/`, exclude that directory for the
  run. Do not move the files out of the worktree.
- When you work in a project root and not in a T3 Code worktree, settling
  deletes nothing. Use the system temporary directory there, and delete
  what you created before you finish.
