// Site password and session lifetime in the settings modal. The containers
// come in as parameters instead of being pulled from shared state - same
// reason as in files.js and notifications.js.
//
// Every successful action here ends in a reload: changing the password
// revokes every session including this one, and signing out is the same
// thing on purpose. The reload lands on the login page, because the gate
// serves it under the url that was open.
import { showToast } from './messages.js';

function markActive(list, days) {
  list.querySelectorAll('.ttl-item').forEach((item) => {
    const value = item.dataset.days === '' ? null : Number(item.dataset.days);
    item.dataset.active = String(value === days);
  });
}

async function post(route) {
  const res = await fetch(route, { method: 'POST' });
  if (!res.ok) throw new Error('request failed');
}

export function showAccessSettings({ ttlList, passwordForm, currentInput, nextInput,
  signOutBtn, signOutAllBtn }) {
  fetch('/access/session-ttl')
    .then((res) => res.json())
    .then((body) => markActive(ttlList, body.days))
    .catch(() => showToast('Could not read the session lifetime'));

  ttlList.onclick = async (event) => {
    const item = event.target.closest('.ttl-item');
    if (!item) return;
    const days = item.dataset.days === '' ? null : Number(item.dataset.days);
    try {
      const res = await fetch('/access/session-ttl', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      if (!res.ok) throw new Error('rejected');
      markActive(ttlList, days);
    } catch {
      showToast('Could not save the session lifetime');
    }
  };

  passwordForm.onsubmit = async (event) => {
    event.preventDefault();
    const res = await fetch('/access/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: currentInput.value, next: nextInput.value }),
    });
    if (res.ok) {
      location.reload();
      return;
    }
    const body = await res.json().catch(() => ({}));
    // The 401 here means "wrong current password", not a lost session - the
    // fetch wrapper in app.js leaves /access alone for exactly this case.
    showToast(res.status === 401 ? 'The current password is wrong' : (body.error || 'Could not change the password'));
    currentInput.value = '';
    nextInput.value = '';
  };

  signOutBtn.onclick = () => post('/access/logout')
    .then(() => location.reload())
    .catch(() => showToast('Could not sign out'));

  signOutAllBtn.onclick = () => post('/access/logout-all')
    .then(() => location.reload())
    .catch(() => showToast('Could not sign out'));
}
