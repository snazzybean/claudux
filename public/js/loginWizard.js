// The login wizard: it walks an ephemeral `claude setup-token` session from
// "start login" through the code step to a token, and hands that token to
// whoever asked for it.
//
// Two callers, one flow: the "+ Add account" form creates an account from
// the token, the "renew token" path on an existing account replaces its
// token. Which of the two applies is decided by the onDone/onManual pair
// startWizard() takes, not by state in here.
//
// Claudux reads the URL and token off the session's screen, instead of
// having them marked in the terminal. The terminal stays reachable as a
// fallback level - the detection depends on the exact wording of the CLI
// output.
//
// What it needs back from the account area (creating the account, the form
// it lives in, the marker on the list) arrives through initLoginWizard(),
// the same DI shape the other modules here use.
import { showError, clearError, checkResponse } from './messages.js';

let createAccount = async () => {};
let setAccountForm = () => {};
let forgetAccountMarker = () => {};
let openLoginTerminal = () => {};
let openManagement = () => {};
let closeManageDialog = () => {};

export function initLoginWizard(deps) {
  createAccount = deps.createAccount;
  setAccountForm = deps.setAccountForm;
  forgetAccountMarker = deps.forgetAccountMarker;
  openLoginTerminal = deps.openLoginTerminal;
  openManagement = deps.openManagement;
  closeManageDialog = deps.closeManageDialog;
}

let loginSession = null;
let loginTerminalUrl = null;
// The completion callback is remembered because the tick runs a second
// time after the code step and needs the same one then. Passing it in
// again there would mean knowing it in two places.
let loginDone = null;
let loginManual = null;
let loginTick = null;
let fallbackCounter = null;
// Whether the user has actually taken the path to login - via the button
// or via the console. Only after that can they have a code, and only then
// does step 3 open up. That doesn't yet mean the session is running.
let loginOpened = false;
// When renewing a token, the account is already fixed. The name step is
// then skipped - a field you can fill in that has no effect is worse than
// none at all: the account's name stays unchanged no matter what's typed
// there.
let renewedAccount = null;

// All steps sit visibly one below another; whatever isn't up yet is
// locked. `disabled` in addition to graying out, because a merely pale
// button would stay clickable - via keyboard just as with a finger.
function setStepActive(step, active, done = false) {
  const el = document.querySelector(`.login-step[data-step="${step}"]`);
  if (!el) return;
  el.dataset.activeEntry = String(active);
  // Three levels instead of two: what's still to come recedes far back;
  // what's done only a little - it stays operable in case someone wants
  // to repeat a step.
  el.dataset.done = String(done);
  el.querySelectorAll('input, button').forEach((control) => {
    // The manual path has its own condition (the countdown) and must not
    // be overridden by the step lock - otherwise it would be free before
    // detection got its chance, or stay locked when it finds nothing.
    if (control.dataset.ownLock === 'true') return;
    control.disabled = !active;
  });
}

// The single place that decides what's operable – derived from state
// instead of set individually on every event, so a step can always be
// stepped back out of.
export function updateSteps() {
  const renewing = Boolean(renewedAccount);
  const nameThere = document.getElementById('newAccountName').value.trim().length > 0;
  const running = Boolean(loginSession);
  const tokenThere = document.getElementById('newAccountToken').value.trim().length > 0;

  // The name step disappears entirely when renewing - the account is
  // already fixed. `hidden` instead of just locked, so the numbering
  // shifts up (CSS counter, see styles.css).
  const nameStep = document.querySelector('.login-step[data-step="name"]');
  nameStep.hidden = renewing;

  // Without the name step there'd be no clue whom the login is currently
  // running for.
  const forWhom = document.getElementById('loginFor');
  forWhom.hidden = !renewing;
  if (renewing) forWhom.textContent = `New token for "${renewedAccount.name}" – name and abbreviation stay unchanged.`;

  // A step counts as done as soon as a later one is up.
  setStepActive('name', true, running);
  setStepActive('login', nameThere || renewing, tokenThere);
  // Code AND token both only depend on a session running: whoever takes
  // the manual path fetches the token from the terminal themselves and
  // has to be able to enter it without having gone through the code step.
  setStepActive('code', running && loginOpened, tokenThere);
  setStepActive('token', running || tokenThere);

  // The start button disappears as soon as a login is running – the spot-
  // light and the login button take its place.
  document.getElementById('startLoginSession').hidden = running;
}

