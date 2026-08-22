import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDialog, promptIsEmpty } from '../src/lib/paneDialog.js';
import { sanitizePaneText } from '../src/lib/paneText.js';

// Every raw block below is a verbatim `tmux capture-pane -p` from a real,
// logged-in Claude Code session (measurement-dialogs.md, 21.08.2026),
// sanitised only for what CLAUDE.md forbids: this installation's
// deployment path, the session's real UUID, and the plan file's random
// slug were each swapped for an invented stand-in of the SAME character
// count, so every line keeps the column width it was captured at - the
// fold rule below decides "wrapped or not" by comparing a line's length
// to the pane's widest line, and a width change would silently stop the
// fixture from testing what it claims to. Do not reflow or re-indent
// these blocks; their line widths carry meaning, not just their text.
// `sanitizePaneText` is applied inside each test exactly as the pane
// route applies it, so every test runs the same pipeline `readDialog`/
// `promptIsEmpty` see in production. Two of the nine (A1b, the
// 40-column resize; A5-surprise, the unexplained prefilled prompt) had
// no `sanitizePaneText()` block transcribed in the measurement - their
// clean text is derived here by running the real function, not invented.

// A1 - Read permission box, 120 columns, `permission_mode: default`.
const A1_RAW = `
╭─── Claude Code v2.1.238 ─────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                        │
│                 Welcome back <Name>!                │ Run /init to create a CLAUDE.md file with instructions for Cla… │
│                                                    │ ─────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                      │
│                      ▝▜██████▀                     │ Added a \`keybindingFlavor\` setting: set it to \`"readline"\` to … │
│                        ▝▝ ▝▝                       │ Plugin marketplaces: \`headersHelper\` on a url marketplace or a… │
│                                                    │ A catalog entry's \`headersHelper\` runs only when you install o… │
│  Opus 5 with xhigh effort · Claude API · <Org> │ /release-notes for more                                         │
│                 /…/scratchpad/proj                 │                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯


❯ Read the file /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt with the
  Read tool. Do nothing else.

  Read 1 file

✻ Sautéed for 1m 21s

❯ Read /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt with the Read tool.
  Nothing else.

● Reading 1 file…
  ⎿  /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Read file

  Read(/tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside during
      this session
   3. No

 Esc to cancel · Tab to amend
`;

// A1b - the same box, mid-resize to 40 columns: still the OLD 120-column
// wrap, hard-cut at column 40 (measured: several unrelated lines are cut
// at exactly the same column, the tell that this is a stale render, not a
// fresh 40-column layout).
const A1B_RAW = `
╭─── Claude Code v2.1.238 ──────────────
│
│                 Welcome back <Name>!
│
│                       ▐▛███▛█
│                      ▝▜██████▀
│                        ▝▝ ▝▝
│
│  Opus 5 with xhigh effort · Claude API
│                 /…/scratchpad/proj
╰───────────────────────────────────────


❯ Read the file /tmp/claude-0/-var-workd
  Read tool. Do nothing else.

  Read 1 file

✻ Sautéed for 1m 21s

❯ Read /tmp/claude-0/-var-workdir/754b6a
  Nothing else.

● Reading /tmp/claude-0/-var-workdir/754
  ⎿  /tmp/claude-0/-var-workdir/754b6a9a

────────────────────────────────────────
 Read file

  Read(/tmp/claude-0/-var-workdir/754b6a

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /tmp/claud
      this session
   3. No

 Esc to cancel · Tab to amend
`;

