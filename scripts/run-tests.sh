#!/bin/sh
# Runs the test suite inside a private temp directory that is removed
# afterwards.
#
# The tests create temp directories and never remove them. Handled here
# rather than per test file: os.tmpdir() honours TMPDIR, so one wrapper
# covers every call site, including future ones.
#
# No `set -e`: the suite's exit status has to survive the cleanup and reach
# npm, so it is captured explicitly below.
set -u

# mktemp -d never returns an empty string, which is what makes the rm below
# safe to write at all.
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/claudux-testrun-XXXXXX")"

# Also on Ctrl-C and on a failing suite - those are the runs that leaked
# most, because a test that throws skips its own cleanup.
cleanup() {
  count=$(find "$TMPROOT" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
  rm -rf "$TMPROOT"
  if [ "$count" -gt 0 ]; then
    echo "run-tests: removed $count temp entries" >&2
  fi
}
trap cleanup EXIT INT TERM

# Arguments select single files (`npm test -- test/foo.test.js`); without
# them the whole suite runs.
[ "$#" -gt 0 ] || set -- test/*.test.js

# --test-concurrency=1: the suite starts real tmux sessions, and a parallel
# run has crashed the host. Do not raise this.
status=0
TMPDIR="$TMPROOT" node --test --test-concurrency=1 "$@" || status=$?
exit "$status"
