// An http error status is a different matter from a network error: `fetch`
// does NOT throw for it, the response resolves normally. Without the res.ok
// check, a wrong topic or a rejected rate limit would silently count as
// success. Only logged, not thrown - a failing notification must not
// disturb the path that triggered it.
export async function send(config, { title, body, clickUrl }, { fetchFn = fetch } = {}) {
  const headers = { Title: title };
  // Only set when present: without a link the notification should go out
  // plain instead of pointing at "#/session/undefined".
  if (clickUrl) headers.Click = clickUrl;
  const res = await fetchFn(`${config.url}/${config.topic}`, { method: 'POST', body, headers });
  if (!res.ok) {
    console.error(`notify/ntfy: responded with ${res.status} ${res.statusText}`);
  }
}
