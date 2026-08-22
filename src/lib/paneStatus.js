// Claude Code's own status line, read off the pane: "Beaming… (1m 4s · ↓ 3.5k
// tokens)" while it works, "Cooked for 3m 0s" once it is done. The words are
// its own and they change; nothing here invents any.
//
// It lives on the server for the same reason paneDialog.js does: reading
// terminal text can silently be wrong, and src/ is the half with tests.
//
// The leading glyph is dropped rather than passed on. It cycles through at
// least `✽ ✢ ✻ *` and it is a character picked by a program that knows its own
// font - this interface has repeatedly had such characters come out as empty
// boxes on a phone, which is why its icons are inline svg only.

// Two shapes, and the second is not a variant of the first: a turn in flight
// carries an elapsed time in brackets, a finished one carries the word "for".
// The glyph is required. Every measured line has one, and demanding it is what
// keeps an ordinary sentence starting with a capitalised word out - a future
// version that stops drawing it costs the line, which is the harmless
// direction.
const GLYPH = String.raw`[^\s\w]{1,2}[ \t]+`;
const RUNNING = new RegExp(`^[ \\t]*${GLYPH}([A-Z][a-z]+(?:…|\\.\\.\\.)[ \\t]*\\(.+\\))[ \\t]*$`);
const DONE = new RegExp(`^[ \\t]*${GLYPH}([A-Z][a-z]+ for [\\d]+[\\dhms .]*)[ \\t]*$`);

// The LAST match on the pane, not the first: the line sits at the bottom, and
// a conversation above it can hold anything.
export function readPaneStatus(paneText) {
  const lines = String(paneText ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const running = lines[i].match(RUNNING);
    if (running) return { text: running[1].trim(), working: true };
    const done = lines[i].match(DONE);
    if (done) return { text: done[1].trim(), working: false };
  }
  return null;
}

// The permission mode, off the same pane. Claude Code states it in its status
// bar - "auto mode on (shift+tab to cycle)" - and that is the CURRENT one,
// unlike the transcript, which only records the mode a submitted prompt ran
// under and so lags behind every switch by a message.
//
// The literal " on (shift+tab to cycle)" is what anchors it. A tip line reads
// "Tip: Hit shift+tab to cycle between manual mode, ..." and would otherwise
// match; requiring the " on (" in front keeps it out.
const MODE = new RegExp(`^[ \\t]*${GLYPH}([a-z][a-z ]*?) on \\(shift\\+tab to cycle\\)`);

// No line at all is an answer and not a failure: in its default mode Claude
// Code draws none, and that mode is the one its own tip line calls "manual".
// Only a pane with no text at all says nothing - a session that has gone.
export function readPaneMode(paneText) {
  const text = String(paneText ?? '');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(MODE);
    // "auto mode" -> "auto", while "accept edits" has no such tail to drop:
    // the badge should say what the terminal says.
    if (m) return m[1].replace(/ mode$/, '').trim();
  }
  return 'manual';
}
