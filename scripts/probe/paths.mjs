// Where the probes find the things they are not allowed to write down: this
// checkout, this user's home, and Playwright. All three were absolute paths
// from one installation before, which made the probes run on that machine
// only - and put a deployment path into a public repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two levels up from scripts/probe/.
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// `os.homedir()` reads $HOME first and returns an EMPTY STRING when it is set
// but empty - which is exactly the state of a fresh shell here (see
// CLAUDE.md). `userInfo()` asks the passwd database instead and answers in
// both cases.
export const HOME_DIR = os.homedir() || os.userInfo().homedir;

// Playwright is deliberately not a dependency of this project, so a probe
// that needs a browser borrows the one in the npx cache. That directory is
// named after a hash of the install, so it is searched for rather than
// written down. Returns a file: URL, ready for a dynamic import.
export function playwrightPath() {
  const cache = path.join(HOME_DIR, '.npm', '_npx');
  let entries = [];
  try {
    entries = fs.readdirSync(cache);
  } catch { /* no npx cache at all - reported below */ }
  for (const entry of entries) {
    const candidate = path.join(cache, entry, 'node_modules', 'playwright', 'index.mjs');
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  throw new Error(`no playwright under ${cache} - install it in a scratch directory first, see README.md`);
}
