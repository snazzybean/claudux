// Feedback to the user (error banner, brief toast) plus the two helpers
// almost every view needs: sanitizing text and making timestamps readable.
// Alongside checkResponse(), which translates every server response into as
// clear an error message as possible - the banner above shows exactly its
// result.
import { errorBannerCloseEl, errorBannerEl, errorBannerTextEl, toastEl } from './dom.js';

export function showError(message) {
  errorBannerTextEl.textContent = message;
  errorBannerEl.style.display = 'flex';
}

export function clearError() {
  errorBannerEl.style.display = 'none';
  errorBannerTextEl.textContent = '';
}

// The banner stays up until the next successful action - right for an error
// message, annoying once you've read it and just want to keep working. On
// the phone it also takes height away from the terminal.
errorBannerCloseEl.addEventListener('click', clearError);

let toastTimer = null;
export function showToast(message) {
  toastEl.textContent = message;
  toastEl.setAttribute('data-visible', 'true');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.setAttribute('data-visible', 'false'), 2600);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Coarse relative time, good enough for the sidebar, derived from the
// .jsonl file's last modification time (mtimeMs, see sessionStore.js).
export function formatRelativeTime(mtimeMs) {
  if (typeof mtimeMs !== 'number') return '';
  const minutes = Math.round((Date.now() - mtimeMs) / 60000);
  // "<1m" instead of "just now": same notation as all the other values
  // (2m, 3h, 4d) and fits the session row's fixed-width column - the longer
  // text would have overflowed it.
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Throws with as helpful an error message as possible when the response is
// not 2xx. On errors the server usually returns { error: "..." }
// (see src/server.js's error handler and the individual routes).
export async function checkResponse(res) {
  if (res.ok) return res;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {
    // Response wasn't JSON (e.g. empty body) - the status code is enough of a message.
  }
  throw new Error(message);
}

