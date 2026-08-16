// test/projectStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProjects, addProject, toggleFavorite, removeProject, setDefaultAccountId,
  notifyLevel, setNotifyLevel,
} from '../src/lib/projectStore.js';

test('loadProjects returns an empty array when the config file is missing', () => {
  const configPath = path.join(os.tmpdir(), `claudux-projects-${Date.now()}.json`);
  assert.deepEqual(loadProjects(configPath), []);
});

test('addProject creates the folder and saves the entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const projectPath = path.join(tmp, 'notes');

  const created = addProject(configPath, { name: 'Notes', projectPath });

  assert.ok(fs.existsSync(projectPath));
  assert.equal(created.name, 'Notes');
  assert.equal(created.favorite, false);
  assert.equal(loadProjects(configPath).length, 1);
});

// The check has to sit ahead of mkdirSync: a relative path would otherwise
// create a folder relative to the service's working directory, and
// sessionStore would derive a transcript directory that never fills.
test('addProject refuses a relative path and creates nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const before = fs.existsSync(path.join(process.cwd(), 'relative-project'));

  assert.throws(() => addProject(configPath, { name: 'X', projectPath: 'relative-project' }));

  assert.equal(fs.existsSync(path.join(process.cwd(), 'relative-project')), before);
  assert.deepEqual(loadProjects(configPath), []);
});

test('toggleFavorite toggles the favorite flag', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const created = addProject(configPath, { name: 'X', projectPath: path.join(tmp, 'x') });

  toggleFavorite(configPath, created.id);

  const [reloaded] = loadProjects(configPath);
  assert.equal(reloaded.favorite, true);
});

test('removeProject removes only the entry from projects.json, leaves the real folder untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const projectPath = path.join(tmp, 'y');
  const created = addProject(configPath, { name: 'Y', projectPath });

  removeProject(configPath, created.id);

  assert.deepEqual(loadProjects(configPath), []);
  assert.ok(fs.existsSync(projectPath), 'the real project folder must not be deleted');
});

test('removeProject throws when the id does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');

  assert.throws(() => removeProject(configPath, 'unknown-id'));
});

test('loadProjects returns an empty array on invalid JSON instead of crashing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  fs.writeFileSync(configPath, '{invalid');

  assert.deepEqual(loadProjects(configPath), []);
});

test('loadProjects returns an empty array when the content is valid JSON but not an array', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  fs.writeFileSync(configPath, '{}');

  assert.deepEqual(loadProjects(configPath), []);
});

test('setDefaultAccountId saves the account id on the project', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const created = addProject(configPath, { name: 'X', projectPath: path.join(tmp, 'x') });

  setDefaultAccountId(configPath, created.id, 'id-work');

  const [reloaded] = loadProjects(configPath);
  assert.equal(reloaded.defaultAccountId, 'id-work');
});

test('setDefaultAccountId overwrites an already set default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const created = addProject(configPath, { name: 'X', projectPath: path.join(tmp, 'x') });

  setDefaultAccountId(configPath, created.id, 'id-work');
  setDefaultAccountId(configPath, created.id, 'id-personal');

  const [reloaded] = loadProjects(configPath);
  assert.equal(reloaded.defaultAccountId, 'id-personal');
});

test('setDefaultAccountId with null removes the default again', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  const created = addProject(configPath, { name: 'X', projectPath: path.join(tmp, 'x') });
  setDefaultAccountId(configPath, created.id, 'id-work');

  setDefaultAccountId(configPath, created.id, null);

  const [reloaded] = loadProjects(configPath);
  assert.equal('defaultAccountId' in reloaded, false);
});

test('setDefaultAccountId throws on an unknown id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(tmp, 'projects.json');
  addProject(configPath, { name: 'X', projectPath: path.join(tmp, 'x') });

  assert.throws(() => setDefaultAccountId(configPath, 'does-not-exist', 'id-work'));
});

test('setDefaultAccountId stores and clears the id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-'));
  const configPath = path.join(dir, 'projects.json');
  const project = addProject(configPath, { name: 'one', projectPath: path.join(dir, 'one') });

  setDefaultAccountId(configPath, project.id, 'id-1');
  assert.equal(loadProjects(configPath)[0].defaultAccountId, 'id-1');

  setDefaultAccountId(configPath, project.id, null);
  assert.ok(!('defaultAccountId' in loadProjects(configPath)[0]));
});

test('a project without the field notifies', () => {
  // The projects that existed before this setting keep notifying, and
  // nothing has to be migrated.
  assert.equal(notifyLevel({ id: 'p1' }), 'all');
  assert.equal(notifyLevel(undefined), 'all');
  assert.equal(notifyLevel({ id: 'p1', notify: 'nonsense' }), 'all');
});

test('setNotifyLevel stores the two quiet levels', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-')), 'projects.json');
  const project = addProject(configPath, { name: 'P', projectPath: path.join(path.dirname(configPath), 'p') });

  setNotifyLevel(configPath, project.id, 'blocking');
  assert.equal(loadProjects(configPath)[0].notify, 'blocking');
  setNotifyLevel(configPath, project.id, 'none');
  assert.equal(loadProjects(configPath)[0].notify, 'none');
});

test('setting the level back to all removes the field', () => {
  // An absent field and 'all' mean the same thing. Writing it would put a
  // value into every project that says nothing.
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-')), 'projects.json');
  const project = addProject(configPath, { name: 'P', projectPath: path.join(path.dirname(configPath), 'p') });

  setNotifyLevel(configPath, project.id, 'none');
  setNotifyLevel(configPath, project.id, 'all');
  assert.equal('notify' in loadProjects(configPath)[0], false);
  assert.equal(notifyLevel(loadProjects(configPath)[0]), 'all');
});

test('an unknown level is refused and changes nothing', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-')), 'projects.json');
  const project = addProject(configPath, { name: 'P', projectPath: path.join(path.dirname(configPath), 'p') });
  setNotifyLevel(configPath, project.id, 'blocking');

  assert.throws(() => setNotifyLevel(configPath, project.id, 'quiet'));
  assert.equal(loadProjects(configPath)[0].notify, 'blocking');
});

test('setNotifyLevel on an unknown project throws', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-')), 'projects.json');
  assert.throws(() => setNotifyLevel(configPath, 'no-such-id', 'none'));
});
