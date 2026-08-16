// Notification targets in the settings modal. The containers come in as
// parameters instead of being pulled from shared state - an `export let`
// that another module assigns does not work (same reason as in files.js).
//
// Both areas are rebuilt on every call rather than updated in place: the
// modal opens repeatedly, and re-wiring existing nodes would stack a second
// listener on each open.
import { svgNode } from './icons.js';

// Per type, what the form asks for and what it makes of the answers. The
// server treats `config` as opaque, so the shape is decided here and in the
// provider - which is what keeps a later type from having to fit into a
// shared "url + headers + body" schema.
// A body starting with a brace is JSON in every service this covers, and
// that content type is what decides whether the provider escapes the
// placeholder values - without it a quote in a title breaks the body.
function headersFor(body, authorization) {
  const headers = {};
  if (body && (body.startsWith('{') || body.startsWith('['))) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = authorization;
  return headers;
}

// `build` receives only the fields that were filled in. On create the form
// insists on the required ones; on edit an empty field means "unchanged",
// which is how a target gets renamed without retyping its secret - the
// stored value never comes back to this page to be retyped from.
const TYPES = {
  ntfy: {
    label: 'ntfy',
    fields: [
      { key: 'url', placeholder: 'https://ntfy.sh', label: 'Server' },
      { key: 'topic', placeholder: 'my-topic', label: 'Topic' },
    ],
    build: (filled) => filled,
  },
  webhook: {
    label: 'Webhook',
    fields: [
      { key: 'url', placeholder: 'https://chat.example/hooks/…', label: 'URL' },
      {
        key: 'bodyTemplate',
        placeholder: '{"content": "{{title}}: {{body}}"}',
        label: 'Body — {{title}}, {{body}}, {{url}}',
      },
      { key: 'authorization', placeholder: 'Bearer … (optional)', label: 'Authorization' },
    ],
    build: ({ url, bodyTemplate, authorization }) => {
      const config = { method: 'POST' };
      if (url) config.url = url;
      if (bodyTemplate) config.bodyTemplate = bodyTemplate;
      // Headers are merged into the stored ones by the store, so patching
      // only the token keeps the content type that decides the escaping.
      const headers = headersFor(bodyTemplate, authorization);
      if (Object.keys(headers).length > 0) config.headers = headers;
      return config;
    },
  },
};

function filledValues(inputs) {
  return Object.fromEntries(
    [...inputs].map(([key, input]) => [key, input.value.trim()]).filter(([, value]) => value !== ''),
  );
}

// Type, name and the type's fields, as a column. Used for both create and
// edit - the difference is only which values are required and where the
// result is sent, so the two share this instead of drifting apart.
function fieldColumn(type, { name = '', placeholderSuffix = '' } = {}) {
  const nameInput = document.createElement('input');
  nameInput.autocomplete = 'off';
  nameInput.placeholder = `Display name${placeholderSuffix}`;
  nameInput.value = name;

  const fields = document.createElement('div');
  fields.className = 'notify-fields';
  const inputs = new Map();
  // A type absent from TYPES has no fields to type: webpush is registered by
  // the browser, not entered here, and deliberately stays out of the chooser.
  // Its edit form is therefore just the name - which is the only editable
  // thing about a device anyway. Without the fallback this throws, and since
  // row() builds every form eagerly, one device row would take the whole
  // list down with it.
  for (const field of TYPES[type]?.fields ?? []) {
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.placeholder = `${field.placeholder}${placeholderSuffix}`;
    input.setAttribute('aria-label', field.label);
    inputs.set(field.key, input);
    fields.append(input);
  }
  return { nameInput, fields, inputs };
}

async function loadTargets() {
  const res = await fetch('/api/notifications/targets');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()).targets;
}

function actionButton(iconName, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'notify-target-action';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(svgNode(iconName, 'icon-symbol'));
  return button;
}

