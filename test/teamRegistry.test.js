import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveTeamMembers } from '../src/lib/teamRegistry.js';

function tmpHome(teamName, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  if (config !== undefined) {
    const dir = path.join(home, 'teams', teamName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }
  return home;
}

test('liveTeamMembers names every agent the team currently holds', () => {
  const home = tmpHome('session-abc', {
    name: 'session-abc',
    members: [
      { agentId: 'team-lead@session-abc', name: 'team-lead' },
      { agentId: 'Probe@session-abc', name: 'Probe' },
    ],
  });
  assert.deepEqual([...liveTeamMembers(home, 'session-abc')].sort(), ['Probe', 'team-lead']);
});

// Absent registry and empty registry are different answers: "nothing is
// running" versus "this cannot be answered here", and only the first one
// may be read as "that agent is gone".
test('liveTeamMembers returns null when there is no registry to read', () => {
  assert.equal(liveTeamMembers(tmpHome('session-abc'), 'session-abc'), null);
});

test('liveTeamMembers returns null for a registry that does not parse', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  const dir = path.join(home, 'teams', 'session-abc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.equal(liveTeamMembers(home, 'session-abc'), null);
});

test('liveTeamMembers returns an empty set for a team with no members left', () => {
  const home = tmpHome('session-abc', { name: 'session-abc', members: [] });
  assert.deepEqual([...liveTeamMembers(home, 'session-abc')], []);
});

// The team name comes out of a file Claude Code wrote, but it reaches a
// path.join all the same.
test('liveTeamMembers refuses a team name that could leave the teams directory', () => {
  const home = tmpHome('session-abc', { name: 'session-abc', members: [{ name: 'Probe' }] });
  assert.equal(liveTeamMembers(home, '../../elsewhere'), null);
});
