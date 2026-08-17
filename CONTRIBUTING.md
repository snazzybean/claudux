# Contributing to Claudux

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites

- Node.js ≥ 22.15.0
- tmux (default socket, mouse mode off)
- ttyd — `npm start` spawns it itself, so it is a regular prerequisite, not
  just for end-to-end terminal testing. `npm run setup` checks for it.
  Developed against ttyd 1.7.7; the `-W` and `-t disableLeaveAlert=true`
  flags have to be understood, and a rejected flag only shows up on stderr.

A UTF-8 locale needs no manual setup: `src/lib/locale.js` picks a working
one per platform and passes it to the tmux/ttyd child processes itself.

### Setup

```bash
npm install
npm run setup
npm start
```

## Running Tests

```bash
# All tests
npm test

# Single test file
npm test -- test/tmuxManager.test.js

# Single test by name
npm test -- --test-name-pattern="buildNewSessionArgs appends --resume" test/tmuxManager.test.js
```

Go through `npm test` even for a single file. It runs `scripts/run-tests.sh`,
which points `TMPDIR` at a directory of its own and removes it afterwards —
including when the suite fails or you interrupt it. The tests create
hundreds of temp directories per full run and remove none of them; calling
`node --test` directly leaves every one of them behind, and a large enough
pile makes the suite unusably slow.

Tests live flat under `test/`, mostly one file per module in `src/lib` or
`src/routes`; the routers without one are covered by the `test/routes*.test.js`
files, one per route family, sharing their fixtures through
`test/helpers/routeHarness.js`.
Several start real tmux sessions — a working `tmux` on `PATH` is required,
not just for running Claudux itself — so `npm test` runs with
`--test-concurrency=1`. Keep it that way, and don't run a second `npm test`
in parallel; on a small box it can crash the whole machine, taking down
running sessions with it.

`public/` has no test suite — `npm run lint` and a manual check in the
browser are the only safeguard there.

## Code Style

- `src/lib` carries the logic, one responsibility per module, all under
  400 lines. `src/routes` stays HTTP only.
- `src/lib/tmuxManager.js` always builds tmux arguments as an array, never
  as a shell command line — that's what keeps session names and paths
  from turning into shell injection.
- `public/` has no build step: `app.js` and `public/js/*.js` are native ES
  modules, imported directly by the browser. The 400-line rule does not
  apply there, one responsibility per module still does.
- A module under `public/js/` never imports `app.js` back. What it needs
  from there arrives as a parameter — per call (`showFiles(project)`) or
  once at startup (`initAccounts`, `initManageDialog`). An `export let`
  that another module assigns doesn't reach the importer, and importing
  `app.js` would re-run its top-level side effects at an unpredictable
  point.
- Icons are exclusively inline SVG from `public/js/icons.js` — emoji and
  other special characters have shown up as empty boxes on real devices
  because the font was missing them. Exempted are the key-bar labels;
  those are key names, not symbols.
- Default to no comments. Add one only when the *why* isn't obvious from
  the code — a hidden constraint, a workaround for a specific bug,
  behavior that would otherwise surprise a reader. Comments describe
  conclusions, not measurements or incident timelines; those belong in
  the commit message.
- Run `npm run lint` before committing; it covers `src/`, `scripts/`,
  `test/` and `public/` under separate Node/browser globals.

## Commit Messages

Short, one-line messages with a type prefix, optionally scoped:

```
feat: clickable file paths in the terminal
fix: terminal path links - hover row offset, stray input
refactor: extract session-list rendering
style: soften the active-chat ring
docs: update installation instructions
chore: update dependencies
test: cover the /clear chain in sessionMeta
```

## Pull Requests

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. `npm test` is green and the working tree is clean
   before every commit — the project is built test-driven.
3. Run `npm run lint`.

   Every push and pull request runs `npm run lint` and `npm test` on GitHub
   Actions, and builds the container image for `linux/amd64` without
   pushing it (`.github/workflows/ci.yml`). A red run blocks nothing
   automatically — it is on you to read it.
4. Submit a PR with a clear description of what changed and why.

## Secrets

Account tokens start with `sk-ant-` and are easy to paste into a fixture by
accident. Test values that have to look like one are composed
(`'sk-ant-' + 'oat01-'`) rather than written out, so a scanner reading the
diff doesn't trip over them.

Token shapes are the easy half. Internal hostnames, paths and e-mail
addresses match no pattern and are on you — a public repo is unforgiving
about them.

## Reporting Issues

Use [GitHub Issues](https://github.com/snazzybean/claudux/issues) with a
clear description of what you expected and what happened instead.