function row(target, onChange) {
  const el = document.createElement('div');
  el.className = 'notify-target';
  el.dataset.targetId = target.id;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = target.enabled;
  toggle.title = 'Send to this target';
  toggle.addEventListener('change', async () => {
    await fetch(`/api/notifications/targets/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: toggle.checked }),
    });
    onChange();
  });

  const label = document.createElement('span');
  label.className = 'notify-target-name';
  label.textContent = `${target.name} · ${target.type}`;

  const summary = document.createElement('span');
  summary.className = 'notify-target-summary';
  summary.textContent = target.summary;

  const test = actionButton('bell', 'Send a test notification');
  test.addEventListener('click', async () => {
    test.disabled = true;
    test.classList.remove('failed', 'sent');
    try {
      const res = await fetch(`/api/notifications/targets/${target.id}/test`, { method: 'POST' });
      // A 200 says the attempt ran, not that it arrived - the dispatcher
      // swallows per-target errors on purpose. Hence "sent", not "ok".
      test.classList.add(res.ok ? 'sent' : 'failed');
      // A push subscription the service called gone was just removed server
      // side. Without redrawing, the row would stay on screen marked as sent.
      if (res.ok && (await res.json().catch(() => ({}))).removed) onChange();
    } catch {
      test.classList.add('failed');
    } finally {
      test.disabled = false;
    }
  });

  const edit = actionButton('pencil', 'Edit this target');
  const remove = actionButton('close', 'Remove this target');
  remove.addEventListener('click', async () => {
    await fetch(`/api/notifications/targets/${target.id}`, { method: 'DELETE' });
    onChange();
  });

  el.append(toggle, label, summary, edit, test, remove);

  // The form lives in a wrapper below the row, so opening it doesn't
  // disturb the grid the row is laid out in.
  const wrapper = document.createElement('div');
  wrapper.append(el);
  const form = editForm(target, onChange);
  form.style.display = 'none';
  edit.addEventListener('click', () => {
    const open = form.style.display === 'none';
    form.style.display = open ? 'flex' : 'none';
    edit.classList.toggle('open', open);
  });
  wrapper.append(form);
  return wrapper;
}

function editForm(target, onChange) {
  const form = document.createElement('div');
  form.className = 'add-project-form notify-edit';
  // Nothing stored is prefilled: the server never sends a url or a header
  // value back, so an empty field here means "keep it", not "clear it".
  const { nameInput, fields, inputs } = fieldColumn(target.type, {
    name: target.name,
    placeholderSuffix: ' — unchanged',
  });

  const save = document.createElement('button');
  save.className = 'btn-accent';
  save.type = 'button';
  save.textContent = 'Save';
  const error = document.createElement('p');
  error.className = 'notify-error';

  save.addEventListener('click', async () => {
    const filled = filledValues(inputs);
    const patch = { name: nameInput.value.trim() };
    // For a webpush row `filled` is always empty (it has no fields), so the
    // patch carries the name alone and never touches the stored subscription.
    if (Object.keys(filled).length > 0) patch.config = TYPES[target.type].build(filled);
    save.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch(`/api/notifications/targets/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      onChange();
    } catch (err) {
      error.textContent = `Could not save: ${err.message}`;
    } finally {
      save.disabled = false;
    }
  });

  form.append(nameInput, fields, save, error);
  return form;
}

function addForm(onCreated) {
  const area = document.createElement('div');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn-surface btn-lift add-project-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.append(svgNode('plus', 'icon-symbol'), document.createTextNode('Add target'));

  const form = document.createElement('div');
  form.className = 'add-project-form';
  form.style.display = 'none';

  const chooser = document.createElement('div');
  chooser.className = 'segmented';
  const submit = document.createElement('button');
  submit.className = 'btn-accent';
  submit.type = 'button';
  submit.textContent = 'Add';
  const error = document.createElement('p');
  error.className = 'notify-error';

  let type = 'ntfy';
  let column = fieldColumn(type);

  function renderFields() {
    const next = fieldColumn(type, { name: column.nameInput.value });
    column.nameInput.replaceWith(next.nameInput);
    column.fields.replaceWith(next.fields);
    column = next;
  }

  for (const [key, spec] of Object.entries(TYPES)) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'palette-item';
    choice.textContent = spec.label;
    choice.dataset.notifyType = key;
    choice.addEventListener('click', () => {
      type = key;
      for (const other of chooser.children) {
        other.dataset.active = String(other.dataset.notifyType === key);
      }
      renderFields();
    });
    choice.dataset.active = String(key === type);
    chooser.append(choice);
  }

  submit.addEventListener('click', async () => {
    const filled = filledValues(column.inputs);
    if (!column.nameInput.value.trim() || !filled.url) {
      error.textContent = 'Name and URL are required.';
      return;
    }
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch('/api/notifications/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          name: column.nameInput.value.trim(),
          config: TYPES[type].build(filled),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      onCreated();
    } catch (err) {
      error.textContent = `Could not save: ${err.message}`;
    } finally {
      submit.disabled = false;
    }
  });

  toggle.addEventListener('click', () => {
    const open = form.style.display === 'none';
    form.style.display = open ? 'flex' : 'none';
    toggle.setAttribute('aria-expanded', String(open));
  });

  form.append(chooser, column.nameInput, column.fields, submit, error);
  area.append(toggle, form);
  return area;
}

