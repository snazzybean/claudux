import express from 'express';
import crypto from 'node:crypto';
import { listAccounts, addAccount, updateAccount, removeAccount } from '../lib/accountStore.js';
import {
  spawnTmux,
  waitForSession,
  disableStatusBar,
  pinLoginWindowSize,
  buildLoginSessionArgs,
  capturePane,
  paneWidth,
  sendKeys,
  hasSession,
  killSession,
} from '../lib/tmuxManager.js';
import { readLoginScreen } from '../lib/loginScreen.js';
import { isLoginSession } from '../lib/reaper.js';

// "__proto__" as an account name would hit the prototype setter instead of
// an own property when written into the object literal: the token would
// silently vanish, no exception, and the user would get a misleading 201.
// Checked here at the system boundary, because this is the only place a
// name comes in from outside. "constructor"/"prototype" aren't affected,
// they land as normal properties.
const RESERVED_ACCOUNT_NAMES = new Set(['__proto__']);

// A value without this prefix isn't a valid Claude token. Claude Code does
// NOT reject that with an error, it silently falls back to the next auth
// source - the login stored in ~/.claude/.credentials.json. The visible
// consequence wouldn't be an error message, but every session unknowingly
// running via the personal login and dropping every few hours. Because the
// failure case is invisible by construction, it's caught here at the
// system boundary.
//
// Only the prefix and a non-empty remainder, no length check: the token
// length is documented nowhere. Likewise no version digit ("oat" instead
// of "oat01") - that setup-token outputs exactly "oat01" isn't guaranteed,
// and with a future "oat02" Claudux specifically would reject a valid
// token. The remaining CLI prefixes (API keys, admin keys, runner tokens)
// stay rejected - they don't work as CLAUDE_CODE_OAUTH_TOKEN anyway.
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

// The token comes in via copy/paste from the terminal, and a linebreak
// regularly comes along with it. The TRAILING one is the tricky case: it
// passes the prefix check and would get saved as a broken token, which
// Claude Code then silently discards again on startup. Hence always trim
// first.
function normalizeToken(token) {
  return typeof token === 'string' ? token.trim() : token;
}

function isValidToken(token) {
  return typeof token === 'string' && token.startsWith(OAUTH_TOKEN_PREFIX) && token.length > OAUTH_TOKEN_PREFIX.length;
}

// The token value must NEVER be part of an error message (would otherwise
// end up in the HTTP response and in logs) - unlike the account name, which
// is deliberately quoted so a typo is recognizable.
const TOKEN_FORMAT_ERROR =
  'Invalid token format - expected a token from `claude setup-token`, ' +
  'starting with "sk-ant-oat01-". A value without this prefix is ' +
  'silently ignored by Claude Code; the session would then unknowingly ' +
  'run via the login stored in ~/.claude/.credentials.json.';

function isValidAccountName(name) {
  // Check against the name AFTER trimming: otherwise " __proto__ " (with
  // whitespace) would bypass the block, only to land as "__proto__" in
  // addAccount() after all once trimmed.
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && !RESERVED_ACCOUNT_NAMES.has(trimmed);
}

