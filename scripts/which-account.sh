#!/bin/sh
# Shows, for every running Claudux session, which account is actually
# active - determined from the real token in the process, not from a
# display.
#
# Needed because Claude Code's header line is misleading in this setup:
#
#   - "Claude API" describes the auth METHOD (via CLAUDE_CODE_OAUTH_TOKEN
#     instead of via a stored /login), not billing. A `claude setup-token`
#     token starts with sk-ant-oat and bills against the subscription it
#     belongs to; a real API key would have sk-ant-api.
#   - The displayed organization name comes from the cache in
#     ~/.claude.json, which the interactive login writes and token auth
#     does not update - it can belong to a completely different account.
#
# Only the token the process actually runs with is reliable. Matching goes
# through SHA-256 sums, so no full token is ever printed - the output shows
# the account name plus the first 13 characters, enough to tell two tokens
# apart by eye.
#
# Needs python3, sha256sum and /proc.
set -eu

# Same default as src/config.js - /var/lib/claudux needed sudo to create
# and doesn't exist on macOS at all.
ACCOUNTS="${ACCOUNTS_SECRET_PATH:-$HOME/.claudux/accounts.json}"

if [ ! -r "$ACCOUNTS" ]; then
  echo "accounts.json not readable: $ACCOUNTS" >&2
  exit 1
fi

found=0
for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
  pid="$(tmux list-panes -s -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1)"
  [ -n "$pid" ] && [ -r "/proc/$pid/environ" ] || continue

  tok="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p')"
  if [ -z "$tok" ]; then
    echo "  $sess: NO token set -> running via ~/.claude/.credentials.json"
    found=$((found + 1))
    continue
  fi

  prefix="$(printf '%s' "$tok" | cut -c1-13)"
  sum="$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)"
  name="$(ACC="$ACCOUNTS" SUM="$sum" python3 - <<'PY'
import hashlib, json, os
with open(os.environ["ACC"]) as f:
    data = json.load(f)
match = "UNKNOWN (not found in accounts.json)"
for entry in data.values():
    if not isinstance(entry, dict):
        continue
    if hashlib.sha256(entry.get("token", "").encode()).hexdigest() == os.environ["SUM"]:
        match = entry.get("name", "?")
        break
print(match)
PY
)"

  case "$prefix" in
    sk-ant-oat*) kind="subscription OAuth token (NO API billing)" ;;
    sk-ant-api*) kind="!!! API KEY - bills against credit balance !!!" ;;
    *)           kind="unknown format - probably ignored by Claude Code" ;;
  esac

  echo "  $sess"
  echo "      Account: $name"
  echo "      Kind:    $kind ($prefix…)"
  found=$((found + 1))
done

[ "$found" -gt 0 ] || echo "  (no running tmux sessions)"
