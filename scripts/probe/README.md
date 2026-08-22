# Agent-window probe

No automated test touches `public/` (see `CLAUDE.md`), which for the agent
windows meant every question about them - do the lines cross, does a pulse
move, does a close button work - was answered by looking at a screenshot.
That missed five real defects in a row: lines left on screen after their
windows closed, the terminal's tab bar swallowing clicks meant for a window,
a raise-to-front that re-inserted the element and thereby ate the click on
its own close button, a click on a title bar counting as a drag, and a
window reopening itself a moment after being closed.

This drives the real page in a real browser and measures instead.

    node scripts/probe/fixture.mjs <home> <data> <count>   # agents on disk
    <start the server against that home/data, auth off>
    node scripts/probe/browser.mjs <port> <out> <WxH> <project> [transcript]

It needs Playwright, which is NOT a dependency of this project. `paths.mjs`
searches the npx cache for it (`~/.npm/_npx/*/node_modules/playwright`) rather
than naming a directory: the cache folder is a hash of the install. Where it
finds none, install Playwright in a scratch directory first; nothing in
`npm test` depends on any of this.

Nothing under here knows where this checkout lives either - `paths.mjs`
derives the repository root from its own location and the home directory from
the passwd entry (`os.homedir()` answers with an empty string when `$HOME` is
set but empty, which is the state of a fresh shell here).

`crossings.mjs` needs no browser at all: `agentLayout.js` touches no DOM, so
the routes can be assembled in node and measured. That is how two wrong shapes
and four wrong lane orderings were caught rather than shipped - each time
after reasoning had said they were fine.

    node scripts/probe/crossings.mjs

The fixture writes an isolated `CLAUDE_HOME` whose agents read as running,
against a tmux session that really exists (the watcher skips dead ones), and
a copy of the data directory. It never touches the real one.

# Conversation-view probe

Same reason, same shape: `conversation.mjs` drives the third tab on the real
page and measures it. Each check prints PASS or FAIL with the value it
measured, the run ends with a ratio, and it exits non-zero if anything failed
- all of them run, so one failure does not hide the other nine. A failed
PRECONDITION stops the run instead, because with no session row or no
transcript everything below it would be reporting on nothing.

    node scripts/probe/fixture.mjs <home> <data> 2
    <start the server against that home/data, auth off, own ports>
    node scripts/probe/conversation.mjs <port> <data>

The fixture's second half builds what this needs: two tmux sessions of its
own (never a live one - a second ttyd client resizes whoever else's session
it attaches to), an invented project and account, a `permission-hook.key` so
the probe can derive the hook secret, and one transcript carrying every shape
the view has to get right - a second root, an abandoned sibling, thinking, a
tool call with its result, a diff, three `Agent` calls that resolve three
different ways, a TodoWrite and a queue with two entries. It writes
`<data>/probe-conversation.json`, which is the only argument beyond the port:
the carriers and the transcript path are made there and would drift if they
were named twice. The environment the server needs is the one `browser.mjs`
uses, plus `ACCOUNTS_SECRET_PATH=<data>/accounts.json`.

The probe appends to that transcript, so a second run wants a fresh fixture -
rebuild it and run again, the server can stay up. The fixture kills the tmux
sessions of the PREVIOUS run rather than its own, so nothing has to be torn
down between the two; `tmux kill-session` on the two names in that json is the
manual way out at the end.

What it measures: three tabs inside a 320px phone with each of them
tappable; the terminal hidden rather than unloaded, with `window.term`
surviving the round trip; an abandoned branch gone while the segment before a
second root stays; thinking collapsed AND still reachable by the page search
(the whole "no search bar in version one" cut rests on that one, so it runs a
nonsense string past `window.find` first and refuses to believe a hit
otherwise); the queue; an appended line arriving, with the nodes kept, an open
foldout still open and the scroll not moving; a poll window cut at the
server's event cap being re-read rather than stitched onto; the dialog card in
four shapes - including a 168-character title, five options and a plan -
each measured at `--app-height: 400px` for clipping and for whether the last
answer and both keys can actually be tapped; the three answers a subagent card
can give; and a session with no transcript, whose 404 is expected rather than
counted as a defect.

One thing is substituted, and only this one: the pane. It comes from
`page.route` with an invented capture put through the real `sanitizePaneText`
and `readDialog`, because this throwaway session runs a shell rather than
`claude`, so there is no box on its pane to read - and a capture taken at the
browser's own width would parse differently at each width the run visits
(`readDialog` folds a wrapped label against the widest line on the pane). The
hook payload is not substituted: it goes to the real `/api/permission/:id`
with the real derived secret, which is why the fixture has to write
`permission-hook.key` up front - `createPermissionStore` only creates it
inside the POST handler.

Nothing is stubbed in `conversation.js` itself, deliberately: a probe that
serves its own copy of the module can only ever measure that copy.

What it does not cover: sending (the composer pushes keys into ttyd's iframe,
which needs a real `claude` behind it), answering a box for real, `/clear`,
paging upwards, and anything about how it looks. Those stay with the
live acceptance on the device.

Like `browser.mjs` it resolves Playwright from the npx cache and is no part of
`npm test`. `eslint .` does cover both, and every other `.mjs` in here: the
config has an entry for `scripts/**/*.mjs` with the browser globals merged in
beside the node ones, because the `page.evaluate` bodies are written in these
files and run in the page.