function stopLoginTick() {
  if (loginTick) clearInterval(loginTick);
  loginTick = null;
}

function stopFallbackCounter() {
  if (fallbackCounter) clearInterval(fallbackCounter);
  fallbackCounter = null;
}

// Full reset: the wizard is back at step 1 afterward, with empty fields.
// Including name and abbreviation – a half-filled form that's still there
// days later when opened looks like a stuck process.
export function resetWizard() {
  stopLoginTick();
  stopFallbackCounter();
  loginSession = null;
  loginTerminalUrl = null;
  loginOpened = false;
  renewedAccount = null;
  lockLoginButton();
  document.getElementById('loginWaiting').hidden = true;
  document.getElementById('loginFallback').hidden = true;
  document.getElementById('loginCode').value = '';
  document.getElementById('codeWaiting').hidden = true;
  document.getElementById('newAccountName').value = '';
  document.getElementById('newAccountAbbr').value = '';
  document.getElementById('tokenPending').hidden = false;
  document.getElementById('tokenWaiting').hidden = true;
  document.getElementById('tokenManual').hidden = true;
  // Don't leave it sitting in the DOM – the wizard stays open after
  // saving, so the window's close handler doesn't apply here yet.
  document.getElementById('newAccountToken').value = '';
  document.getElementById('tokenLength').textContent = '';
  showLoginBanner(false);
  updateSteps();
}

// The login button has its own condition: it only becomes usable once the
// URL has been read off the screen. Until then it's visible but without a
// target – so it's clear from the start what's being waited on.
function lockLoginButton() {
  const link = document.getElementById('loginLink');
  link.removeAttribute('href'); // without a target it's inert even without CSS
  link.setAttribute('aria-disabled', 'true');
}

function unlockLoginButton(url) {
  const link = document.getElementById('loginLink');
  link.href = url;
  link.setAttribute('aria-disabled', 'false');
}

// The signpost above the terminal. It's tied to the login session, not to
// the window: it's visible exactly when a login is running and the user
// is following it in the terminal.
// The session has served its purpose and the caller is about to report
// success. Its five steps used to be spelled out at each of the two call
// sites; the second one then went on to call resetWizard(), which repeats
// every one of them.
export function endRunningLoginSession() {
  endLoginSession(loginSession);
  loginSession = null;
  stopLoginTick();
  stopFallbackCounter();
  showLoginBanner(false);
}

// Whether a login is in flight. The account form asks before deciding
// between picking the steps back up and clearing them.
export function loginRunning() {
  return Boolean(loginSession);
}

export function showLoginBanner(visible, text) {
  const banner = document.getElementById('loginBanner');
  banner.hidden = !visible;
  if (text) document.getElementById('loginBannerText').textContent = text;
}

// The session has served its purpose. Without this it would stay stuck at
// `read _`, with the token in plain text on its screen.
//
// Without await and without error handling: for the user the process is
// done, and the reaper cleans up after a failed teardown.
function endLoginSession(name) {
  if (!name) return;
  fetch(`/api/accounts/login-session/${name}`, { method: 'DELETE' }).catch(() => {});
}