export function accountsRouter(config) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ accounts: listAccounts(config.accountsSecretPath) });
  });

  router.post('/', (req, res) => {
    const { name, token, abbreviation } = req.body ?? {};
    if (!name || !token) return res.status(400).json({ error: 'name and token are required' });
    if (!isValidAccountName(name)) {
      return res.status(400).json({ error: `Invalid account name: ${name}` });
    }
    const trimmedToken = normalizeToken(token);
    if (!isValidToken(trimmedToken)) {
      return res.status(400).json({ error: TOKEN_FORMAT_ERROR });
    }
    const trimmedName = name.trim();
    const created = addAccount(config.accountsSecretPath, trimmedName, trimmedToken, abbreviation);
    res.status(201).json(created);
  });

  // Change name, short code and/or token of an existing account. Replace
  // instead of delete+recreate, because the latter would assign a new
  // account ID and thereby break every session-meta.json reference.
  router.patch('/:id', (req, res) => {
    const exists = listAccounts(config.accountsSecretPath).some((a) => a.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Account not found' });
    const { name, abbreviation, token } = req.body ?? {};
    if (name !== undefined && !isValidAccountName(name)) {
      return res.status(400).json({ error: `Invalid account name: ${name}` });
    }
    // Check before writing: a rejected PATCH must not damage the existing,
    // working token.
    const trimmedToken = normalizeToken(token);
    if (token !== undefined && !isValidToken(trimmedToken)) {
      return res.status(400).json({ error: TOKEN_FORMAT_ERROR });
    }
    const updated = updateAccount(config.accountsSecretPath, req.params.id, {
      name: name !== undefined ? name.trim() : undefined,
      abbreviation,
      token: trimmedToken,
    });
    res.status(200).json(updated);
  });

  // Sessions and project defaults reference an account by id. Deleting one
  // leaves that id pointing nowhere - the UI treats it as "no selection",
  // and the resume route heals it by taking the id the request sends.
  // Hence no blocking of deletion while any session still carries the id:
  // that would be a condition that gets harder and harder to satisfy as
  // sessions age.
  router.delete('/:id', (req, res) => {
    const exists = listAccounts(config.accountsSecretPath).some((a) => a.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Account not found' });
    removeAccount(config.accountsSecretPath, req.params.id);
    res.status(204).end();
  });

  // Own argv via buildLoginSessionArgs() instead of buildNewSessionArgs():
  // the login flow by definition has no account token yet - `claude
  // setup-token` is about to create one - and doesn't run in any project
  // folder. buildNewSessionArgs would need both.
  router.post('/login-session', async (req, res, next) => {
    try {
      const loginSessionName = `login-${crypto.randomBytes(4).toString('hex')}`;
      spawnTmux(buildLoginSessionArgs(loginSessionName));
      await waitForSession(loginSessionName);
      await disableStatusBar(loginSessionName);
      // -x/-y on new-session only set the initial size - without this,
      // "Show terminal" attaching later would resize the window back down
      // under tmux's default window-size mode (see pinLoginWindowSize).
      await pinLoginWindowSize(loginSessionName);
      // The name goes out with it: without it, the assistant in the
      // browser can neither query progress nor enter the code.
      res.status(201).json({ terminalUrl: `/ttyd/?arg=${loginSessionName}`, sessionName: loginSessionName });
    } catch (err) {
      next(err);
    }
  });

  // isLoginSession and not isValidSlug: that would let a session UUID
  // through, and this route would then hand out the pane of any session
  // at all - a token on the screen is not something only a login pane
  // can have.
  //
  // The check comes BEFORE hasSession: that returns `false` for a name it
  // can't use instead of rejecting, so an impossible request would read
  // as "session gone" rather than as a caller error.
  router.get('/login-session/:name/status', async (req, res, next) => {
    try {
      const { name } = req.params;
      if (!isLoginSession(name)) {
        return res.status(400).json({ error: 'Not a login session name' });
      }
      if (!(await hasSession(name))) return res.status(200).json({ phase: 'gone' });
      const [text, width] = await Promise.all([capturePane(name), paneWidth(name)]);
      res.status(200).json(readLoginScreen(text, width));
    } catch (err) {
      next(err);
    }
  });

  // Ends the login session once its purpose is fulfilled. Without this it
  // would stay stuck at `read _`, with the freshly generated token in
  // plain text on its screen - whoever opens the tmux session reads it.
  //
  // Own, narrower check than `isValidSlug`: that would also let a session
  // UUID through, and this route would then become a way to end any
  // session at all. It may only hit login sessions.
  router.delete('/login-session/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      if (!isLoginSession(name)) {
        return res.status(400).json({ error: 'Not a login session name' });
      }
      // "Already gone" is not an error: the reaper may have beaten us to
      // it, and the UI shouldn't report anything for that.
      if (await hasSession(name)) await killSession(name);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // No pattern for the CONTENT of the code - its format is guaranteed
  // nowhere -, just a character class: the value ends up in a send-keys
  // argv, and whitespace as well as control characters would have an
  // effect there the user didn't intend.
  const CODE_PATTERN = /^[A-Za-z0-9._~#/+=-]{1,512}$/;

  router.post('/login-session/:name/code', async (req, res, next) => {
    try {
      const { name } = req.params;
      // Same narrowing as the status route: with isValidSlug this would
      // send keystrokes into any session, i.e. type into a conversation.
      if (!isLoginSession(name)) {
        return res.status(400).json({ error: 'Not a login session name' });
      }
      const { code } = req.body ?? {};
      if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
        return res.status(400).json({ error: 'Invalid code' });
      }
      if (!(await hasSession(name))) return res.status(404).json({ error: 'Login session not found' });
      await sendKeys(name, code);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
