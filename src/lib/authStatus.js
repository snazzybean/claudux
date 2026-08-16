// Detects auth problems that only become visible in the tmux pane: if the
// login expires, the session stays put with a message, but the `claude`
// process keeps running, tmux reports the session as active, there's no
// exit code and no status file. The pane text is the only trace.
//
// Detection therefore hinges on the WORDING of the CLI output, i.e. no
// stable contract. Acceptable, because a miss only means Claudux doesn't
// show the state - no new harm. A hit therefore includes the matched spot
// (`matched`) so a wording change stays traceable.

// Order matters: the advance warning is checked FIRST, so a future wording
// that contained both markers wouldn't be wrongly reported as a hard
// expiry. Better to under-escalate a warning than show a working session
// as broken.
const PATTERNS = [
  // Informational, blocks nothing - but the only chance to act BEFORE
  // expiry.
  { kind: 'expiring', marker: 'run /login to renew' },
  // The stored login has expired: renewing helps.
  { kind: 'expired', marker: 'token has expired' },
  { kind: 'expired', marker: 'login expired' },
  // The token is wrong, not expired: renewing does NOT help, the stored
  // value needs to be corrected. Separate state so the UI doesn't suggest
  // the wrong step.
  { kind: 'invalid', marker: 'token is invalid' },
];

export function detectAuthProblem(paneText) {
  if (typeof paneText !== 'string') return null;
  // Whitespace normalization because capture-pane wraps at the terminal
  // width - in the narrow terminal on a phone, a message rarely stays on
  // one line.
  //
  // If tmux wraps MID-WORD, this doesn't catch it either. That's why the
  // markers are short core phrases instead of full sentences.
  const normalized = paneText.replace(/\s+/g, ' ').toLowerCase();
  for (const { kind, marker } of PATTERNS) {
    if (normalized.includes(marker)) return { kind, matched: marker };
  }
  return null;
}
