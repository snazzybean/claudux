// Which session is someone currently looking at?
//
// A notification goes out after every finished turn. Someone sitting in
// front of it reading along doesn't need one for that - it should only
// arrive when NOBODY is looking. The frontend therefore reports on a beat
// which session is open and visible (heartbeat in public/app.js), and both
// the status watcher and routes/notify.js check in here before sending.
//
// Deliberately in-memory only: the information is valid for seconds and
// worthless after a restart - the next heartbeat re-establishes it within
// seconds. A file for this would be dead weight, and it would revive a
// stale state on restart that wrongly suppresses notifications.
const visibleSince = new Map();

// A bit more than double the heartbeat interval (20s): this way an entry
// survives one missed heartbeat without a closed page counting as "being
// looked at" for a noticeably long time.
export const PRESENCE_VALID_MS = 45_000;

export function reportVisible(sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  visibleSince.set(sessionId, now);
}

// Actively report hidden instead of waiting for expiry: if the user
// switches tabs or locks the device, the next notification should get
// through immediately instead of only after a validity period.
export function reportHidden(sessionId) {
  visibleSince.delete(sessionId);
}

// Expiry is the more important half: if a tab is closed or the device is
// put away, no "hidden" report ever arrives. Without it the session would
// stay "visible" forever and never notify again - better one notification
// too many than none permanently.
export function isVisible(sessionId, now = Date.now()) {
  const last = visibleSince.get(sessionId);
  if (last === undefined) return false;
  return now - last <= PRESENCE_VALID_MS;
}
