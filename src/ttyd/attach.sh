#!/usr/bin/env bash
# Run by ttyd as the "-a" target; $1 comes from ?arg=<name>.
#
# The two prechecks matter because ttyd respawns this script unthrottled: an
# instant exit turns into a runaway respawn loop. Holding with `read` keeps
# the message on screen and the process in place; a plain `sleep` would end
# it and produce ttyd's reconnect overlay instead.
set -euo pipefail

hold() {
  echo "$1" >&2
  printf "\n>>> Enter to close <<<\n"
  read -r _ || true
  exit 1
}

# Only the names Claudux issues: a session UUID or a `login-<hex>` one from
# the account login. A mere character class would let `?arg=<name>` attach
# WRITABLY to any session on the shared tmux socket, including ones Claudux
# never created and does not own.
#
# Second copy of the predicate in reaper.js (CLAUDUX_SESSION_NAME_RE) on
# purpose: this script is bash and cannot import from src/lib. Both have to
# be changed together - and the login form has to stay, or "Show terminal"
# in the account login has nothing to attach to.
CLAUDUX_SESSION='^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|login-[0-9a-fA-F]+)$'

SESSION="${1:-}"
if [[ ! "$SESSION" =~ $CLAUDUX_SESSION ]]; then
  hold "Not a Claudux session."
fi

# "=" makes the target an exact match: without it tmux falls back to prefix
# matching when no session has the exact name, and "abc" would attach to
# "abc-def". A pane target needs the trailing ":" for the "=" to be accepted.
if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  hold "This session no longer exists. Go back to the list and tap it again."
fi

# A dead pane means `claude` crashed while remain-on-exit kept the session.
# Attaching would be a dead end - the resume route is what replaces it.
if [[ "$(tmux display-message -p -t "=$SESSION:" '#{pane_dead}' 2>/dev/null)" == "1" ]]; then
  hold "This session crashed. Go back to the list and tap it again to restart it."
fi

exec tmux attach-session -t "=$SESSION"
