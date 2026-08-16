// Accounts and the login that fills them: the list in the settings window,
// the inline rename form on each entry, and the wizard that walks an
// ephemeral `claude setup-token` session through to a stored token.
//
// The cache of known accounts lives here rather than in app.js, because
// this is the only place that writes it - loadAccounts() is its sole
// author, everything else reads through allAccounts() and accountById().
//
// Same DI shape as terminalLinks.js and files.js: what this needs FROM
// app.js arrives through initAccounts() rather than an import, because
// importing app.js back would re-run its top-level side effects at an
// unpredictable point.
import { accountsListEl, searchInputEl } from './dom.js';
import { showError, clearError, showToast, checkResponse } from './messages.js';
import { svgNode } from './icons.js';
import {
  initLoginWizard,
  startWizard,
  resetWizard,
  updateSteps,
  showLoginBanner,
  endRunningLoginSession,
  closeWizardWithSuccess,
  shortToken,
  loginRunning,
  resumeWizardTracking,
  suspendWizard,
} from './loginWizard.js';

let render = () => {};

// app.js talks to the account area, not to the wizard behind it - these
// pass straight through.
export { resetWizard, showLoginBanner, resumeWizardTracking, suspendWizard };

export function initAccounts(deps) {
  render = deps.render;
  // What the wizard needs from here it cannot import, because this module
  // imports it - so it arrives the same way this one's own dependencies do.
  initLoginWizard({
    createAccount,
    setAccountForm,
    forgetAccountMarker,
    openLoginTerminal: deps.openLoginTerminal,
    openManagement: deps.openManagement,
    closeManageDialog: deps.closeManageDialog,
  });
}

// Cache of the accounts most recently loaded from GET /api/accounts
// ([{id, name, abbreviation}], never tokens), maintained by loadAccounts(). The
// account select for "+ New session" reads from it so that no separate
// /api/accounts request is needed per project row.
//
// Read through allAccounts() everywhere outside this module: the session
// rows, the new-session controls and the project detail all need it, and a
// reader that goes through a function does not care where the cache lives.
let knownAccounts = [];

export function allAccounts() {
  return knownAccounts;
}

// Accounts are referenced by id everywhere; name and abbreviation are
// looked up here for display. An id that resolves to nothing means the
// account was deleted - callers treat that like "none".
export function accountById(id) {
  return knownAccounts.find((a) => a.id === id) ?? null;
}

// What the chip shows: the abbreviation if one is set, otherwise the full
// name.
export function accountLabel(id) {
  const account = accountById(id);
  return account ? account.abbreviation || account.name : null;
}
// Distinguishes "GET /api/accounts has never succeeded" from "succeeded,
// result is empty" – without this the sidebar would wrongly show "No
// account set up" on a network error, when in truth only the load failed
// (see loadAccounts()).
let accountsLoadFailed = false;

export function accountLoadFailed() {
  return accountsLoadFailed;
}