// `onChange` redraws more than this list when there is more to redraw:
// removing a device's row has to update the activation area above it, which
// would otherwise keep claiming the device receives notifications. Defaults to
// redrawing just this list.
export async function showNotificationTargets(listContainer, addContainer, onChange) {
  listContainer.textContent = '';
  addContainer.textContent = '';
  const refresh = onChange ?? (() => showNotificationTargets(listContainer, addContainer));
  addContainer.append(addForm(refresh));

  let targets;
  try {
    targets = await loadTargets();
  } catch (err) {
    listContainer.textContent = `Could not load targets: ${err.message}`;
    return;
  }
  if (targets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-hint';
    empty.textContent = 'No target yet - notifications stay off.';
    listContainer.append(empty);
    return;
  }
  for (const target of targets) listContainer.append(row(target, refresh));
}

// ---------- Web push: activating on this device ----------
//
// Its own control rather than an entry in the type chooser: there is nothing
// to type, and the permission prompt has to hang directly off the user's tap -
// after an await, some browsers drop it.

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.pushManager ? registration.pushManager.getSubscription() : null;
}

// The browser wants the key as bytes, and it arrives as base64url.
function decodeKey(base64url) {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

// A name the user recognizes on the row. The platform is the honest part of
// the user agent - the rest is noise, and the name stays editable anyway.
function deviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Browser';
  return window.matchMedia('(display-mode: standalone)').matches ? `${platform} (App)` : platform;
}

// Whether the server knows THIS subscription. Asked instead of derived: the
// target list carries only the shortened origin, so two devices behind the
// same push service would be indistinguishable - and the full endpoint is a
// secret the list must not hand out.
async function serverKnows(endpoint) {
  try {
    const res = await fetch('/api/notifications/subscribed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    if (!res.ok) return { registered: false, enabled: false };
    return await res.json();
  } catch {
    return { registered: false, enabled: false };
  }
}

async function subscribeThisDevice() {
  // Permission first and directly on the tap.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');

  const res = await fetch('/api/notifications/vapid-key');
  if (!res.ok) throw new Error('the server has no usable VAPID keypair');
  const { publicKey } = await res.json();

  const registration = await navigator.serviceWorker.ready;
  // An existing subscription is reused: unsubscribing and re-subscribing
  // would hand out a new endpoint and leave the old row behind.
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({
      // Required by every browser implementing this - a push without visible
      // output is not allowed.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    });

  const json = subscription.toJSON();
  const saved = await fetch('/api/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, name: deviceName() }),
  });
  if (!saved.ok) throw new Error(`${saved.status} ${saved.statusText}`);
}

// Three sources decide what is shown, because the server list alone lies: a
// permission revoked in the browser leaves the row untouched, and the device
// would look active while nothing arrives.
async function activationState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await currentSubscription();
  if (!subscription || Notification.permission !== 'granted') return 'off';
  const { registered, enabled } = await serverKnows(subscription.endpoint);
  // A subscription the server does not know happens after the target was
  // deleted here or the store was reset.
  if (!registered) return 'stale';
  return enabled ? 'on' : 'disabled';
}

const HINTS = {
  unsupported: 'This browser has no push support. On the phone, add Claudux to the home screen first — inside a normal tab it is not available.',
  denied: 'Notifications are blocked for this page. That can only be undone in the browser settings.',
  on: 'This device is in the list below and receives notifications.',
  // Registered but switched off: "receives notifications" would be a lie, and
  // an activate button would do nothing - the switch on the row is the way.
  disabled: 'This device is registered, but its row below is switched off — no notifications arrive.',
  off: 'Shows notifications on this device, even with the screen locked.',
  stale: 'The registration for this device is no longer valid — activate it again.',
};

const LABELS = { off: 'Enable on this device', stale: 'Enable again' };

// Only these need a button; the rest is a statement of fact the user acts on
// elsewhere - browser settings, or the switch on the row.
const ACTIONABLE = new Set(['off', 'stale']);

export async function showPushActivation(container, onChange) {
  container.textContent = '';
  const state = await activationState();

  const hint = document.createElement('p');
  hint.className = 'settings-hint';
  hint.textContent = HINTS[state];

  if (!ACTIONABLE.has(state)) {
    container.append(hint);
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-accent';
  button.append(svgNode('bell', 'icon-symbol'), document.createTextNode(LABELS[state]));

  const error = document.createElement('p');
  error.className = 'notify-error';

  button.addEventListener('click', async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      await subscribeThisDevice();
      onChange();
    } catch (err) {
      error.textContent = err.message === 'denied'
        ? 'Permission denied. It can only be granted again in the browser settings.'
        : `Could not enable: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });

  container.append(button, hint, error);
}
