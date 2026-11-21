# gh-bot-auth

`gh-bot-auth` makes `gh` and `git` act as a GitHub App bot in agent threads that you register, and leaves all other use of `gh` and `git` unchanged. Use it to run automations, such as `static-analysis` and `slop-fix-batch`, as a bot account instead of as your own account.

T3 Code scheduled tasks and subagents do not let you set environment variables. Thus `gh-bot-auth` selects the account per agent thread:

- A shim (`shim.sh`) replaces `gh` and `git` in `PATH`. It does a check for each command: if the current thread is registered, it gives the bot credentials to the real command. If not, it runs the real command unchanged.
- `gh-bot-auth activate` registers the current thread. The thread is the Codex thread (`CODEX_THREAD_ID`) when it is set, else the T3 Code thread (`T3CODE_THREAD_ID`). Claude Code subagents share the thread of their parent. Codex subagents have their own threads, so each one must run `activate` itself.

In a registered thread:

- `gh` gets `GH_TOKEN`, an installation access token for the owner of the target repository.
- `git` uses `gh-bot-auth git-credential` as the only credential helper for `https://github.com`, and changes SSH URLs of github.com to HTTPS. Commits get the bot as author and committer, without a signature.

Installation tokens expire after one hour. `gh-bot-auth` caches each token and gets a new one when less than 10 minutes remain, so long runs continue to work.

## Requirements

- Node.js 20 or later, and bash.
- A GitHub App with a private key. Give it the permissions that your automations need, for example Contents, Issues, and Pull requests (read and write), Checks and Actions (read), and Workflows (write) to push changes to `.github/workflows`.
- An installation of the app on each account or organization whose repositories the automations use.

Only `github.com` is supported. `gh` commands for other hosts run with your normal authentication.

## Set up

1. Put the private key of the app in a file that only you can read, for example `~/.config/gh-bot-auth/private-key.pem` with mode 600.
2. Write `~/.config/gh-bot-auth/config.json` (or set `GH_BOT_AUTH_CONFIG` to another path):

   ```json
   {
     "appId": 123456,
     "privateKeyPath": "~/.config/gh-bot-auth/private-key.pem",
     "defaultOwner": "your-login"
   }
   ```

   `appId` can also be the client ID of the app. `defaultOwner` is optional. See [Owner selection](#owner-selection).
3. Link the files into a directory that comes before the real `gh` and `git` in `PATH`, for example `~/.local/bin`:

   ```sh
   ln -s "$PWD/tools/gh-bot-auth/gh-bot-auth.mjs" ~/.local/bin/gh-bot-auth
   ln -s "$PWD/tools/gh-bot-auth/shim.sh" ~/.local/bin/gh
   ln -s "$PWD/tools/gh-bot-auth/shim.sh" ~/.local/bin/git
   ```

4. Run `gh-bot-auth status`. It shows the bot login, the installations, and whether the shims come first in `PATH`.

## Commands

| Command | What it does |
| --- | --- |
| `gh-bot-auth status [--json]` | Shows the configuration, the bot login, the installations, and the shims. |
| `gh-bot-auth activate [--repo OWNER/REPO]` | Registers the current thread. Prints JSON with `active: true`, or `active: false` and a reason, such as no configuration or shims that are not first in `PATH`. `--repo` sets the fallback owner for the thread. |
| `gh-bot-auth deactivate` | Removes the registration of the current thread. |
| `gh-bot-auth whoami [--human]` | Prints the bot login in a registered thread, else the login of your normal `gh` account. With `--human`, always prints your login. |
| `gh-bot-auth token [--owner OWNER \| --repo OWNER/REPO]` | Prints an installation token. |

The shims use `gh-token`, `identity`, and `git-credential` internally.

`GH_BOT_AUTH=0` forces your normal account for one command, and `GH_BOT_AUTH=1` forces the bot.

## Owner selection

An installation token gives access to the repositories of one installation, so each command must get the token for the owner of its target. The shim uses the first owner that it finds:

1. `GH_REPO`, then `-R`/`--repo`.
2. A `https://github.com/OWNER/...` URL in the arguments.
3. For `gh api`: the `repos/OWNER/`, `orgs/OWNER/`, or `users/OWNER/` endpoint, or an `owner`, `login`, `org`, or `repo` field.
4. A `repo:OWNER/REPO`, `org:OWNER`, or `user:OWNER` search qualifier.
5. The repository in the working directory, with the remote that `gh repo set-default` selected, else `upstream`, `github`, or `origin`.

For `git`, the owner is the first part of the URL path.

When the app has no installation for the owner, `gh-bot-auth` uses the installation for the `--repo` owner of the thread, then for `defaultOwner`, and writes a warning to stderr. That token can read public repositories, but writes to that owner fail.

## Limits

- Installation tokens cannot read `GET /user`. Use `gh-bot-auth whoami` to get the bot login.
- `@me` in GitHub searches refers to the token owner. In a registered thread, use the login from `gh-bot-auth whoami --human` to find your own issues or PRs.
- Tools that do not run `gh` or `git` from `PATH` keep your account, for example the T3 Code `pull_request_*` tools, or programs that call `/usr/bin/git` by its absolute path.