// Shared by the inline form's save button and the wizard, which sets a
// renewed token itself.
async function saveAccountChange(id, { name, abbreviation, token }) {
  const res = await fetch(`/api/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // Only send token when one is present – an empty field means
    // "unchanged", not "delete". Otherwise the route would reject an empty
    // token field as a format error with 400, which would also make a
    // plain rename fail.
    body: JSON.stringify({ name, abbreviation, ...(token ? { token } : {}) }),
  });
  await checkResponse(res);
  // Before loading the list, just like when creating: a changed entry
  // would otherwise not be findable among the others either.
  accountMarker = { id, text: '(updated)' };
  clearError();
  await loadAccounts();
  render(searchInputEl.value); // chips/select may use the new name/abbreviation
}

// The edit icon on each account opens a small inline form instead of a
// dedicated dialog component - the same pattern as the add-account-form
// below.
function buildAccountBadge(account) {
  const wrap = document.createElement('div');
  wrap.className = 'manage-row';

  // The name comes from outside: set it as a text node, not via innerHTML.
  const label = document.createElement('span');
  label.className = 'manage-text';
  const name = document.createElement('span');
  name.className = 'manage-name';
  name.textContent = account.name;
  label.appendChild(name);
  if (account.id === accountMarker?.id) {
    const mark = document.createElement('span');
    mark.className = 'account-marker';
    mark.textContent = accountMarker.text;
    name.append(' ', mark);
  }
  if (account.abbreviation) {
    const abbreviationEl = document.createElement('span');
    abbreviationEl.className = 'manage-path';
    abbreviationEl.textContent = `Abbr ${account.abbreviation}`;
    label.appendChild(abbreviationEl);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn-quiet account-edit-btn manage-action';
  editBtn.title = 'Edit account';
  editBtn.setAttribute('aria-label', editBtn.title);
  editBtn.appendChild(svgNode('pencil', 'icon-symbol'));

  const editForm = document.createElement('span');
  editForm.className = 'account-edit-form';
  editForm.style.display = 'none';
  const nameInput = document.createElement('input');
  nameInput.value = account.name;
  nameInput.className = 'account-edit-name';
  const abbreviationInput = document.createElement('input');
  abbreviationInput.value = account.abbreviation || '';
  abbreviationInput.maxLength = 2;
  abbreviationInput.placeholder = 'Abbr';
  abbreviationInput.className = 'account-edit-abbr';

  // Token renewal: a `claude setup-token` token expires after a year, and
  // a wrongly pasted token has to be correctable – so far both only
  // worked via delete + recreate, which assigns a new account id and
  // thereby breaks every session mapping.
  //
  // The field is deliberately pre-filled EMPTY and only sent along when
  // there's actually something in it: the existing token is never
  // returned (GET /api/accounts doesn't hand it out), so showing it here
  // would be impossible anyway – and a rename must not touch the token.
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'New token (empty = unchanged)';
  tokenInput.className = 'account-edit-token';
  tokenInput.autocomplete = 'off';

  const loginBtn = document.createElement('button');
  loginBtn.type = 'button';
  loginBtn.className = 'btn-ghost';
  loginBtn.textContent = 'Login…';
  loginBtn.title = 'Start login to generate a new token';
  // The same wizard as when creating - two login paths with different
  // levels of polish would be one more source that could drift apart. The
  // form below gets expanded, otherwise the steps would run invisibly;
  // name and abbreviation are already fixed here, so it starts at login.
  loginBtn.addEventListener('click', () => {
    // Clear first: a half-filled create flow must not bleed into the
    // renewal.
    resetWizard();
    setAccountForm(true);
    startWizard(loginBtn, {
      forAccount: account,
      // Same as when creating: a demonstrably complete token is applied
      // directly, the doubtful case lands in the field for correction.
      onDone: async (token, complete) => {
        tokenInput.type = 'text';
        tokenInput.value = token;
        if (!complete) {
          resetWizard();
          showToast('Token might be cut off – please check in the terminal, then save.');
          return;
        }
        try {
          await saveAccountChange(account.id, { name: account.name, abbreviation: account.abbreviation, token });
          endRunningLoginSession();
          // Same as when creating: the wizard makes room, the confirmation
          // sits on the list.
          closeWizardWithSuccess(`Token ${shortToken(token)} replaced for "${account.name}".`);
        } catch (err) {
          showError(`Could not replace token: ${err.message}`);
        }
      },
      // Here the manual path does NOT lead to step 4: its "Save" creates a
      // new account, while the token here belongs in this account's field.
      onManual: () => {
        tokenInput.type = 'text';
        resetWizard();
        showToast('Copy the token from the terminal and paste it into this account’s token field above.');
      },
    });
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-accent';
  saveBtn.textContent = 'Save';
  editForm.append(nameInput, abbreviationInput, tokenInput, loginBtn, saveBtn);

  // Delete sits in the edit form, not as a separate mark in the row: an
  // account is quickly recreated, but its token isn't - that's gone after
  // deletion and has to be obtained via a new login. A mis-tap next to the
  // pencil would be costly.
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-ghost account-edit-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    const sure = confirm(
      `Delete account "${account.name}"?\n\n` +
        'The stored token is removed in the process and can only be regained ' +
        'through a new login. Running sessions of this account keep working; ' +
        'their mapping will point at nothing afterward, though.',
    );
    if (!sure) return;
    try {
      const res = await fetch(`/api/accounts/${account.id}`, { method: 'DELETE' });
      await checkResponse(res);
      clearError();
      await loadAccounts();
      render(searchInputEl.value); // chips and select fields no longer know the name
      showToast(`Account "${account.name}" deleted.`);
    } catch (err) {
      showError(`Could not delete account: ${err.message}`);
    }
  });
  editForm.appendChild(deleteBtn);

  function setEditing(editing) {
    editForm.style.display = editing ? 'inline-flex' : 'none';
    label.style.display = editing ? 'none' : '';
    editBtn.style.display = editing ? 'none' : '';
  }
  editBtn.addEventListener('click', () => setEditing(true));
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const token = tokenInput.value.trim();
    try {
      await saveAccountChange(account.id, { name, abbreviation: abbreviationInput.value.trim(), token });
      tokenInput.value = ''; // don't leave it sitting in the DOM
      showToast(token ? `Account "${name}" updated, token replaced.` : `Account "${name}" updated.`);
    } catch (err) {
      showError(`Could not update account: ${err.message}`);
    }
  });

  wrap.append(label, editBtn, editForm);
  return wrap;
}

// Everything the sidebar list shows of an account. The list is only
// rebuilt when this changes: the background tick calls loadAccounts() every
// 15 seconds, and an unconditional rebuild would close an open rename form
// under the fingers of whoever is typing in it.
function accountsSignature(accounts) {
  return JSON.stringify([accountsFingerprint(accounts), accountMarker]);
}

// The part of it the session rows read too - via accountById() for the chip
// label, and via knownAccounts.length for whether the inline picker is
// usable at all (see buildSessionRow). Part of sessionSignature() for that
// reason: without it, an account added on another device would leave this
// tab's pickers disabled until a reload, and one deleted there would leave
// a selectable option whose PATCH answers 400.
export function accountsFingerprint(accounts) {
  return JSON.stringify(accounts.map((a) => [a.id, a.name, a.abbreviation ?? null]));
}

let accountsShownSignature = null;

// The marker on the freshly created account applies to one visit to the
// management window: next time it's opened, that account is just one of
// many. Removed from the DOM rather than reloaded - on closing the window a
// server request isn't worth it - and the shown signature is re-derived
// afterwards, without which the next background tick would rebuild the list
// just to arrive at the same DOM.
function forgetAccountMarker() {
  accountMarker = null;
  document.getElementById('accountsHint').hidden = true;
  document.querySelectorAll('.account-marker').forEach((el) => el.remove());
  accountsShownSignature = accountsSignature(knownAccounts);
}

// Loads the known accounts (never tokens), shows them in the sidebar, and
// maintains `knownAccounts` as the data source for the account select in
// "+ New session" and for the abbreviation chip in the session list.
//
// `still` marks the background tick: like loadProjects(), it stays silent
// on failure - on the phone the connection drops briefly all the time, and
// an error banner for something nobody triggered is just noise.
export async function loadAccounts({ still = false } = {}) {
  try {
    const res = await fetch('/api/accounts');
    await checkResponse(res);
    const { accounts } = await res.json();
    knownAccounts = accounts;
    accountsLoadFailed = false;
    const signature = accountsSignature(accounts);
    if (signature === accountsShownSignature) return;
    accountsShownSignature = signature;
    accountsListEl.innerHTML = '';
    if (accounts.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'accounts-empty-hint';
      hint.textContent = 'No account set up yet.';
      accountsListEl.appendChild(hint);
      return;
    }
    for (const account of accounts) {
      accountsListEl.appendChild(buildAccountBadge(account));
    }
  } catch (err) {
    // knownAccounts deliberately NOT reset: on a temporary error the most
    // recently known list should stay usable for selection, instead of
    // wrongly showing "no account". accountsLoadFailed only makes sure
    // that a *genuinely* empty first load attempt gets a different hint
    // text.
    if (still) return;
    accountsLoadFailed = true;
    showError(`Could not load accounts: ${err.message}`);
  }
}

// The form also gets expanded by the "renew token" path: the step sequence
// lives inside it, and a collapsed form would mean the user starts a
// process there whose steps they can't see.
function setAccountForm(open) {
  document.getElementById('addAccountForm').style.display = open ? 'flex' : 'none';
  document.getElementById('addAccountToggle').setAttribute('aria-expanded', String(open));
}

document.getElementById('addAccountToggle').addEventListener('click', () => {
  const open = document.getElementById('addAccountForm').style.display === 'none';
  setAccountForm(open);
  // A finished process gets cleared when expanded again: the previous
  // account's success message has no business showing up for the next
  // one. A running login, on the other hand, stays put.
  if (open) {
    if (loginRunning()) updateSteps();
    else resetWizard();
  }
});

// The account just created or changed gets marked in the list until the
// window closes. It sits among others and would otherwise not be
// findable - the list isn't sorted by age.
let accountMarker = null; // { id, text }

// Shared path for both the automatic and the saved-by-hand creation.
async function createAccount({ name, abbreviation, token }) {
  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, token, abbreviation }),
  });
  await checkResponse(res);
  const created = await res.json();
  // Before loading the list: it draws the marker along with it.
  accountMarker = { id: created.id, text: '(new)' };
  clearError();
  endRunningLoginSession();
  await loadAccounts(); // the new account shows up in the list above right away
  render(searchInputEl.value); // chips and select fields know it too, then
  return created;
}