// A2 - `AskUserQuestion`, 120 columns. Options 4 and 5 ("Type
// something.", "Chat about this") are the terminal's own, not the
// model's; a horizontal rule the raw text uses to separate option 4 from
// option 5 is removed by `sanitizePaneText`, so the clean text shows 1-5
// as one block.
const A2_RAW = `❯ Read /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt with Read. Nothing
  else.

● Der Read-Aufruf auf diesen Pfad wird zweimal in Folge von der Berechtigungsebene abgelehnt — ich bekomme jedes Mal nur
  „The user doesn't want to proceed with this tool use" zurück, ohne Dateiinhalt. Ein drittes identisches Ausführen
  würde am selben Punkt scheitern, deshalb halte ich hier an.

  Der Pfad liegt außerhalb des Arbeitsverzeichnisses (/tmp/claude-0/-var-workdir/.../scratchpad/proj), outside/ ist eine
  Ebene daneben. Das ist die wahrscheinliche Ursache.

  Mögliche Wege:
  - /add-dir /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside — dann ist das
    Verzeichnis freigegeben und der Read geht durch
  - Beim nächsten Berechtigungsdialog „Allow" wählen, falls einer erscheint
  - Alternativ die Datei per ! cat
    /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt selbst ausgeben — der
    Inhalt landet dann direkt in der Konversation

  Sag mir, welchen Weg du willst, dann lese ich sofort erneut.

✻ Cogitated for 11s

❯ Ask me a question with the AskUserQuestion tool. Ask which colour I prefer, with three options.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Farbe

Welche Farbe bevorzugst du?

❯ 1. Blau
     Kühl und ruhig — Klassiker für Oberflächen und Diagramme.
  2. Grün
     Frisch und natürlich — signalisiert Erfolg und Wachstum.
  3. Rot
     Warm und auffällig — hoher Kontrast, zieht Aufmerksamkeit.
  4. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// A3 - `ExitPlanMode`, 120 columns, with the plan's own numbered steps
// sitting earlier in the same pane. This is the capture that produced the
// original bug: six `OPTION_LINE` matches, keys 1-3 duplicated, the plan
// steps winning because they come first.
const A3_RAW = `

▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔

  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Ready to code?

   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   README.md für proj/ anlegen

   Kontext

   Das Verzeichnis /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/proj enthält bisher nur
   notes.txt (Inhalt: hallo) und keinerlei Beschreibung. Eine README.md soll erklären, wozu das Verzeichnis dient
   und was notes.txt enthält.

   Schritte

   1. Inhalt von notes.txt als Grundlage auswerten.
   2. README.md mit Titel, Zweck und Dateiübersicht schreiben.
   3. Datei erneut lesen und Angaben gegenprüfen.

   Verifikation

   ls -la zeigt README.md; der Read-Inhalt stimmt mit dem tatsächlichen Verzeichnisstand überein.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌




  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback

   ctrl+g to edit in Vim · ~/.claude/plans/sleepy-wandering-otter.md`;

// A3b - the same plan-confirmation box, rebuilt at 40 columns. Its own
// footer wraps onto two lines, and its own hint row wraps too.
const A3B_RAW = `  - /add-dir /tmp/claude-0/-var-workdir/
    754b6a9a-184a-46b3-8baa-7dc2d0e76ce9
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔

  ────────────────────────────────────
   Ready to code?

   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   README.md für proj/ anlegen

   Kontext

   Das Verzeichnis /tmp/claude-0/-var
   -workdir/754b6a9a-184a-46b3-8baa-7
   dc2d0e76ce9/scratchpad/proj
   enthält bisher nur notes.txt
   (Inhalt: hallo) und keinerlei
   Beschreibung. Eine README.md soll
   erklären, wozu das Verzeichnis
   dient und was notes.txt enthält.

   Schritte

   1. Inhalt von notes.txt als
      Grundlage auswerten.
   2. README.md mit Titel, Zweck und  ↓
  ────────────────────────────────────
   Claude has written up a plan and
   is ready to execute. Would you
   like to proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with
        this feedback

   ctrl+g to edit in Vim · ~/.claude/
   plans/sleepy-wandering-otter.md`;

// A4 - a plain Bash permission box, 120 columns, with an unrelated
// REJECTED plan sitting above it in scrollback. Proves the bug in A3
// was never about `ExitPlanMode` specifically - any numbered list earlier
// on the pane produces it.
const A4_RAW = `  ⎿  User rejected Claude's plan:
     ╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
     │ README.md für proj/ anlegen                                                                                     │
     │                                                                                                                 │
     │ Kontext                                                                                                         │
     │                                                                                                                 │
     │ Das Verzeichnis /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/proj enthält bisher  │
     │ nur notes.txt (Inhalt: hallo) und keinerlei Beschreibung. Eine README.md soll erklären, wozu das Verzeichnis    │
     │ dient und was notes.txt enthält.                                                                                │
     │                                                                                                                 │
     │ Schritte                                                                                                        │
     │                                                                                                                 │
     │ 1. Inhalt von notes.txt als Grundlage auswerten.                                                                │
     │ 2. README.md mit Titel, Zweck und Dateiübersicht schreiben.                                                     │
     │ 3. Datei erneut lesen und Angaben gegenprüfen.                                                                  │
     │                                                                                                                 │
     │ Verifikation                                                                                                    │
     │                                                                                                                 │
     │ ls -la zeigt README.md; der Read-Inhalt stimmt mit dem tatsächlichen Verzeichnisstand überein.                  │
     ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

