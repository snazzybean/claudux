export function startEventStream(onStatus, onSubagents) {
  const source = new EventSource('/api/events');
  source.addEventListener('status', (event) => {
    try {
      onStatus(JSON.parse(event.data));
    } catch {
      // A malformed line must not take the stream down.
    }
  });
  source.addEventListener('subagents', (event) => {
    if (!onSubagents) return;
    try {
      onSubagents(JSON.parse(event.data));
    } catch {
      // Same reasoning as the status listener above.
    }
  });
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
