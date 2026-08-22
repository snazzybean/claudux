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
