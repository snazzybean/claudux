// What the terminal is asking, read off the pane text. Deliberately two
// jobs and no more: is a box open, and which key picks which option. The
// content of a permission dialog comes from the hook instead, which is
// structured - but the hook payload does not say which NUMBER an option
// has, and the box carries options the model never asked for ("Type
// something.", "allow reading from /etc during this session"). So the
// numbering can only come from here.
//
// No `question` field: no rule for "where the question sits" holds across
// the box shapes. A permission box has no blank line between question and
// options, `AskUserQuestion` and `ExitPlanMode` do, and at narrow widths a
// wrapped footer moves the anchor either way. Nothing reads the field
// either - the card takes its title from the hook payload (the question
// text for `AskUserQuestion`, the whole plan for `ExitPlanMode`, tool and
// arguments for a permission) and falls back to `mirrored` for anything
// else. A field that is both unreliable and unread is worse than none.
//
// It lives on the server because it can silently be wrong: src/ is
// test-driven, public/ has no test touching it.

// "❯ 1. Yes" for the selected option, "  2. No" for the others. Any
// amount of leading whitespace is accepted on purpose: an unselected
// option's indent is not consistent relative to the selected one - same as
// it in a permission box, deeper in an `ExitPlanMode` confirmation - so the
// pattern has to tolerate both rather than assume either.
const OPTION_LINE = /^(\s*)(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;

// The two closing lines a real pane actually carries. Case matters for
// `Esc to cancel`: a lowercase `esc to cancel` shows up inside an unrelated
// status line ("Usage limit reached … · esc to cancel"), and matching that
// would mirror the pane where the terminal is otherwise idle.
const DIALOG_FOOTER = /Esc to cancel|ctrl\+g to edit in Vim/;

// The input line. A pane can hold several of these (an answered dialog
// leaves its own behind), so only the last one is the current input.
const PROMPT_LINE = /^❯(.*)$/;

function leadingSpaces(line) {
  return line.match(/^\s*/)[0].length;
}

// How many blank lines sit between `index` and the next non-blank line -
// `-1` if nothing non-blank follows at all.
function blankGapAfter(lines, index) {
  const rest = lines.slice(index + 1);
  const nextIdx = rest.findIndex((l) => l.trim() !== '');
  return nextIdx;
}

// The open dialog, if there is one, is the last thing on the pane - so
// its options are the LAST contiguous run of numbered lines. "Contiguous"
// lets an unnumbered line extend the run only while it sits deeper than
// the option it hangs off; that is what keeps an old plan's numbered steps,
// sitting earlier in the same scrollback, out of a later box's run. Without
// it the two merge into one run with its keys duplicated, and the plan's
// text wins them.
//
// The same shape covers a wrapped label's own continuation AND an
// `AskUserQuestion` description or an `ExitPlanMode` hint - indentation
// alone does not tell them apart, so this only decides what belongs to
// the run. Which of those get folded into a label is decided afterwards.
function findLastOptionRun(lines) {
  const runs = [];
  let current = null;
  let anchorIndent = 0;

  lines.forEach((line, i) => {
    const match = line.match(OPTION_LINE);
    const contiguous = current !== null && current.at(-1).lineIndex === i - 1;

    if (match) {
      const entry = {
        type: 'option',
        lineIndex: i,
        selected: Boolean(match[2]),
        key: match[3],
        label: match[4],
        indent: match[1].length,
        lineLength: line.length,
      };
      current = contiguous ? current : [];
      if (current.length === 0) runs.push(current);
      current.push(entry);
      anchorIndent = entry.indent;
      return;
    }

    if (contiguous && line.trim() !== '' && leadingSpaces(line) > anchorIndent) {
      current.push({ type: 'sub', lineIndex: i, text: line.trim() });
      return;
    }

    current = null;
  });

  return runs.at(-1) ?? [];
}

// A sub-line only gets folded into the label above it when the option's
// own line sits close to the widest line anywhere on the pane - the actual
// physical reason a line wraps. An option that really wrapped sits within a
// few characters of that width; an `AskUserQuestion` description or an
// `ExitPlanMode` hint sits far short of it however deep it is indented,
// which is exactly why indentation cannot be the signal that decides this.
const WRAP_SLACK = 4;

export function readDialog(paneText) {
  const text = String(paneText ?? '');
  const lines = text.split('\n');
  const maxLineLength = lines.reduce((max, l) => Math.max(max, l.length), 0);

  const run = findLastOptionRun(lines);
  const runEndsAt = run.length > 0 ? run.at(-1).lineIndex : -1;
  // A dialog's run sits inside a box, so a blank line separates its last
  // line from the footer. The composer's `❯` line has none to give up:
  // Claude Code frames it with a rule made of `LINE_CHARS` immediately
  // below, which `sanitizePaneText` strips, collapsing that gap to zero.
  // That is what tells the two apart, including where the composer holds a
  // `❯`-led run of its own ("❯ 1. fix the bug"). It depends only on the
  // stripping, not on what (if anything) is configured to draw below the
  // composer - a differently configured status line, or none at all, still
  // leaves the rule for `sanitizePaneText` to remove.
  //
  // Nothing non-blank following the run at all is treated the same as a
  // zero gap: an unlocked composer with no card is the safer wrong guess
  // than a locked one with a dialog that is not there.
  const gap = blankGapAfter(lines, runEndsAt);
  const runEndsInABox = gap >= 1;
  const hasSelected = run.some((entry) => entry.type === 'option' && entry.selected)
    && runEndsInABox;

  // No selected marker inside the run means it is not the active box -
  // most likely a numbered list sitting in scrollback, or text someone
  // typed or sent that happens to start with a number and a period. A
  // recognised footer can still mean a box is open (the escape hatch for
  // a shape this module does not otherwise recognise); it never supplies
  // options.
  if (!hasSelected) {
    const footerSeen = DIALOG_FOOTER.test(text);
    return { open: footerSeen, options: [], mirrored: footerSeen ? text : '' };
  }

  const grouped = [];
  for (const entry of run) {
    if (entry.type === 'option') grouped.push({ ...entry, subs: [] });
    else grouped.at(-1)?.subs.push(entry.text);
  }

  const options = grouped.map(({ key, label, lineLength, subs }) => {
    const wrapped = subs.length > 0 && lineLength >= maxLineLength - WRAP_SLACK;
    return { key, label: wrapped ? [label, ...subs].join(' ') : label };
  });

  return { open: true, options, mirrored: text };
}

// Three answers, because "there is no input line on this pane" is not the
// same as "there is one and it has something on it". A caller that refuses
// on both can say so with the same sentence; one that names the input line
// would send someone looking for text that is not there.
export function promptIsEmpty(paneText) {
  const lines = String(paneText ?? '').split('\n');
  const promptLines = lines.filter((l) => PROMPT_LINE.test(l));
  if (promptLines.length === 0) return null;
  const rest = promptLines.at(-1).match(PROMPT_LINE)[1];
  return rest.trim() === '';
}
