#!/usr/bin/env bash
# gh-bot-auth shim for gh and git.
#
# Link this file as `gh` and as `git` in a directory that comes before the
# real gh and git in PATH. In a thread that `gh-bot-auth activate` registered,
# the shim runs the real command as the GitHub App bot. In all other cases it
# runs the real command unchanged. Keep it compatible with bash 3.2.

name=${0##*/}

# Print the first executable $name in PATH that is not this shim.
real_command() {
    local rest="$PATH:" dir
    while [ -n "$rest" ]; do
        dir=${rest%%:*}
        rest=${rest#*:}
        [ -n "$dir" ] || dir=.
        if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ] && ! [ "$dir/$name" -ef "$0" ]; then
            printf '%s\n' "$dir/$name"
            return 0
        fi
    done
    return 1
}

real=$(real_command) || {
    printf 'gh-bot-auth shim: no %s found in PATH after %s\n' "$name" "$0" >&2
    exit 127
}

# Keep these rules the same as threadKey() and threadRecord() in gh-bot-auth.mjs.
active=
case ${GH_BOT_AUTH:-} in
0) ;;
1) active=1 ;;
*)
    key=
    if [ -n "${CODEX_THREAD_ID:-}" ]; then
        key=codex-$CODEX_THREAD_ID
    elif [ -n "${T3CODE_THREAD_ID:-}" ]; then
        key=t3-$T3CODE_THREAD_ID
    fi
    case $key in
    '' | *[!A-Za-z0-9._:-]*) ;;
    *) [ -f "${XDG_STATE_HOME:-$HOME/.local/state}/gh-bot-auth/threads/$key" ] && active=1 ;;
    esac
    ;;
esac

[ -n "$active" ] || exec "$real" "$@"

case $name in
gh)
    token=$(gh-bot-auth gh-token -- "$@") || exit
    if [ -n "$token" ]; then
        GH_TOKEN=$token GH_BOT_AUTH_ACTIVE=1 exec "$real" "$@"
    fi
    exec "$real" "$@"
    ;;
git)
    identity=${XDG_STATE_HOME:-$HOME/.local/state}/gh-bot-auth/identity
    if [ ! -s "$identity" ]; then
        gh-bot-auth identity --shell >/dev/null || exit
    fi
    { IFS= read -r bot_name && IFS= read -r bot_email; } <"$identity" || exit
    export GIT_AUTHOR_NAME="$bot_name" GIT_AUTHOR_EMAIL="$bot_email"
    export GIT_COMMITTER_NAME="$bot_name" GIT_COMMITTER_EMAIL="$bot_email"

    # Add config entries after the ones that the environment already has.
    # The empty helper value removes the helpers of the config files.
    n=${GIT_CONFIG_COUNT:-0}
    add_config() {
        export "GIT_CONFIG_KEY_$n=$1" "GIT_CONFIG_VALUE_$n=$2"
        n=$((n + 1))
    }
    add_config credential.https://github.com.helper ''
    add_config credential.https://github.com.helper '!gh-bot-auth git-credential'
    add_config credential.https://github.com.useHttpPath true
    add_config url.https://github.com/.insteadOf git@github.com:
    add_config url.https://github.com/.insteadOf ssh://git@github.com/
    add_config commit.gpgSign false
    add_config tag.gpgSign false
    export GIT_CONFIG_COUNT=$n GH_BOT_AUTH_ACTIVE=1
    exec "$real" "$@"
    ;;
*)
    exec "$real" "$@"
    ;;
esac
