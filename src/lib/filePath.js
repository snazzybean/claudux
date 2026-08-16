// Project ID + relative path -> absolute path, guaranteed to stay within
// the project. Every endpoint of the Files tab goes through here.
import fs from 'node:fs';
import path from 'node:path';
import { loadProjects } from './projectStore.js';

const TOKEN_DIR_NAME = 'session-tokens';

export class FilePathError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// path.resolve, because `dataDir` defaults to a relative path ('./data'): a
// prefix comparison against the realpath-resolved target would otherwise
// never match. The directory itself only exists once a session has handed
// over a token - so only the parent path gets resolved.
export function tokenDirectoryPath(config) {
  const dataDir = path.resolve(config.dataDir);
  try {
    return path.join(fs.realpathSync(dataDir), TOKEN_DIR_NAME);
  } catch {
    return path.join(dataDir, TOKEN_DIR_NAME);
  }
}

function isInside(target, dir) {
  return target === dir || target.startsWith(dir + path.sep);
}

// The token directory plus every configured secret file. Listed individually
// rather than as their common parent: the three paths are independently
// configurable, so a parent would collapse to "/" for a config that spreads
// them across /etc, $HOME and /var/lib - and block every file.
export function forbiddenPaths(config) {
  const paths = [tokenDirectoryPath(config)];
  for (const secretPath of [config.accountsSecretPath, config.notificationTargetsPath, config.vapidKeysPath]) {
    if (typeof secretPath !== 'string' || !secretPath) continue;
    const absolute = path.resolve(secretPath);
    paths.push(absolute);
    // The file need not exist yet - vapid.json is written on first use. Its
    // resolved form is what a symlink inside the project would land on.
    try {
      paths.push(fs.realpathSync(absolute));
    } catch { /* not created yet - the unresolved path above still covers it */ }
  }
  return paths;
}

function assertNotForbidden(target, config) {
  for (const dir of forbiddenPaths(config)) {
    if (isInside(target, dir)) {
      throw new FilePathError(400, 'No access to this path');
    }
  }
}

export function projectRootPath(config, projectId) {
  const projects = loadProjects(path.join(config.dataDir, 'projects.json'));
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new FilePathError(404, 'Project not found');
  try {
    return fs.realpathSync(project.path);
  } catch {
    throw new FilePathError(404, 'Project folder no longer exists');
  }
}

// Returns { root, absolute, rel }. `rel` is the path AFTER symlink
// resolution - the UI uses it to show where the file actually lives, and
// "back" leads into the directory it's actually in.
export function resolveProjectPath(config, projectId, relPath = '') {
  const root = projectRootPath(config, projectId);
  const raw = typeof relPath === 'string' ? relPath : '';
  if (path.isAbsolute(raw)) {
    throw new FilePathError(400, 'Path must be relative to the project root');
  }

  const requested = path.resolve(root, raw);
  // Before the existence check: otherwise a path into the token directory
  // would answer with 404 or 400 depending on whether the file is there -
  // and the status code alone would reveal which session is currently
  // handing over a token, or which secret files this install uses.
  assertNotForbidden(requested, config);

  let absolute;
  try {
    // realpathSync resolves the FINAL target, not just the directory above
    // it: that way a symlink in the project that points outside fails the
    // check below - a symlink that stays inside remains allowed.
    absolute = fs.realpathSync(requested);
  } catch {
    // A ..-escape to a path that doesn't even exist isn't a "not found",
    // it's an escape attempt - otherwise the status code would reveal which
    // paths exist outside.
    if (!isInside(requested, root)) {
      throw new FilePathError(400, 'Path is outside the project');
    }
    throw new FilePathError(404, 'File or directory not found');
  }

  if (!isInside(absolute, root)) {
    throw new FilePathError(400, 'Path is outside the project');
  }
  // Once more after resolution: the checkout can itself be a registered
  // project, and a symlink could point at a token or a secret file. Those are
  // deliberately 0600 - that a logged-in user can reach them via the
  // terminal anyway is no reason to also carry them via GET into browser
  // history and screenshots.
  assertNotForbidden(absolute, config);

  return { root, absolute, rel: path.relative(root, absolute) };
}