// The session is gone before a token was read – expired or ended by hand.
// It has no history to catch up on; the only path is a new attempt.
function reportLoginExpired() {
  stopLoginTick();
  stopFallbackCounter();
  loginSession = null;
  loginTerminalUrl = null;
  showLoginBanner(false);
  lockLoginButton();
  document.getElementById('loginWaiting').hidden = true;
  const fallback = document.getElementById('loginFallback');
  fallback.hidden = false;
  fallback.textContent =
    'The login has expired – its session gets cleaned up after 15 minutes without progress. "Start login" begins a new attempt.';
  // Name and abbreviation stay put: the new attempt is for the same
  // account, and typing them in a second time would be pure busywork.
  updateSteps();
}

// The cap is a backstop only: the tick runs solely while the wizard is
// open, and an OAuth window ends earlier anyway.
const LOGIN_TICK_MS = 1500;
const LOGIN_CAP = (10 * 60 * 1000) / LOGIN_TICK_MS;

// The token can appear on screen before LOGIN_DONE_MARKER does - `claude
// setup-token` prints the token, then still has to actually exit before
// Claudux's own wrapper command prints the marker (see tmuxManager.js). A
// tick that lands in that gap reads `complete: false` for a token that's
// perfectly fine. Bounded so a genuinely stuck token still falls through to
// manual confirmation instead of waiting forever.
const TOKEN_GRACE_TICKS = Math.ceil(10000 / LOGIN_TICK_MS);

function startLoginTick(onDone) {
  stopLoginTick(); // no second tick alongside a running one
  let attempts = 0;
  let tokenGraceTicks = 0;
  loginTick = setInterval(async () => {
    if (++attempts > LOGIN_CAP) {
      stopLoginTick();
      showError('Nothing was detected in the terminal. "Open console manually" continues there.');
      return;
    }
    try {
      const res = await fetch(`/api/accounts/login-session/${loginSession}/status`);
      await checkResponse(res);
      const status = await res.json();
      if (status.phase === 'gone') {
        reportLoginExpired();
        return;
      }
      if (status.phase === 'url') {
        unlockLoginButton(status.url);
        document.getElementById('loginWaiting').hidden = true;
        return;
      }
      if (status.phase === 'token') {
        // Give the marker a few more ticks to catch up before settling for
        // the doubtful-token path - see TOKEN_GRACE_TICKS above.
        if (!status.complete && tokenGraceTicks++ < TOKEN_GRACE_TICKS) return;
        stopLoginTick();
        stopFallbackCounter();
        document.getElementById('codeWaiting').hidden = true;
        onDone(status.token, status.complete);
      }
    } catch {
      // A single failure in the tick stays silent: the next run catches
      // the state up, and an error message every second would be
      // unusable.
    }
  }, LOGIN_TICK_MS);
}

