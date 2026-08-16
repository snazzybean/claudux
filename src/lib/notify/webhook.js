// A freely configured target: url, method, headers and a body template with
// {{title}}, {{body}} and {{url}}. Covers Discord, Slack, Home Assistant,
// n8n and Gotify without a module per service.
const PLACEHOLDER = /\{\{(title|body|url)\}\}/g;

function isJsonBody(headers) {
  return Object.entries(headers ?? {}).some(
    ([key, value]) => key.toLowerCase() === 'content-type' && String(value).toLowerCase().includes('json'),
  );
}

// The one non-obvious part of this provider: in a JSON template the values
// sit INSIDE string literals, so a quote or newline in the title would
// break the body. JSON.stringify escapes it; the surrounding quotes it adds
// are already in the template, hence slice.
function fill(template, values, asJson) {
  return String(template ?? '').replace(PLACEHOLDER, (_, key) => {
    const value = values[key] ?? '';
    return asJson ? JSON.stringify(value).slice(1, -1) : value;
  });
}

export async function send(config, { title, body, clickUrl }, { fetchFn = fetch } = {}) {
  const values = { title, body, url: clickUrl ?? '' };
  const res = await fetchFn(config.url, {
    method: config.method || 'POST',
    headers: config.headers ?? {},
    body: fill(config.bodyTemplate, values, isJsonBody(config.headers)),
  });
  if (!res.ok) {
    // Never log url or headers - the url itself is the credential here.
    console.error(`notify/webhook: responded with ${res.status} ${res.statusText}`);
  }
}
