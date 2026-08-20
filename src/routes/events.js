// Status and subagent deltas as Server-Sent Events, on one connection. One
// direction only, so no second WebSocket next to ttyd's: EventSource brings
// reconnect, backoff and heartbeat along instead of hand-writing all three.
//
// The stream carries deltas ONLY - never "reload the list". The expensive
// parts of the session list stay on their 15s tick.
import express from 'express';

export function eventsRouter() {
  const router = express.Router();
  const clients = new Set();

  router.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // A proxy in front of the server is not part of this repo, so the
      // instruction not to buffer travels in the response itself.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    // Without this the set keeps a corpse per reload, and the watcher writes
    // into it every two seconds.
    req.on('close', () => clients.delete(res));
  });

  // Comment line as a heartbeat: keeps intermediaries from dropping a
  // connection that stays silent between two status changes.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 60_000);
  heartbeat.unref?.();

  function publish(event, type = 'status') {
    const payload = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  return { router, publish };
}
