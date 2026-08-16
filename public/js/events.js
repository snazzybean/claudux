// Status deltas from the server. EventSource reconnects on its own - a
// backgrounded Safari tab loses the connection and picks it up on return,
// so the dot is briefly stale and then correct.
export function startEventStream(onStatus) {
  const source = new EventSource('/api/events');
  source.addEventListener('status', (event) => {
    try {
      onStatus(JSON.parse(event.data));
    } catch {
      // A malformed line must not take the stream down.
    }
  });
  // A 401 is the one error EventSource does not recover from: it closes the
  // stream for good and reports no status, so the session can have ended
  // without anything on the page noticing. The probe tells the two cases
  // apart - a dropped connection reconnects by itself and must not turn into
  // a forced reload.
  source.addEventListener('error', async () => {
    if (source.readyState !== EventSource.CLOSED) return;
    try {
      const res = await fetch('/api/projects', { method: 'HEAD' });
      if (res.status === 401) location.reload();
    } catch {
      // No answer at all is a network problem, not a lost session.
    }
  });
  return source;
}
