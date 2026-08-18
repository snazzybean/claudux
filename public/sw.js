// Service worker for the installed PWA: it makes the "Add to Home Screen"
// flow available and delivers push notifications. No offline ambition -
// Claudux is always used online (the terminal and file view need a live
// connection anyway).
self.addEventListener('install', () => {
  self.skipWaiting();
});

// skipWaiting alone does not take over pages that are already open. Without
// claim, an installed PWA would keep an older worker indefinitely - for a
// worker that used to do nothing and now delivers push, that is the
// difference between working and silent.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // deliberately no caching - Claudux is always used online
});

self.addEventListener('push', (event) => {
  // A payload that will not parse still gets a notification: throwing here
  // makes the browser show its own placeholder instead, which says less.
  let message;
  try {
    message = event.data?.json() ?? {};
  } catch {
    message = {};
  }
  const url = typeof message.url === 'string' ? message.url : '/';
  event.waitUntil(
    self.registration.showNotification(message.title || 'Claudux', {
      body: message.body || 'A session needs you',
      data: { url },
      // The session link doubles as the tag, so several notifications from one
      // session replace each other instead of flooding the lock screen.
      tag: url,
      renotify: true,
    }),
  );
});

// Most notifications link back into this same origin, but the Claude Code
// update notification links to its GitHub release page instead - navigate()
// on an already-open window cannot leave the origin, so that case always
// needs a new window/tab rather than the focus+navigate path below.
function isSameOrigin(target) {
  try {
    return new URL(target, self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    if (isSameOrigin(target)) {
      // Focus what is already open instead of opening another window: every
      // tap would otherwise spawn a second PWA window.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          // navigate() can reject for a detached client, and being focused
          // on the right app beats failing the whole handler.
          if ('navigate' in client) await client.navigate(target).catch(() => {});
          return;
        }
      }
    }
    await self.clients.openWindow(target);
  })());
});
