// Which named agents a team currently holds. Claude Code keeps this at
// <claudeHome>/teams/<teamName>/config.json and rewrites it as members come
// and go - verified on this host: a teammate appears in `members` the moment
// it is spawned and is gone from there the moment it is stopped, finished or
// aborted alike.
//
// That makes it the only exact answer for an agent with no toolUseId: a
// named agent records no tool_result anywhere, and an aborted one writes no
// closing message either, so without this the alternative was to wait out a
// silence.
import fs from 'node:fs';
import path from 'node:path';

// The name comes out of an agent's own meta.json, but it reaches a
// path.join, so it is held to a whitelist the same way an agent id is.
const TEAM_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// A missing or unreadable registry returns null, not an empty set: "nothing
// is running" and "this cannot be answered here" are different answers, and
// only the first one may be read as "that agent is gone".
export function liveTeamMembers(claudeHome, teamName) {
  if (typeof teamName !== 'string' || !TEAM_NAME_RE.test(teamName)) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(claudeHome, 'teams', teamName, 'config.json'), 'utf8');
  } catch {
    return null;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    // Read mid-write, same as any of these files.
    return null;
  }
  if (!Array.isArray(config?.members)) return null;
  const names = new Set();
  for (const member of config.members) {
    if (typeof member?.name === 'string') names.add(member.name);
  }
  return names;
}
