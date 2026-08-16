import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadProjects(configPath) {
  if (!fs.existsSync(configPath)) return [];
  let projects;
  try {
    projects = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(projects)) return [];
  return projects;
}

function saveProjects(configPath, projects) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(projects, null, 2));
}

export function addProject(configPath, { name, projectPath }) {
  // Ahead of mkdirSync, which would otherwise create the folder relative to
  // the service's working directory. Its own check rather than the tmux one
  // in tmuxManager.js, for its own reason: sessionStore derives the
  // transcript directory from this path, and a relative one leaves the
  // project's history permanently empty.
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error(`projectPath must be absolute: ${projectPath}`);
  }
  fs.mkdirSync(projectPath, { recursive: true });
  const projects = loadProjects(configPath);
  const project = { id: crypto.randomUUID(), name, path: projectPath, favorite: false };
  projects.push(project);
  saveProjects(configPath, projects);
  return project;
}

export function toggleFavorite(configPath, id) {
  const projects = loadProjects(configPath);
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project ${id} not found`);
  project.favorite = !project.favorite;
  saveProjects(configPath, projects);
}

// Removes only the entry from projects.json – touches neither the real
// files in the project folder nor the .jsonl session history under
// ~/.claude/projects/... (sessionStore.js always reads that live from
// there). A removed project can be re-added at any time via the same path,
// and the complete history reappears then.
export function removeProject(configPath, id) {
  const projects = loadProjects(configPath);
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1) throw new Error(`Project ${id} not found`);
  projects.splice(index, 1);
  saveProjects(configPath, projects);
}

// Stored is the account's ID, not its name: the name is display only, it
// isn't unique, and a rename would leave a dead value here.
//
// A removed account still leaves a dead value. That's caught at display
// time: the UI checks every preselection against the loaded account list,
// where a dead value behaves like "no default set".
export function setDefaultAccountId(configPath, id, accountId) {
  const projects = loadProjects(configPath);
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project ${id} not found`);
  if (accountId === null) delete project.defaultAccountId;
  else project.defaultAccountId = accountId;
  saveProjects(configPath, projects);
}

// Three levels rather than a boolean: a project can be worth a message when
// it BLOCKS on an answer without being worth one for every finished turn.
export const NOTIFY_LEVELS = ['all', 'blocking', 'none'];

// A missing field reads as 'all' - the projects that existed before this
// setting keep notifying, and an unreadable value does not silence one.
export function notifyLevel(project) {
  return NOTIFY_LEVELS.includes(project?.notify) ? project.notify : 'all';
}

export function setNotifyLevel(configPath, id, level) {
  if (!NOTIFY_LEVELS.includes(level)) throw new Error(`Unknown notify level ${level}`);
  const projects = loadProjects(configPath);
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project ${id} not found`);
  // The default is not stored, the same way setDefaultAccountId drops a
  // cleared default instead of writing null.
  if (level === 'all') delete project.notify;
  else project.notify = level;
  saveProjects(configPath, projects);
}
