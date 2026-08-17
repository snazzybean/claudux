// test/onboardingFlag.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ensureOnboardingCompleted, onboardingFilePath } from '../src/lib/onboardingFlag.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-onboard-'));
}

function noLeftovers(dir) {
  const stray = fs.readdirSync(dir).filter((name) => name.includes('.claudux-'));
  assert.deepEqual(stray, [], `leftover temp file(s) in ${dir}: ${stray.join(', ')}`);
}

test('onboardingFilePath is a sibling of the home directory, not inside .claude', () => {
  const home = tmpHome();
  assert.equal(onboardingFilePath(home), path.join(home, '.claude.json'));
});

// The route calls both onboardingFilePath() and ensureOnboardingCompleted()
// with NO argument (src/routes/sessions.js) - that default-parameter path
// is what has to resolve against HOME, not against a redirected
// CLAUDE_HOME. A test that only passes `home` in explicitly never exercises
// that default and would still pass even if the default read
// path.dirname(config.claudeHome) instead of os.homedir() - so this one
// drives the default itself, with process.env.HOME and process.env.CLAUDE_HOME
// pointed at two different temp directories.
test('the default (no-argument) path resolves against HOME, not a redirected CLAUDE_HOME', () => {
  const originalHome = process.env.HOME;
  const originalClaudeHome = process.env.CLAUDE_HOME;
  const home = tmpHome();
  const decoyClaudeParent = tmpHome();
  process.env.HOME = home;
  process.env.CLAUDE_HOME = path.join(decoyClaudeParent, '.claude');
  try {
    // The two candidate derivations must disagree in this fixture,
    // otherwise the assertions below would pass no matter which one the
    // code actually uses.
    const cfg = loadConfig(process.env);
    assert.notEqual(path.dirname(cfg.claudeHome), home);

    assert.equal(onboardingFilePath(), path.join(home, '.claude.json'));

    ensureOnboardingCompleted();
    assert.ok(fs.existsSync(path.join(home, '.claude.json')));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).hasCompletedOnboarding,
      true,
    );
    // Nothing should exist near the decoy CLAUDE_HOME - the module never
    // reads that env var at all.
    assert.ok(!fs.existsSync(path.join(decoyClaudeParent, '.claude.json')));
    assert.ok(!fs.existsSync(cfg.claudeHome.replace(/\.claude$/, '.claude.json')));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = originalClaudeHome;
  }
});

test('ensureOnboardingCompleted creates the file when it is absent', () => {
  const home = tmpHome();
  ensureOnboardingCompleted(home);
  const filePath = path.join(home, '.claude.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(data.hasCompletedOnboarding, true);
  noLeftovers(home);
});

test('ensureOnboardingCompleted creates a fresh file with restrictive permissions', () => {
  const home = tmpHome();
  ensureOnboardingCompleted(home);
  const mode = fs.statSync(path.join(home, '.claude.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('ensureOnboardingCompleted sets the flag when the file exists without it', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  fs.writeFileSync(filePath, JSON.stringify({ oauthAccount: { id: 'acc-1' }, numStartups: 3 }));
  ensureOnboardingCompleted(home);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(data.hasCompletedOnboarding, true);
  // Unrelated fields survive untouched.
  assert.deepEqual(data.oauthAccount, { id: 'acc-1' });
  assert.equal(data.numStartups, 3);
  noLeftovers(home);
});

test('ensureOnboardingCompleted sets the flag when it is explicitly false', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  fs.writeFileSync(filePath, JSON.stringify({ hasCompletedOnboarding: false, oauthAccount: { id: 'acc-2' } }));
  ensureOnboardingCompleted(home);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(data.hasCompletedOnboarding, true);
  assert.deepEqual(data.oauthAccount, { id: 'acc-2' });
});

test('ensureOnboardingCompleted preserves an existing file mode', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  fs.writeFileSync(filePath, JSON.stringify({ oauthAccount: { id: 'acc-3' } }));
  fs.chmodSync(filePath, 0o600);
  ensureOnboardingCompleted(home);
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

// 0o600 alone can't tell "preserves the existing mode" from "always forces
// 0600" - the code's own default for a newly created file is 0o600 too. A
// mode that differs from that default is the only way to distinguish them.
test('ensureOnboardingCompleted preserves a non-default existing file mode', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  fs.writeFileSync(filePath, JSON.stringify({ oauthAccount: { id: 'acc-5' } }));
  fs.chmodSync(filePath, 0o644);
  ensureOnboardingCompleted(home);
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o644);
});

test('ensureOnboardingCompleted leaves valid JSON that is not an object untouched', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  const original = JSON.stringify([1, 2, 3]);
  fs.writeFileSync(filePath, original);
  assert.doesNotThrow(() => ensureOnboardingCompleted(home));
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  noLeftovers(home);
});

test('ensureOnboardingCompleted does not write at all when the flag is already set', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  // Deliberately unusual formatting (no trailing newline, irregular
  // spacing): if the code rewrote the file via JSON.stringify, this exact
  // byte sequence would not survive.
  const original = '{\n  "hasCompletedOnboarding":   true,\n  "oauthAccount": {"id":"acc-4"}\n}';
  fs.writeFileSync(filePath, original);
  const before = fs.statSync(filePath).mtimeMs;
  ensureOnboardingCompleted(home);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.equal(fs.statSync(filePath).mtimeMs, before);
  noLeftovers(home);
});

test('ensureOnboardingCompleted leaves an unparseable file untouched', () => {
  const home = tmpHome();
  const filePath = path.join(home, '.claude.json');
  const original = '{ this is not valid json';
  fs.writeFileSync(filePath, original);
  assert.doesNotThrow(() => ensureOnboardingCompleted(home));
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  noLeftovers(home);
});

test('ensureOnboardingCompleted never throws even when the home directory does not exist', () => {
  const home = path.join(os.tmpdir(), `claudux-onboard-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  assert.doesNotThrow(() => ensureOnboardingCompleted(home));
});