✻ Churned for 2m 48s

❯ Run the command 'ls -1 /var/log' with the Bash tool. Nothing else.

  Listing files in /var/log
  ⎿  $ ls -1 /var/log

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command

   ls -1 /var/log
   List files in /var/log

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /var/log from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain`;

// A5 - three negative controls, all 120 columns: a genuinely idle pane
// with an empty input line, a busy pane mid-turn, and an idle pane whose
// input line holds text nobody typed (a prefilled suggestion the
// measurement could not explain, kept as evidence that `promptIsEmpty`
// must judge only the text actually on the line, not why it is there).
const A5IDLE_RAW = `
╭─── Claude Code v2.1.238 ─────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                        │
│                 Welcome back <Name>!                │ Run /init to create a CLAUDE.md file with instructions for Cla… │
│                                                    │ ─────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                      │
│                      ▝▜██████▀                     │ Added a \`keybindingFlavor\` setting: set it to \`"readline"\` to … │
│                        ▝▝ ▝▝                       │ Plugin marketplaces: \`headersHelper\` on a url marketplace or a… │
│                                                    │ A catalog entry's \`headersHelper\` runs only when you install o… │
│  Opus 5 with xhigh effort · Claude API · <Org> │ /release-notes for more                                         │
│                 /…/scratchpad/proj                 │                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯


❯ Read the file /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside/data.txt with the
  Read tool. Do nothing else.

  Read 1 file

✻ Sautéed for 1m 21s














                                                                                                     ◉ xhigh · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ▱▱▱▱▱▱▱▱▱▱ Context 4% | 5h (17:10): 16% | 7d (1d): 52% | Opus 5 (1M context) | claudux
  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;

const A5BUSY_RAW = `  dreizehn
  vierzehn
  fünfzehn
  sechzehn
  siebzehn
  achtzehn
  neunzehn
  zwanzig
  einundzwanzig
  zweiundzwanzig
  dreiundzwanzig
  vierundzwanzig
  fünfundzwanzig
  sechsundzwanzig
  siebenundzwanzig
  achtundzwanzig
  neunundzwanzig
  dreißig
  einunddreißig
  zweiunddreißig
  dreiunddreißig
  vierunddreißig
  fünfunddreißig
  sechsunddreißig
  siebenunddreißig
  achtunddreißig
  neununddreißig
  vierzig

✻ Crunched for 7s

❯ List the numbers one to sixty in words, one per line.

✢ Finagling…

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ▱▱▱▱▱▱▱▱▱▱ Context 4% (48k) | 5h (17:10): 21% | 7d (1d): 52% | Opus 5 (1M context) | claudux
  ⏸ manual mode on · ← for agents`;

const A5SURPRISE_RAW = `  neunundzwanzig
  dreißig
  einunddreißig
  zweiunddreißig
  dreiunddreißig
  vierunddreißig
  fünfunddreißig
  sechsunddreißig
  siebenunddreißig
  achtunddreißig
  neununddreißig
  vierzig
  einundvierzig
  zweiundvierzig
  dreiundvierzig
  vierundvierzig
  fünfundvierzig
  sechsundvierzig
  siebenundvierzig
  achtundvierzig
  neunundvierzig
  fünfzig
  einundfünfzig
  zweiundfünfzig
  dreiundfünfzig
  vierundfünfzig
  fünfundfünfzig
  sechsundfünfzig
  siebenundfünfzig
  achtundfünfzig
  neunundfünfzig
  sechzig

