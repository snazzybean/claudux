# Security

## What Claudux is

A session in Claudux is an interactive shell as the user the service runs
as, with a Claude Code account token attached. Anyone who reaches a session
can run commands on that machine. Treat access to the interface as access to
the account it runs under.

## Reporting a vulnerability

Please report through GitHub's **Report a vulnerability** button on the
Security tab of the repository, which opens a private advisory. Public
issues are the wrong place for anything that gives access to a shell.

Expect an answer within a week. This is a spare-time project, so there is no
fix deadline to promise — what you will get is a decision, and credit in the
advisory unless you would rather not have it.

## What is in scope

* Getting past the login: reaching `/api/*`, the static files or the
  terminal WebSocket without a valid session
* Account tokens leaking out of `~/.claudux/accounts.json`, the token
  handoff files or a session's screen
* Command injection through project paths, session names or file paths
* Cross-site requests that a browser sends with the user's cookie

## What is not

* An installation running with `AUTH_ENABLED=false`. That switch says the
  network in front of it authenticates instead; without such a layer,
  Claudux is open by configuration, not by defect.
* Whatever a signed-in user does. They already have a shell.
* The window before the first password is set. A fresh installation is
  claimed by its first caller, and it listens on every interface, which is
  why the README says to sign in before anything else reaches the port.

## Supported versions

The latest commit on `main`. There are no maintained release branches.
