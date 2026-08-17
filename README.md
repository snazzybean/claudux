<img src="public/icons/icon-512.png" alt="" width="40" height="40">

# Claudux

**Claude Code sessions in a browser tab, phone included.**
tmux keeps the sessions alive, ttyd brings them into the browser, and an
Express server serves the interface and the API. Sessions run on an account
token from `claude setup-token`, so no API key is involved.

![Node ≥ 22.15.0](https://img.shields.io/badge/node-%E2%89%A5%2022.15.0-3c873a?logo=nodedotjs&logoColor=white)
![Auth: account token, no API key](https://img.shields.io/badge/auth-account%20token%2C%20no%20API%20key-e36209)
![License: MIT](https://img.shields.io/badge/license-MIT-2f81f7)
![Frontend: no build step](https://img.shields.io/badge/frontend-no%20build%20step-8957e5)

<p align="center">
  <img src="docs/images/desktop-sessions.png" alt="Projects and their sessions in the list on the left, a session open in the terminal on the right">
</p>

## What it does

The interface lists projects with their sessions, starts new ones and resumes
existing ones. Alongside that:

- **A key bar** for the keys a screen keyboard doesn't have: Esc, Tab, Ctrl,
  arrows.
- **Images from the clipboard**, pasted straight into the conversation.
- **Copying out of the terminal**, on a phone too, where a browser selection
  would come up empty.
- **Push notifications** when a session is waiting for input, via browser,
  ntfy or webhook — quiet while it is still working, and adjustable per
  project.
- **A usage popover** with context level and quota.
- **The project's files** in a second tab, readable and editable.
- **Sessions that outlive the browser**, because they live in tmux. A crash
  of `claude` no longer takes the session down with it.

Desktop and phone get the same features; what a small screen makes awkward
(no hover, no Ctrl key, a keyboard covering half the page) has its own answer
here rather than being left to the browser.

## Requirements

| | |
|---|---|
| Node.js | ≥ 22.15.0 |
| tmux | default socket, mouse mode **off** |
| ttyd | started by Claudux itself via `npm start`; developed against 1.7.7 |
| Claude Code | logged in with an account token from `claude setup-token`, not with an API key |

## Security

**A session in Claudux is an interactive shell as the user it runs as, with
an account token attached.** Everything the login protects follows from that
sentence.

There is a password in front of it. The first call to a fresh installation
asks for one and stores it as an scrypt hash in `~/.claudux/access.json`
(chmod 600, outside the checkout); after that both `/api/*` and the terminal
WebSocket need a session cookie.

**Sign in first, before anything else reaches the port.** Until a password is
set, the first caller sets it, and Claudux listens on every interface out of
the box — reaching a session from another device is what it is for, and an
interface only its own machine can talk to serves none of that.

The session lifetime is a setting in the Access tab: 7, 30, 180 or 365 days,
or none at all. It counts from the moment a device signs in, and shortening
it applies to devices that are already signed in. A password change signs
every device out.

`HOST` narrows that down where something else should stand in front:

| | |
|---|---|
| Reverse proxy on the same host | `HOST=127.0.0.1`, so only the proxy reaches the port |
| VPN or Tailscale | `HOST=<vpn-address>`, so only the VPN does |
| Trusted network | keep the default, with the password as what stands in front of the shell |

The login is one layer, not a reason to skip the network one. A firewall rule
that only admits the proxy costs nothing and keeps the port from answering
strangers at all.

`AUTH_ENABLED=false` switches the login off, for installations where a proxy,
a VPN or Tailscale already authenticates. Only that spelled-out value does;
an empty or missing one leaves the login on.

Set `User=`/`Group=` in the systemd unit to an unprivileged account. The
shipped unit does, and running as root gives that shell the whole machine.

## Setup

To use it, one command:

```sh
npx github:snazzybean/claudux
```

tmux and ttyd stay prerequisites — if one is missing, installing it is
offered, never done unasked. The Claude Code CLI is reported when it is
missing and installed separately, the way its own
[documentation](https://docs.claude.com/claude-code) describes.

Just to look at it, installing nothing:

```sh
docker run -p 4001:4001 \
  -v claudux:/home/claudux \
  -v ~/code:/projects \
  ghcr.io/snazzybean/claudux:latest
```

Both commands follow the moving target on purpose — `main` for npx, the
`latest` image tag, which only stable releases move. A fixed version takes a
suffix on either: `npx github:snazzybean/claudux#v1.0.1` or
`ghcr.io/snazzybean/claudux:v1.0.1`.

The volume covers the whole home directory rather than just `.claudux`,
because Claude Code keeps the session history the list reads in `.claude`,
right beside it.

Sessions then run **inside the container**, not on your machine — without
your compilers, language versions or credentials. For actual work, npx is
the way.

To develop on it, the checkout:

```sh
git clone https://github.com/snazzybean/claudux.git
cd claudux
npm install
npm run setup
npm start
```

Only this last path has `npm run setup`: it looks for tmux and ttyd, offers
to install what is missing via the detected package manager (it asks first,
and outside Homebrew the install runs through `sudo`), says whether the
Claude Code CLI is there, and creates `.env` from `.env.example`.

Whichever of the three you took, open `http://localhost:4001` and pick a
password on the screen that comes up. Do that before the machine's other
addresses see traffic — the first caller sets it. From then on the same
interface answers on every address of the machine; `HOST` narrows that down,
see Security above.

Behind that one port sit Express, its own ttyd child and the idle-session
reaper as a single process, with ttyd bound to `127.0.0.1` behind Claudux's
`/ttyd/*` proxy. One external route covers both the app and the terminal,
and the UTF-8 locale both need is picked per platform instead of being
configured in your shell.

### Configuration

All values come from the environment; `.env.example` lists every variable,
with the defaults in the comments:

| Variable | Meaning |
|---|---|
| `PORT` | port of the Express server |
| `HOST` | interface it binds to, `0.0.0.0` by default (see Security) |
| `CLAUDE_HOME` | Claude Code's directory, source of session histories |
| `DATA_DIR` | project list and session metadata, **outside** the checkout by default |
| `AUTH_ENABLED` | the login, on unless set to `false` (see Security) |
| `ACCESS_SECRET_PATH` | site password and sessions, **outside** the checkout |
| `ACCOUNTS_SECRET_PATH` | account tokens, **outside** the checkout |
| `NOTIFICATION_TARGETS_PATH` | notification targets, **outside** the checkout |
| `PROJECTS_BROWSE_ROOT` | root of the "+ Add folder" browse dialog, `$HOME` by default |
| `IDLE_THRESHOLD_MS` | when the reaper ends a dormant session |
| `UNUSED_IDLE_THRESHOLD_MS` | shorter deadline for sessions without any prompt |
| `LOGIN_IDLE_THRESHOLD_MS` | shorter still for an abandoned `claude setup-token` session |
| `PUBLIC_BASE_URL` | base for the notification's click-through link, unset by default |
| `VAPID_KEYS_PATH` | browser-push keypair, **outside** the checkout; deleting it unsubscribes every device |
| `VAPID_SUBJECT` | `sub` claim of the push token; falls back to `PUBLIC_BASE_URL`'s origin, then to this repository's url |
| `TTYD_PORT` | port the bundled ttyd child listens on |
| `TTYD_BIN` | path to the ttyd binary, if not on `PATH` |

### Accounts

An account is a name plus a token from `claude setup-token`, both created
under *Settings > Accounts*: Claudux runs the login in a background session,
reads url and token off its screen, and pre-fills the token where you can
read it before saving. "Open console manually" does the same by hand if the
CLI's wording changes and detection fails.

The token is stored under `ACCOUNTS_SECRET_PATH` (mode 0600, outside the
checkout) and never reaches a session on the command line, only via a
short-lived 0600 file whose path is in argv. Startup aborts if Claude Code's
global `settings.json` redirects the auth path via `env` or `apiKeyHelper`,
which would silently defeat the separation between accounts. An
`ANTHROPIC_API_KEY` configured that way stops the server rather than being
picked up.

### Notification targets

A message goes out when a session asks something, and when it has finished
its turn and stayed quiet for 90 seconds. The delay is what separates
"finished" from "carries on in a moment": a turn that ends while a background
task is still running resumes within seconds, and every one of those pauses
used to ring. A question or a permission prompt is never delayed — that is
the case somebody is waiting on. While a background command keeps running,
the session stays silent altogether until a fallback after ten minutes
reports it anyway, so a long-lived dev server cannot mute its session
forever.

Nothing goes out while somebody is looking at the session.

**Per project**, the settings dialog under Projects leads into each folder's
settings, where the level is one of three: everything, only while a session
is blocked on an answer, or nothing at all. Folders without a setting notify.

Targets are configured in the settings dialog under Sessions, stored outside
the checkout (`NOTIFICATION_TARGETS_PATH`, `0600`), and several can be active
at once:

- Browser notifications involve no further service and are activated per
  device; on a phone Claudux has to be on the home screen, since a normal tab
  offers no push at all. They are signed with a VAPID keypair created on
  first use (`VAPID_KEYS_PATH`), so keep that file: a new one makes every
  registered device fail silently.
- ntfy needs a server and a topic.
- A webhook needs a url and a body template with `{{title}}`, `{{body}}` and
  `{{url}}`, optionally an `Authorization` header. That covers Discord,
  Slack, Home Assistant, n8n and Gotify without a module per service.

Reading a target back never returns its url or header value, since for a
webhook the url is itself the credential.

## Operation

`npm start` in the foreground is enough for everyday use. To survive a crash
and start on boot, copy `deploy/claudux.service` to `/etc/systemd/system/`,
adjust `User=`, `Group=` and the two `/opt/claudux` paths, then `systemctl
enable --now claudux`. No macOS equivalent is included yet; a launchd agent
would cover the same need.

The reaper ends tmux sessions nobody is watching, but only its own, only
without an attached client, without running child processes, and only if they
haven't been protected in the interface. Any one of those spares a session.
For an abandoned `claude setup-token` session — whose screen shows a token —
the child-process check is skipped, because `setup-token` waiting for input
that never comes is itself the process that has to go.
The child-process check reads `/proc`, so where that is missing, no session
is ended on a criterion that cannot be evaluated.

If `claude` crashes, the tmux session stays: the next attach explains what
happened, tapping the row replaces the session, and a toast names the exit
code or signal.

After changes to `src/` or `scripts/`, restart (`systemctl restart claudux`).
Changes to `public/` only need a browser reload, since Express reads static
files fresh per request and a restart would disrupt open terminals. The JS
and CSS in there are minified on the way out and cached per file, but the
cache is keyed by modification time and size, so an edit still takes effect
on the next reload.

## Structure

```
src/lib/      logic, one responsibility per module
src/routes/   HTTP only
src/ttyd/     attach.sh, which ttyd runs per connection
scripts/      wrappers for session start, setup, diagnostics
public/       frontend without a build step (native ES modules)
test/         node:test, some against a real tmux server
```

`npm test` starts real tmux sessions and therefore runs serially; `npm run
lint` covers the frontend, which has no test suite. `marked` and
`highlight.js` run on the server only, so the phone loads finished HTML
instead of the libraries.

## License

MIT, see [LICENSE](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md) covers the
working rules for this repo: the tests, the linter, and what a change is
expected to come with.

[![Support on ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/snazzybean)
