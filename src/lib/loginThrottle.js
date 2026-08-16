// Slows down password guessing. In memory, per client: a restart clears it,
// which is the deliberate trade against another file on disk.
const FREE_ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const FORGET_AFTER_MS = 60 * 60 * 1000;

export function createLoginThrottle({ nowFn = Date.now } = {}) {
  const records = new Map();

  // Reading a record is also what expires it - there is no timer, so a
  // process that is never asked again keeps nothing alive.
  function current(key) {
    const record = records.get(key);
    if (!record) return null;
    if (nowFn() - record.lastFailureAt > FORGET_AFTER_MS) {
      records.delete(key);
      return null;
    }
    return record;
  }

  return {
    delayMs(key) {
      const record = current(key);
      if (!record || record.failures <= FREE_ATTEMPTS) return 0;
      const steps = record.failures - FREE_ATTEMPTS - 1;
      return Math.min(BASE_DELAY_MS * 2 ** steps, MAX_DELAY_MS);
    },
    recordFailure(key) {
      const record = current(key) || { failures: 0, lastFailureAt: 0 };
      record.failures += 1;
      record.lastFailureAt = nowFn();
      records.set(key, record);
    },
    recordSuccess(key) {
      records.delete(key);
    },
  };
}
