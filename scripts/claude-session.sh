#!/bin/sh
# Starts `claude` with the account token, WITHOUT the token ever appearing
# in a command line.
#
# argv is world-readable via /proc/<pid>/cmdline, while the process
# ENVIRONMENT (/proc/<pid>/environ) is readable only by the owner. This
# script exploits exactly that difference: the token comes in via a file
# with mode 0600, moves into the environment, and the file is deleted
# immediately.
#
# A dedicated script instead of a `sh -c "…"` string in argv, because
# tmuxManager.js never assembles a shell command line as a matter of
# principle - this way all values stay separate argv elements.
set -eu

tokenfile="$1"
shift

# The per-session secret the PermissionRequest hook proves itself with. Same
# handover as the token above and for the same reason: a FILE, whose path is
# what stands in argv. tmux keeps the start command for the life of the pane
# and /proc/<pid>/cmdline is world-readable, so the secret itself in this slot
# would be readable by every local account for days.
#
# The slot is always present, so it can never swallow one of claude's own
# options; `-` means this session runs without hooks. The guard around it is
# for callers that pass nothing but the token file - under `set -u` a bare
# `$1` would abort, and `[ … ] && shift` as a statement would abort under
# `set -e` on the false branch.
#
# A missing or unreadable secret file is NOT fatal, unlike the token below: a
# session without a hook runs perfectly well, it just has no card in the
# conversation view - while refusing to start would turn a cosmetic loss into
# no session at all. The file goes either way; nothing else reads it.
if [ $# -gt 0 ]; then
  if [ "$1" != "-" ]; then
    if [ -r "$1" ]; then
      CLAUDUX_SESSION_SECRET="$(cat "$1")"
      export CLAUDUX_SESSION_SECRET
    fi
    rm -f "$1"
  fi
  shift
fi

# Backfill HOME if it's missing: the tmux server inherits the service
# environment, and every session inherits that gap with it.
# Claude Code copes with it, shell hooks abort on it under `set -u`. This
# wrapper is the one place every session runs through - hence here and not
# in every hook individually.
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
  export HOME
fi

# Keeps the CLI's self-updater out of the way. Set here and not as
# Environment= in claudux.service: the tmux server inherits its environment
# once at startup and keeps it for its entire lifetime (the same property as
# with the locale) - a service restart doesn't reach it precisely because of
# KillMode=process. This wrapper runs fresh per session and is therefore the
# one place that reliably reaches every session.
DISABLE_AUTOUPDATER=1
export DISABLE_AUTOUPDATER

if [ ! -r "$tokenfile" ]; then
  # The `read` keeps the session open so the message stays visible. Without
  # it the tmux session dies in the same instant, and in the browser all
  # that's visible is a flicker - a silent death with no error message.
  echo "claude-session.sh: token file not readable: $tokenfile" >&2
  echo "The session cannot start without a token." >&2
  printf "\n>>> Enter to close <<<\n"
  read _ || true
  exit 1
fi

CLAUDE_CODE_OAUTH_TOKEN="$(cat "$tokenfile")"
export CLAUDE_CODE_OAUTH_TOKEN
# Remove immediately after reading: the file should only survive the
# moment between being written by the server and the session starting.
rm -f "$tokenfile"

# `exec` is NOT cosmetic: without it, the pane process would be this shell
# and `claude` its child. reaper.js decides via hasLiveChildrenForSession()
# based on the pane process's children - a permanently present child level
# would mean "always has live children", and the idle reaper would never
# clean up a session again. With `exec`, claude replaces this shell, and
# the process hierarchy stays exactly as before.
exec claude "$@"
