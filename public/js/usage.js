// The popover at the account pill: context state of the open session, usage
// in the 5-hour and 7-day window with reset time.
//
// It shows the same numbers as the status line in the terminal - but the
// values come from GET /api/sessions/:id/usage, not from the terminal
// text.
//
// There's no hover on the phone, so `title=` is ineffective there (see the
// comment above the header in index.html). Hence a real popover that opens
// on tap.
//
// The color tiers arrive ready-made from the server: they're embedded in a
// projection that belongs under test, and there's no test harness here.

// The tier strings the server emits (see src/lib/contextUsage.js and
// src/lib/rateLimits.js).
const LEVELS = ['dim', 'ok', 'warn', 'crit'];

// "16:10" for today, "tomorrow 10:00" for the next day, otherwise with the
// weekday. A bare date doesn't help much for a reset three days out - what
// matters is whether you can still get work done before then.
export function formatReset(epochSeconds, now = new Date()) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const target = new Date(epochSeconds * 1000);
  const time = target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dayDiff = Math.round(
    (new Date(target.getFullYear(), target.getMonth(), target.getDate())
      - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000,
  );
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `tomorrow ${time}`;
  return `${target.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

// How long until then. This is the actual information being sought, next to
// the clock time: "tomorrow 09:00" leaves open whether that's two hours away
// or twenty. Kept rounded and to a single unit - a minute-level figure for a
// reset five days out implies a precision the number doesn't have.
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

// "claude-opus-5" becomes "Opus 5". The raw identifier is too long for a
// header and the vendor name adds nothing - there's only one here. A date
// suffix ("claude-haiku-4-5-20251001") is dropped: it only distinguishes
// snapshots of the same model.
export function shortModelName(name) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const parts = name.trim().toLowerCase().replace(/^claude-/, '').split('-');
  const [series, ...rest] = parts;
  if (!series) return name;
  const version = rest.filter((t) => /^\d{1,2}$/.test(t)).join('.');
  const capitalized = series.charAt(0).toUpperCase() + series.slice(1);
  return version ? `${capitalized} ${version}` : capitalized;
}

function tierClass(level) {
  if (!LEVELS.includes(level)) return 'tier-dim';
  return `tier-${level}`;
}

// A row is three-tiered: label with percentage, below it the bar spanning
// the full width, below that the captions. The bar doesn't share its row
// with anything else - that way it stays long enough on a phone display for
// 60% to still be visually distinguishable from 70%.
function row(title, { percent, level, subRows = [], fallback }) {
  const wrap = document.createElement('div');
  wrap.className = 'usage-row';

  const header = document.createElement('div');
  header.className = 'usage-row-header';

  const label = document.createElement('span');
  label.className = 'usage-label';
  label.textContent = title;
  header.appendChild(label);

  const value = document.createElement('span');
  value.className = 'usage-value';
  value.textContent = Number.isFinite(percent) ? `${Math.round(percent)} %` : (fallback ?? '–');
  header.appendChild(value);
  wrap.appendChild(header);

  const bar = document.createElement('span');
  bar.className = `usage-bar ${tierClass(level)}`;
  const fill = document.createElement('span');
  // A visible sliver even at 0.3% - otherwise "barely used" looks the same
  // as "no data".
  fill.style.width = Number.isFinite(percent)
    ? `${Math.max(2, Math.min(100, percent))}%`
    : '0%';
  bar.appendChild(fill);
  wrap.appendChild(bar);

  for (const { text, className } of subRows) {
    if (!text) continue;
    const hint = document.createElement('span');
    hint.className = className ? `usage-extra ${className}` : 'usage-extra';
    hint.textContent = text;
    wrap.appendChild(hint);
  }
  return wrap;
}

function tokenShort(tokens) {
  if (!Number.isFinite(tokens)) return null;
  if (tokens >= 1000000) {
    const millions = tokens / 1000000;
    // Round window sizes without a decimal: "1M" instead of "1.0M".
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

// The switcher sits at the bottom of the popover: this is where account and
// limits are already side by side, and "limit reached, continue on the
// other one" is what brings anyone here.
function switcherSection(data, accounts, onSwitch) {
  if (!onSwitch) return null;
  // data.accountId is missing on the error path (see the catch branch in
  // initUsage) and can point at a deleted account - an unresolved id gets a
  // hidden placeholder instead of letting the browser preselect option 0,
  // which would offer a restart under a plausible-looking but wrong
  // account. Same pattern as the row's inline picker.
  const resolvedAccountId = accounts.some((a) => a.id === data.accountId) ? data.accountId : null;
  // A resolved id needs a second account to switch TO; an unresolved one is
  // itself the state this switcher exists to heal, and one known account is
  // already a destination. Same condition as the row's picker - the two
  // disagreeing would hide the control in exactly the case that needs it.
  if (accounts.length < (resolvedAccountId ? 2 : 1)) return null;

  const section = document.createElement('div');
  section.className = 'usage-switch';

  const select = document.createElement('select');
  if (!resolvedAccountId) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.selected = true;
    placeholder.hidden = true;
    select.appendChild(placeholder);
  }
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name;
    option.selected = account.id === resolvedAccountId;
    select.appendChild(option);
  }
  section.appendChild(select);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Switch and restart';
  // Disabled, not silently inert: on the error path the placeholder starts
  // selected (see resolvedAccountId above), and a button that accepts the
  // tap and does nothing is worse than one that visibly can't be pressed.
  // Also disabled on the account already running: the row's picker can't
  // fire this (no `change` event on an unchanged selection), and restarting
  // under the same account would only burn the prompt cache and whatever
  // the pane was doing, for no switch at all.
  button.disabled = !select.value || select.value === resolvedAccountId;
  select.addEventListener('change', () => {
    button.disabled = !select.value || select.value === resolvedAccountId;
  });
  button.addEventListener('click', () => {
    if (!select.value) return; // belt-and-braces - disabled already prevents this
    onSwitch(select.value);
  });
  section.appendChild(button);

  const note = document.createElement('div');
  note.className = 'usage-hint';
  note.textContent = 'The conversation is kept; its prompt cache is not – a long chat reloads on restart.';
  section.appendChild(note);

  return section;
}

export function renderUsage(el, data, accountName = () => null, accounts = [], onSwitch = null) {
  el.replaceChildren();
  if (!data) {
    const loading = document.createElement('div');
    loading.className = 'usage-hint';
    loading.textContent = 'loading …';
    el.appendChild(loading);
    return;
  }

  const context = data.context ?? {};

  // Account and model in the header: both apply to the whole display, and a
  // separator within one line would need a special character - those have
  // repeatedly shown up as an empty box on the devices here.
  const model = shortModelName(context.model);
  const account = accountName(data.accountId);
  if (account || model) {
    const header = document.createElement('div');
    header.className = 'usage-header';
    const accountEl = document.createElement('span');
    accountEl.textContent = account ?? '';
    header.appendChild(accountEl);
    const modelEl = document.createElement('span');
    modelEl.className = 'usage-model';
    modelEl.textContent = model ?? '';
    header.appendChild(modelEl);
    el.appendChild(header);
  }

  const tokenText = tokenShort(context.tokens);
  const windowText = tokenShort(context.contextWindow);
  el.appendChild(row('Context', {
    percent: context.percent,
    level: context.level,
    // Without a known window size there's no honest percentage - the bare
    // token count goes there instead.
    fallback: tokenText ?? '–',
    // Without a known window the token count is already the value - a sub
    // row would just repeat it.
    subRows: [{
      text: tokenText && windowText ? `${tokenText} of ${windowText}` : null,
    }],
  }));

  const rateLimits = data.limits;
  if (rateLimits) {
    for (const [key, title] of [['fiveHour', '5 hours'], ['sevenDay', '7 days']]) {
      const limitWindow = rateLimits[key];
      if (!limitWindow) continue;
      el.appendChild(row(title, {
        percent: limitWindow.percent,
        level: limitWindow.level,
        subRows: [
          { text: resetText(limitWindow.resetsAt, data.asOf) },
          // Only when the server names a time - it does that exclusively
          // when the pace before the reset is heading into the limit
          // (see expectedExhaustionAt in rateLimits.js).
          { text: forecastText(limitWindow.exhaustedAt, data.asOf), className: 'usage-forecast' },
        ],
      }));
    }
  }

  const footer = document.createElement('div');
  footer.className = 'usage-footer';
  if (data.error) {
    footer.textContent = data.error;
    footer.classList.add('usage-error');
  } else if (Number.isFinite(data.asOf)) {
    // The value can be up to 60 seconds old (cache in the server) - without
    // a timestamp it would read as just fetched.
    footer.textContent = `As of ${new Date(data.asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  } else if (!rateLimits) {
    footer.textContent = 'Quota unavailable';
  }
  if (footer.textContent) el.appendChild(footer);

  const switcher = switcherSection(data, accounts, onSwitch);
  if (switcher) el.appendChild(switcher);
}

// "resets 17:00, in 2 h 5 min". Both figures are computed against the same
// reference - the data's timestamp, which can be up to a minute old (cache
// in the server). With two different clocks, a day boundary could produce
// "tomorrow 00:05, in 4 min".
function resetText(resetsAt, asOf) {
  const reference = Number.isFinite(asOf) ? new Date(asOf) : new Date();
  const time = formatReset(resetsAt, reference);
  if (!time) return null;
  const duration = formatDuration(resetsAt - reference.getTime() / 1000);
  return duration ? `resets ${time}, in ${duration}` : `resets ${time}`;
}

// As a duration, not a clock time: the number is a projection of the
// current pace, not a promise. A minute-precise clock time would imply a
// precision the estimate doesn't have - and in the 7-day window it would
// show a weekday, from which the remaining time would first have to be
// worked out.
function forecastText(exhaustedAt, asOf) {
  if (!Number.isFinite(exhaustedAt)) return null;
  const reference = Number.isFinite(asOf) ? asOf / 1000 : Date.now() / 1000;
  const duration = formatDuration(exhaustedAt - reference);
  return duration ? `at this rate, likely exhausted in ${duration}` : null;
}

// Wires up the pill and the popover. `sessionId()` returns the currently
// open session, `load(id)` fetches the data, `accountName(id)` resolves an
// account id to a display name - these three are passed in so this module
// doesn't need to know app.js's state (same pattern as showFiles(project)).
// `accounts()` returns [{id, name, abbreviation}] for the switcher,
// `onSwitchAccount(id)` performs the restart. Both are passed in for the
// same reason.
export function initUsage({
  badgeEl, popoverEl, backdropEl, sessionId, load, accountName = () => null, accounts = () => [], onSwitchAccount = null,
}) {
  let isOpen = false;

  function close() {
    isOpen = false;
    popoverEl.hidden = true;
    backdropEl.hidden = true;
    badgeEl.setAttribute('aria-expanded', 'false');
  }

  // Closes the popover before restarting - it belongs to the session that
  // is about to end, not to whatever replaces it.
  const switchAndClose = onSwitchAccount
    ? async (accountId) => { close(); await onSwitchAccount(accountId); }
    : null;

  async function open() {
    const id = sessionId();
    if (!id) return;
    isOpen = true;
    popoverEl.hidden = false;
    backdropEl.hidden = false;
    badgeEl.setAttribute('aria-expanded', 'true');
    renderUsage(popoverEl, null, accountName, accounts(), switchAndClose);
    try {
      const data = await load(id);
      // Closed in the meantime or session switched: discard the response
      // instead of filling a collapsed popover.
      if (!isOpen || sessionId() !== id) return;
      renderUsage(popoverEl, data, accountName, accounts(), switchAndClose);
    } catch (err) {
      if (!isOpen) return;
      renderUsage(popoverEl, { context: {}, limits: null, error: err.message }, accountName, accounts(), switchAndClose);
    }
  }

  // Opens on tap. This branch is only reached via the keyboard for closing:
  // with the popover open, the catch area below sits OVER the pill, so a
  // second tap hits that instead and closes it that way. For mouse and
  // finger it's the same toggle, just a different path to it.
  badgeEl.addEventListener('click', () => {
    if (isOpen) close();
    else open();
  });

  badgeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isOpen) close();
      else open();
    }
  });

  // A tap outside closes it - via an invisible surface, not a handler on
  // the document. Such a handler would never see the click: .panel-overlay
  // has pointer-events:none, so a tap next to the popover would land
  // straight in the terminal iframe, and its events don't reach this
  // document. The surface sits above the iframe and intercepts it.
  backdropEl.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });

  return { close };
}
