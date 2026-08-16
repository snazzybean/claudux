// Reads the progress of `claude setup-token` from the pane's text.
//
// The detection hinges on the WORDING of the CLI output, so it's not a
// stable contract - as in authStatus.js. That's acceptable, because a
// failure here only means the assistant doesn't jump ahead: the terminal
// stays available as a fallback, and the user can still get there manually.
import { LOGIN_DONE_MARKER } from './tmuxManager.js';

// tmux wraps long lines at the pane width, and `capture-pane -J` doesn't
// rejoin them here: Claude Code wraps its own output without setting the
// wrap flag that -J relies on. A token of roughly a hundred characters thus
// falls apart into fragments - and a fragment with the right prefix would
// be stored as a broken token, which Claude Code silently discards.
export function joinWrappedLines(text, paneWidth) {
  if (typeof text !== 'string') return '';
  if (!Number.isInteger(paneWidth) || paneWidth <= 0) return text;
  const lines = text.split('\n');
  const joined = [];
  // Measured against the RAW line, not the already-joined one: otherwise
  // the joined line would always be longer than the width and would pull
  // every following line in with it.
  let prevWasFull = false;
  for (const line of lines) {
    if (prevWasFull && joined.length > 0) joined[joined.length - 1] += line;
    else joined.push(line);
    prevWasFull = line.length === paneWidth;
  }
  return joined.join('\n');
}

// No version digit in the prefix, for the same reason as in
// routes/accounts.js: that setup-token outputs exactly "oat01" isn't
// guaranteed.
const TOKEN_PATTERN = /sk-ant-oat\d*-[A-Za-z0-9_-]+/;
const URL_PATTERN = /https:\/\/claude\.com\/\S+/;

// Whether a token is complete can't be seen at a glance - its length is
// nowhere guaranteed, and a fragment with the right prefix also passes the
// check in routes/accounts.js. Claude Code discards it silently later, and
// every session would then run unnoticed under the wrong login.
//
// Mechanically, though, the question is decidable. A fragment can only
// arise when `capture-pane` cuts the token off at the bottom edge of the
// screen - any wrap above that gets rejoined by joinWrappedLines(). And a
// truncated token necessarily ends on a full line, so its (joined) line
// measures an exact multiple of the pane width.
//
// If there's anything after the token, it's complete regardless.
function isComplete(screen, match, paneWidth) {
  const end = match.index + match[0].length;
  const lineEnd = screen.indexOf('\n', end);
  if (lineEnd !== -1 && lineEnd > end) return true; // text follows
  if (!Number.isInteger(paneWidth) || paneWidth <= 0) return true;
  const lineStart = screen.lastIndexOf('\n', match.index) + 1;
  const line = lineEnd === -1 ? screen.slice(lineStart) : screen.slice(lineStart, lineEnd);
  return line.length % paneWidth !== 0;
}

// Secondary net, not the real safeguard (LOGIN_DONE_MARKER is). Set well
// under any plausible token length, so a longer prefix (oat02, ...) still
// passes.
const MIN_TOKEN_LENGTH = 60;

// Backwards from the latest state: the token appears last and takes
// precedence even if the URL is still shown above it.
//
// There's deliberately NO phase for "the code is now due". The prompt
// `Paste code here if prompted >` is on screen from the start, right below
// the URL - it doesn't distinguish two states and would only cover up the
// URL the user needs at that moment. Only the user knows when they have the
// code; the assistant moves on a step for that.
export function readLoginScreen(text, paneWidth) {
  const screen = joinWrappedLines(text, paneWidth);

  const token = TOKEN_PATTERN.exec(screen);
  if (token) {
    // LOGIN_DONE_MARKER only appears once `claude setup-token` has exited
    // (see buildLoginSessionArgs), so it states directly that the output is
    // finished. Necessary, not sufficient: the shell command keeps running,
    // so a capture that cut the token off can still show the marker - hence
    // isComplete() as a second, independent check. It also catches a
    // mid-write capture that lands exactly at the pane's current width.
    const complete =
      screen.includes(LOGIN_DONE_MARKER) &&
      token[0].length >= MIN_TOKEN_LENGTH &&
      isComplete(screen, token, paneWidth);
    return { phase: 'token', token: token[0], complete };
  }

  const url = screen.match(URL_PATTERN);
  if (url) return { phase: 'url', url: url[0] };

  return { phase: 'starting' };
}