✻ Cogitated for 4s

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ now to one hundred
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ▱▱▱▱▱▱▱▱▱▱ Context 4% (49k) | 5h (17:10): 22% | 7d (1d): 52% | Opus 5 (1M context) | claudux
  ⏸ manual mode on · ← for agents`;

test('A1: permission box, 120 columns - keys match the box, the wrapped label is whole', () => {
  const clean = sanitizePaneText(A1_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Yes' },
    {
      key: '2',
      label: 'Yes, allow reading from /tmp/claude-0/-var-workdir/754b6a9a-184a-46b3-8baa-7dc2d0e76ce9/scratchpad/outside during this session',
    },
    { key: '3', label: 'No' },
  ]);
  assert.equal(dialog.mirrored, clean);
  assert.equal(promptIsEmpty(clean), false);
});

// Measured limit, not a bug this module can fix: the box itself is still
// showing its stale 120-column wrap, hard-cut at column 40. Option 2's
// own visible text is already truncated mid-path before the fold ever
// runs - folding the wrap-continuation onto it cannot recover what the
// resize cut away. The wrap signal (this option's line sits within a few
// characters of the pane's widest line) still correctly fires, because it
// really was the option that wrapped; it just wrapped from a truncated
// starting point. Whoever wires the route already knows this window
// exists (the pane redraws with a delay after a resize).
test('A1b: same box mid-resize, 40 columns - truncation survives the fold, by design', () => {
  const clean = sanitizePaneText(A1B_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'Yes, allow reading from /tmp/claud this session' },
    { key: '3', label: 'No' },
  ]);
  assert.equal(promptIsEmpty(clean), false);
});

test('A2: AskUserQuestion, 120 columns - description rows stay out of the labels', () => {
  const clean = sanitizePaneText(A2_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Blau' },
    { key: '2', label: 'Grün' },
    { key: '3', label: 'Rot' },
    { key: '4', label: 'Type something.' },
    { key: '5', label: 'Chat about this' },
  ]);
  assert.equal(dialog.mirrored, clean);
  assert.equal(promptIsEmpty(clean), false);
});

test('A3: ExitPlanMode with a numbered plan above it, 120 columns - the plan steps do not leak in', () => {
  const clean = sanitizePaneText(A3_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Yes, and use auto mode' },
    { key: '2', label: 'Yes, manually approve edits' },
    { key: '3', label: 'Tell Claude what to change' },
  ]);
  assert.equal(dialog.mirrored, clean);
  // No input line anywhere on this pane, which is neither "empty" nor
  // "occupied" - the caller has to be able to tell those apart.
  assert.equal(promptIsEmpty(clean), null);
});

test('A3b: same plan-confirmation box, 40 columns - open without relying on its own (unmatched) footer', () => {
  const clean = sanitizePaneText(A3B_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Yes, and use auto mode' },
    { key: '2', label: 'Yes, manually approve edits' },
    { key: '3', label: 'Tell Claude what to change' },
  ]);
  // No input line anywhere on this pane, which is neither "empty" nor
  // "occupied" - the caller has to be able to tell those apart.
  assert.equal(promptIsEmpty(clean), null);
});

test('A4: Bash permission box with an unrelated rejected plan above it, 120 columns - keys are not duplicated', () => {
  const clean = sanitizePaneText(A4_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'Yes, allow reading from /var/log from this project' },
    { key: '3', label: 'No' },
  ]);
  assert.equal(dialog.mirrored, clean);
  assert.equal(promptIsEmpty(clean), false);
});

test('A5: idle pane with a genuinely empty input line reports no dialog', () => {
  const clean = sanitizePaneText(A5IDLE_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.deepEqual(dialog.options, []);
  assert.equal(dialog.mirrored, '');
  assert.equal(promptIsEmpty(clean), true);
});

test('A5: busy pane mid-turn reports no dialog', () => {
  const clean = sanitizePaneText(A5BUSY_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.equal(promptIsEmpty(clean), true);
});

// Measured surprise, not explained: the input line held text nobody
// typed. Whatever put it there, the line was not empty, and the correct
// answer stays false - the safe direction for a feature that would
// otherwise send ArrowUp + Ctrl+U into it.
test('A5: idle pane with unexplained prefilled text reports no dialog and a non-empty prompt', () => {
  const clean = sanitizePaneText(A5SURPRISE_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.equal(promptIsEmpty(clean), false);
});

// A composer line that starts with a number and a period matches
// `OPTION_LINE` with a selection marker exactly like a real dialog's
// first option does - built from the real idle capture (A5IDLE_RAW)
// with only the empty prompt line replaced, everything else, including
// the status gauge that follows it with no blank line in between, is
// the same measured text. Without the status-gauge check this reported
// `open: true` with the typed text as an option - a real regression the
// fix in this round closes, not a hypothetical.
const A5_COMPOSER_NUMBER_RAW = A5IDLE_RAW.replace('❯ \n', '❯ 1. fix the bug\n');

test('A5: a composer line starting with a number and a period is not a dialog', () => {
  const clean = sanitizePaneText(A5_COMPOSER_NUMBER_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.deepEqual(dialog.options, []);
});

// The shape a person is most likely to actually type: a numbered list
// as the body of a message, which is a RUN (two contiguous numbered
// lines), not a single stray line - so it has to be checked separately
// from the one above rather than assumed to fail the same way.
const A5_COMPOSER_LIST_RAW = A5IDLE_RAW.replace(
  '❯ \n',
  '❯ 1. first thing\n  2. second thing\n',
);

test('A5: a numbered list typed as a message is not a dialog either', () => {
  const clean = sanitizePaneText(A5_COMPOSER_LIST_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.deepEqual(dialog.options, []);
});

// The same list once it has been SENT, which is where the two tests above
// miss: Claude Code draws a submitted message with its own `❯ ` prefix, puts
// the continuation lines of a hard line break at column 0 rather than
// indenting them, and follows the whole message with a blank line. That
// blank line is exactly the gap `runEndsInABox` asks for, so the message
// reads as a box and the view locks its composer behind a card nobody can
// answer. Derived from a real pane capture, not constructed.
const A5_SENT_LIST_RAW = A5IDLE_RAW.replace(
  '❯ \n',
  '❯ 1. first thing\n2. second thing\n\n  Read 1 file\n\n❯ \n',
);

test('A5: a numbered list already SENT is not a dialog either', () => {
  const clean = sanitizePaneText(A5_SENT_LIST_RAW);
  const dialog = readDialog(clean);
  assert.equal(dialog.open, false);
  assert.deepEqual(dialog.options, []);
  // The input line is back under the message, which is the whole signal:
  // while a box really stands there is none (see A3b).
  assert.equal(promptIsEmpty(clean), true);
});

// Not from a real capture: no measured box lacks numbered options
// entirely, but the footer is still the only path to `open` for a shape
// this module does not otherwise recognise, and that escape hatch is
// worth keeping covered.
test('readDialog mirrors the box even when it recognises nothing but the footer', () => {
  const strange = 'Something new is on screen\n  with no numbers at all\nEsc to cancel';
  const dialog = readDialog(strange);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.options, []);
  assert.equal(dialog.mirrored, strange);
});

test('readDialog reports no dialog for an ordinary screen with no footer and no run', () => {
  const idle = '● Reading /etc/hostname\n  ⎿  fine\n❯ \n  manual mode on';
  const dialog = readDialog(idle);
  assert.equal(dialog.open, false);
  assert.equal(dialog.mirrored, '');
});

test('promptIsEmpty reads the LAST prompt line, not the first', () => {
  const withDraft = '❯ 1\nsome output\n❯ a draft someone typed';
  const empty = '❯ 1\nsome output\n❯ ';
  assert.equal(promptIsEmpty(withDraft), false);
  assert.equal(promptIsEmpty(empty), true);
});

// Not `false`: a caller refusing on false names the input line in its
// message, and there is none here to clear.
test('promptIsEmpty says it cannot tell when there is no prompt line at all', () => {
  assert.equal(promptIsEmpty('no prompt here'), null);
});
