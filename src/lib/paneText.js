// The terminal content, as tmux outputs it, is awkward for the clipboard:
// Claude Code indents its text and draws separator lines, other TUIs frame
// their boxes. This function strips both away.
//
// It lives here and not in the frontend because it can silently be wrong:
// `src/` is test-driven, `public/` has no test touching it.
//
// The rule against indentation is explicitly a bet on a UI detail of Claude
// Code. If its indentation changes, it misses - which is why the interface
// offers the toggle to the raw version.

// Line-drawing characters TUIs build their frames and lines from. Kept
// deliberately narrow: block characters like ▁▂▃ belong to Claude Code's
// usage bar and appear in lines with real text that must not be dropped.
const LINE_CHARS = '─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬';
const LINE_ONLY = new RegExp(`^[\\s${LINE_CHARS}]*[${LINE_CHARS}][\\s${LINE_CHARS}]*$`);
// Only stripped when framed on BOTH sides - a one-sided match would cut up
// ASCII tables in the content. An optional space on each side belongs to
// the frame, not the content.
const TWO_SIDED_FRAME = /^(\s*)│ ?(.*?) ?│\s*$/;

export function sanitizePaneText(text) {
  const lines = String(text)
    .split('\n')
    .filter((line) => !LINE_ONLY.test(line))
    .map((line) => {
      const frame = line.match(TWO_SIDED_FRAME);
      const unframed = frame ? `${frame[1]}${frame[2]}` : line;
      // After the frame, not before: `  │ x │` carries both markers.
      const unindented = unframed.startsWith('  ') ? unframed.slice(2) : unframed;
      return unindented.replace(/\s+$/, '');
    });

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
