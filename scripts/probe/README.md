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

It needs Playwright, which is NOT a dependency of this project - the probe
resolves it from the npx cache (`/root/.npm/_npx/*/node_modules/playwright`).
Where that is missing, install it in a scratch directory first; nothing in
`npm test` depends on any of this.

`crossings.mjs` needs no browser at all: `agentLayout.js` touches no DOM, so
the routes can be assembled in node and measured. That is how two wrong shapes
and four wrong lane orderings were caught rather than shipped - each time
after reasoning had said they were fine.

    node scripts/probe/crossings.mjs

The fixture writes an isolated `CLAUDE_HOME` whose agents read as running,
against a tmux session that really exists (the watcher skips dead ones), and
a copy of the data directory. It never touches the real one.
