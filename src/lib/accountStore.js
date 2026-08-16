// Keeps account tokens exclusively in a file outside the git checkout
// (chmod 600). Tokens are never logged here – only account names may appear
// in log output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ABBREVIATION_MAX_LENGTH = 2;

// Data format: { "<uuid>": { name, abbreviation, token } }. The name is
// deliberately not the key – otherwise a rename would have to cascade
// through every existing session-meta.json entry. Older entries are a plain
// string value keyed by the name.
function isLegacyEntry(value) {
  return typeof value === 'string';
}

function normalizeAbbreviation(abbreviation) {
  if (abbreviation === undefined || abbreviation === null) return null;
  const trimmed = String(abbreviation).trim();
  if (trimmed.length === 0) return null;
  // Truncate instead of rejecting: maxlength in the frontend is only a
  // convenience guard, not real protection. A 400 would be disproportionate
  // for a purely cosmetic field.
  return trimmed.slice(0, ABBREVIATION_MAX_LENGTH);
}

function readAll(secretPath) {
  if (!fs.existsSync(secretPath)) return {};
  const raw = fs.readFileSync(secretPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse error messages quote a snippet of the broken content, which
    // could contain token material – so NEVER pass on `raw` or the original
    // error message, not even to logs.
    throw new Error(`accounts.json is not valid JSON: ${secretPath}`);
  }
  // Valid JSON that isn't an object (null, array, number) would lead to
  // accesses on a non-object below. Same guard as in sessionMeta.js.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  // Auto-migrates old entries, self-healing rather than via a migration
  // script. The result is written back immediately, not just normalized in
  // the return value – otherwise every readAll() call would assign a NEW
  // random ID, and the ID wouldn't be stable between two requests.
  let migrated = false;
  const result = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isLegacyEntry(value)) {
      result[crypto.randomUUID()] = { name: key, abbreviation: null, token: value };
      migrated = true;
    } else {
      result[key] = value;
    }
  }
  if (migrated) writeAll(secretPath, result);
  return result;
}

function writeAll(secretPath, accounts) {
  // Set the mode explicitly – with the default umask, a 0755 directory would
  // result, letting other local users list the account names.
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600); // writeFileSync doesn't reset the mode of an existing file
}

// Structured list for GET /api/accounts – never the token.
export function listAccounts(secretPath) {
  return Object.entries(readAll(secretPath)).map(([id, a]) => ({
    id,
    name: a.name,
    abbreviation: a.abbreviation || null,
  }));
}

// Lookup by id - the only reference scheme. The name is display only:
// it isn't unique (nothing checks that) and it changes when renamed.
//
// Object.hasOwn instead of a plain index access: an id arriving from a
// request could be "__proto__" and would otherwise resolve against the
// prototype.
function accountById(secretPath, id) {
  if (typeof id !== 'string') return null;
  const all = readAll(secretPath);
  return Object.hasOwn(all, id) ? all[id] : null;
}

export function getTokenById(secretPath, id) {
  return accountById(secretPath, id)?.token || null;
}

// Never the token - the return value goes into HTTP responses and log
// lines.
export function getAccountById(secretPath, id) {
  const account = accountById(secretPath, id);
  if (!account) return null;
  return { id, name: account.name, abbreviation: account.abbreviation || null };
}

// Inverse of getTokenById: which account does this token belong to?
// Needed for the account display (activeAccount.js), which resolves
// against the process's real token instead of the stored mapping.
//
// Deliberately kept here in the store: it's the only place that gets to
// see token values, and that should stay that way. Only the id goes out.
// `null` means "belongs to no stored account" - a state of its own.
export function accountIdForToken(secretPath, token) {
  if (!token) return null;
  const match = Object.entries(readAll(secretPath)).find(([, a]) => a.token === token);
  return match?.[0] ?? null;
}

export function addAccount(secretPath, name, token, abbreviation) {
  const accounts = readAll(secretPath);
  const id = crypto.randomUUID();
  accounts[id] = { name, abbreviation: normalizeAbbreviation(abbreviation), token };
  writeAll(secretPath, accounts);
  return { id, name, abbreviation: accounts[id].abbreviation };
}

// Removes the account along with its token. Sessions reference an account
// by id (`session-meta.json`, a project's `defaultAccountId`) - that
// reference stays and points nowhere. Accepted: the UI checks every
// preselection against the loaded account list, and the resume route
// replaces an id that no longer resolves with the one sent along.
//
// A running session is unaffected: its token lives in the process
// environment and is no longer read from here.
export function removeAccount(secretPath, id) {
  const accounts = readAll(secretPath);
  if (!Object.hasOwn(accounts, id)) throw new Error(`Account ${id} not found`);
  delete accounts[id];
  writeAll(secretPath, accounts);
}

// The token must be replaceable: it expires or is simply wrong, and deleting
// + recreating would assign a new ID, breaking every session-meta.json
// reference to the account.
//
// No format validation here – that sits in routes/accounts.js at the system
// boundary. The store stays a pure persistence layer.
export function updateAccount(secretPath, id, { name, abbreviation, token } = {}) {
  const accounts = readAll(secretPath);
  if (!Object.hasOwn(accounts, id)) throw new Error(`Account ${id} not found`);
  if (name !== undefined) accounts[id].name = name;
  if (abbreviation !== undefined) accounts[id].abbreviation = normalizeAbbreviation(abbreviation);
  if (token !== undefined) accounts[id].token = token;
  writeAll(secretPath, accounts);
  // No token – the return value goes straight into the HTTP response.
  return { id, name: accounts[id].name, abbreviation: accounts[id].abbreviation };
}