// btn comes in as a parameter instead of being looked up by id: the renew
// path triggers with a different button and would otherwise lock the
// wrong one.
//
// onManual is the fallback path and thus not an afterthought: whoever
// takes "Open console manually" fetches the token there themselves — it then has
// to go somewhere, and that destination differs between the two paths.
export async function startWizard(btn, { onDone, onManual, forAccount = null }) {
  btn.disabled = true;
  loginDone = onDone;
  loginManual = onManual;
  renewedAccount = forAccount;
  loginOpened = false; // a new attempt starts back at step 2
  lockLoginButton();
  document.getElementById('loginWaiting').hidden = false;
  try {
    const res = await fetch('/api/accounts/login-session', { method: 'POST' });
    await checkResponse(res);
    const { terminalUrl, sessionName } = await res.json();
    loginSession = sessionName;
    loginTerminalUrl = terminalUrl;
    clearError();
    updateSteps();
    startFallbackCounter();
    startLoginTick(loginDone);
  } catch (err) {
    document.getElementById('loginWaiting').hidden = true;
    lockLoginButton();
    updateSteps();
    showError(`Could not start login session: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// The manual path is the last resort and therefore doesn't push itself
// forward right away: detection should get its chance first. Until then
// the line just counts down, so it's visible that something is still
// coming.
const FALLBACK_AFTER_S = 10;

function startFallbackCounter() {
  stopFallbackCounter();
  const line = document.getElementById('loginFallback');
  const button = manualConsoleButton();
  line.hidden = false;
  let remaining = FALLBACK_AFTER_S;
  const draw = () => {
    // The text is there from the start, only the link inside it isn't
    // operable yet. That way the manual path is known before it's
    // needed - and the countdown explains why it doesn't work yet.
    line.replaceChildren(
      document.createTextNode('Login button not responding? '),
      button,
      document.createTextNode(remaining > 0 ? ` (in ${remaining}s)` : ''),
    );
    button.disabled = remaining > 0;
    if (remaining <= 0) return stopFallbackCounter();
    remaining -= 1;
  };
  draw();
  fallbackCounter = setInterval(draw, 1000);
}

function manualConsoleButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.dataset.ownLock = 'true';
  button.textContent = 'Open console manually';
  button.addEventListener('click', openConsoleManual);
  return button;
}

// Shows just enough of the token to recognize it again. The full value
// doesn't belong in a success message that stays on screen.
export function shortToken(token) {
  return `${token.slice(0, 18)}…`;
}

// The completion when creating. If the token is demonstrably complete, it
// gets saved without any further action: confirming it by hand helped
// nobody, since you can't tell by looking at a token whether it's whole.
// The check for that now lives in loginScreen.js.
//
// Only the doubtful case lands in the form – with a clear message then.
async function applyToken(token, complete) {
  if (!complete) return showTokenManual(token);

  document.getElementById('tokenPending').hidden = true;
  document.getElementById('tokenWaiting').hidden = false;
  const name = document.getElementById('newAccountName').value.trim();
  const abbreviation = document.getElementById('newAccountAbbr').value.trim();
  try {
    await createAccount({ name, abbreviation, token });
    closeWizardWithSuccess(`Logged in – token ${shortToken(token)} saved for "${name}".`);
  } catch (err) {
    // The token is real, only the saving went wrong - the manual path
    // rescues the process instead of making it start over.
    document.getElementById('tokenWaiting').hidden = true;
    showError(`Could not save account: ${err.message}`);
    showTokenManual(token);
  }
}

// The wizard has done its job and makes room: its result sits in the list
// above, and that's where the confirmation belongs too. In the expanded
// wizard it would have ended up at the very bottom - outside the visible
// area.
export function closeWizardWithSuccess(text) {
  resetWizard();
  setAccountForm(false);
  const hint = document.getElementById('accountsHint');
  hint.textContent = text;
  hint.hidden = false;
}

function showTokenManual(token, hint) {
  document.getElementById('tokenPending').hidden = true;
  document.getElementById('tokenWaiting').hidden = true;
  document.getElementById('newAccountToken').value = token;
  document.getElementById('tokenLength').textContent =
    hint ??
    'The token might be cut off at the bottom edge of the terminal. Please check in the terminal and complete it here.';
  document.getElementById('tokenManual').hidden = false;
  updateSteps();
}

// Step 2 opens up as soon as a name is there. With all steps visible, a
// click that only pages forward is one click too many.
document.getElementById('newAccountName').addEventListener('input', updateSteps);

// Only the trip to login unlocks step 3: before that there can't be a
// code, and an operable field would invite skipping the step it's about
// to need. No preventDefault - the new tab belongs to the browser.
document.getElementById('loginLink').addEventListener('click', () => {
  if (document.getElementById('loginLink').getAttribute('aria-disabled') === 'true') return;
  loginOpened = true;
  updateSteps();
});

document.getElementById('startLoginSession').addEventListener('click', (e) => {
  startWizard(e.currentTarget, {
    onDone: applyToken,
    // Whoever takes the manual path brings the token themselves - then
    // the field is needed, and the hint says something different than in
    // the doubtful case.
    onManual: () =>
      showTokenManual('', 'Paste the token from the terminal here and save.'),
  });
});

document.getElementById('loginCodeSend').addEventListener('click', async (e) => {
  const field = document.getElementById('loginCode');
  const code = field.value.trim();
  if (!code || !loginSession) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/accounts/login-session/${loginSession}/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    // 404 always means the same thing here: the session has been cleaned
    // up while the user was away. That's not a transmission error, but
    // the end of this attempt – and the hint has to say that, instead of
    // showing an HTTP status.
    if (res.status === 404) return reportLoginExpired();
    await checkResponse(res);
    clearError();
    field.value = '';
    // Without feedback it looked like the code had dropped into nothing:
    // the field clears, and it takes seconds before the token appears.
    document.getElementById('codeWaiting').hidden = false;
    startLoginTick(loginDone);
  } catch (err) {
    document.getElementById('codeWaiting').hidden = true;
    showError(`Could not submit code: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// onManual BEFORE closing: the user goes into the terminal to read off
// the token, and has to be able to paste it somewhere afterward. Without
// this step the wizard would stay stuck at step 2 or 3, with the token
// field no longer reachable.
function openConsoleManual() {
  if (!loginTerminalUrl) return;
  // Captured BEFORE loginManual() runs: the renewal flow's onManual calls
  // resetWizard(), which sets the shared loginTerminalUrl back to null -
  // reading it fresh afterward would hand openLoginTerminal a null URL and
  // crash inside withTerminalOptions() (`null.includes('?')`), silently
  // aborting everything below it, including manageDialogEl.close().
  const terminalUrl = loginTerminalUrl;
  // This path also leads to the login - in the terminal instead of the
  // browser tab.
  loginOpened = true;
  loginManual?.();
  openLoginTerminal(terminalUrl);
  showLoginBanner(true, 'Login in progress');
  closeManageDialog();
}

// Back out of the login terminal. Without this path the user would have
// to figure out on their own that settings needs reopening - the
// terminal fills the whole area and looks like the new place where
// things happen.
document.getElementById('loginBannerBack').addEventListener('click', () => {
  openManagement('accounts');
  setAccountForm(true);
});

// The manual path: now only for a token that detection flags as possibly
// cut off, or for one fetched from the terminal.
document.getElementById('saveAccount').addEventListener('click', async () => {
  const name = document.getElementById('newAccountName').value.trim();
  const abbreviation = document.getElementById('newAccountAbbr').value.trim();
  const token = document.getElementById('newAccountToken').value.trim();
  if (!name || !token) return;

  try {
    await createAccount({ name, abbreviation, token });
    closeWizardWithSuccess(`Logged in – token ${shortToken(token)} saved for "${name}".`);
  } catch (err) {
    showError(`Could not save account: ${err.message}`);
  }
});

// ---------- What the management window does to a running wizard ----------
// Two calls instead of the eight the dialog's handlers used to make into
// here: whether a login is running, and what that means for the tick, the
// marker and the form, is this module's business, not the dialog's.

// The tick was stopped on close - without this, a login that is still
// running would sit idle even though the token might have been in the
// terminal for a while.
export function resumeWizardTracking() {
  if (!loginSession) return;
  startLoginTick(loginDone);
  updateSteps(); // state may have changed while the window was closed
}

// A tick that kept running without a visible wizard would query the server
// pointlessly for minutes.
//
// If a login is still running, the rest of the state stays as it is: the
// user is currently in the terminal or the browser tab and will come back.
// Without a running process, on the other hand, everything gets cleared - a
// half-filled form that's still there next time it's opened looks like a
// stuck process.
export function suspendWizard() {
  stopLoginTick();
  stopFallbackCounter();
  forgetAccountMarker();
  if (loginSession) {
    document.getElementById('newAccountToken').value = '';
    document.getElementById('loginCode').value = '';
    return;
  }
  resetWizard();
  setAccountForm(false);
}
