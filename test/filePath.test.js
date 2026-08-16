import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectPath, tokenDirectoryPath, FilePathError } from '../src/lib/filePath.js';

// Creates a project along with a projects.json and returns a config pointing
// at it. `dataDirInProject` recreates the checkout-is-a-project situation: the data
// directory (and with it session-tokens/) then sits INSIDE the project - only
// that way does the token exception even come into play.
function fixture({ dataDirInProject = false } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-file-'));
  const projectPath = path.join(tmpRoot, 'project');
  fs.mkdirSync(projectPath);
  const dataDir = dataDirInProject ? path.join(projectPath, 'data') : path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const project = { id: 'p1', name: 'Project', path: projectPath, favorite: false };
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  return { config: { dataDir }, projectPath, tmpRoot };
}

test('resolveProjectPath without a path returns the project root', () => {
  const { config, projectPath } = fixture();

  const result = resolveProjectPath(config, 'p1');

  assert.equal(result.root, fs.realpathSync(projectPath));
  assert.equal(result.absolute, fs.realpathSync(projectPath));
  assert.equal(result.rel, '');
});

test('resolveProjectPath resolves a relative path inside the project', () => {
  const { config, projectPath } = fixture();
  fs.mkdirSync(path.join(projectPath, 'src'));
  fs.writeFileSync(path.join(projectPath, 'src', 'a.js'), 'x');

  const result = resolveProjectPath(config, 'p1', 'src/a.js');

  assert.equal(result.absolute, path.join(fs.realpathSync(projectPath), 'src/a.js'));
  assert.equal(result.rel, 'src/a.js');
});

test('resolveProjectPath rejects a ..-escape', () => {
  const { config } = fixture();

  assert.throws(
    () => resolveProjectPath(config, 'p1', '../../etc/passwd'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

test('resolveProjectPath rejects an absolute path', () => {
  const { config } = fixture();

  assert.throws(
    () => resolveProjectPath(config, 'p1', '/etc/passwd'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

test('resolveProjectPath rejects a symlink that leads outside the project', () => {
  const { config, projectPath, tmpRoot } = fixture();
  const outside = path.join(tmpRoot, 'secret.txt');
  fs.writeFileSync(outside, 'not for viewing');
  fs.symlinkSync(outside, path.join(projectPath, 'out.txt'));

  assert.throws(
    () => resolveProjectPath(config, 'p1', 'out.txt'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

test('resolveProjectPath allows a symlink inside the project', () => {
  const { config, projectPath } = fixture();
  fs.writeFileSync(path.join(projectPath, 'real.txt'), 'content');
  fs.symlinkSync(path.join(projectPath, 'real.txt'), path.join(projectPath, 'pointer.txt'));

  const result = resolveProjectPath(config, 'p1', 'pointer.txt');

  assert.equal(result.rel, 'real.txt');
});

test('resolveProjectPath throws 404 for an unknown project ID', () => {
  const { config } = fixture();

  assert.throws(
    () => resolveProjectPath(config, 'does-not-exist'),
    (err) => err instanceof FilePathError && err.status === 404,
  );
});

test('resolveProjectPath throws 404 for a file that does not exist', () => {
  const { config } = fixture();

  assert.throws(
    () => resolveProjectPath(config, 'p1', 'missing.txt'),
    (err) => err instanceof FilePathError && err.status === 404,
  );
});

test('resolveProjectPath rejects paths into the token directory', () => {
  const { config, projectPath } = fixture({ dataDirInProject: true });
  const tokenDir = path.join(projectPath, 'data', 'session-tokens');
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tokenDir, 'abc.token'), 'sk-ant-' + 'oat01-secret', { mode: 0o600 });

  assert.throws(
    () => resolveProjectPath(config, 'p1', 'data/session-tokens/abc.token'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
  assert.throws(
    () => resolveProjectPath(config, 'p1', 'data/session-tokens'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
  // Also for a file that doesn't even exist there: otherwise the status code
  // alone would reveal which session is currently handing over a token.
  assert.throws(
    () => resolveProjectPath(config, 'p1', 'data/session-tokens/does-not-exist.token'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

test('tokenDirectoryPath resolves a relative dataDir absolutely', () => {
  const dirPath = tokenDirectoryPath({ dataDir: './data' });

  assert.ok(path.isAbsolute(dirPath));
  assert.equal(path.basename(dirPath), 'session-tokens');
});

// The secret files live outside the checkout (see config.js), but "outside the
// checkout" is not "outside every project": registering $HOME - or any parent
// of ~/.claudux - puts accounts.json, notifications.json and vapid.json inside
// a project root, and the Files tab would then serve the account tokens as
// plain text over GET.
function secretsFixture() {
  const { config, projectPath, tmpRoot } = fixture();
  const secretDir = path.join(projectPath, '.claudux');
  fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  const write = (name) => {
    const filePath = path.join(secretDir, name);
    fs.writeFileSync(filePath, '{}', { mode: 0o600 });
    return filePath;
  };
  return {
    config: {
      ...config,
      accountsSecretPath: write('accounts.json'),
      notificationTargetsPath: write('notifications.json'),
      vapidKeysPath: write('vapid.json'),
    },
    projectPath,
    tmpRoot,
  };
}

test('resolveProjectPath rejects paths to the secret files inside a project', () => {
  const { config } = secretsFixture();

  for (const name of ['accounts.json', 'notifications.json', 'vapid.json']) {
    assert.throws(
      () => resolveProjectPath(config, 'p1', `.claudux/${name}`),
      (err) => err instanceof FilePathError && err.status === 400,
      `.claudux/${name} must not be reachable`,
    );
  }
});

test('resolveProjectPath rejects a symlink that points at a secret file', () => {
  const { config, projectPath } = secretsFixture();
  fs.symlinkSync(config.accountsSecretPath, path.join(projectPath, 'pointer.json'));

  assert.throws(
    () => resolveProjectPath(config, 'p1', 'pointer.json'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

// Same reasoning as for the token directory: a 404 for a file that isn't there
// and a 400 for one that is would tell an outside reader which of the secret
// files this installation actually uses.
test('resolveProjectPath rejects a secret path that does not exist', () => {
  const { config, projectPath } = fixture();
  const secretPath = path.join(projectPath, '.claudux', 'accounts.json');

  assert.throws(
    () => resolveProjectPath({ ...config, accountsSecretPath: secretPath }, 'p1', '.claudux/accounts.json'),
    (err) => err instanceof FilePathError && err.status === 400,
  );
});

test('resolveProjectPath leaves ordinary files next to a secret file alone', () => {
  const { config, projectPath } = secretsFixture();
  fs.writeFileSync(path.join(projectPath, '.claudux', 'notes.md'), '# fine');

  const result = resolveProjectPath(config, 'p1', '.claudux/notes.md');

  assert.equal(result.rel, path.join('.claudux', 'notes.md'));
});

// The default dataDir ('./data') must not be caught by the exclusion - the
// Files tab has to keep serving a project's own data directory.
test('resolveProjectPath keeps serving the data directory itself', () => {
  const { config, projectPath } = fixture({ dataDirInProject: true });
  fs.writeFileSync(path.join(projectPath, 'data', 'session-meta.json'), '{}');

  const result = resolveProjectPath(config, 'p1', 'data/session-meta.json');

  assert.equal(result.rel, path.join('data', 'session-meta.json'));
});
