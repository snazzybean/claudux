//
// A `Task`-tool subagent runs in the SAME process and PTY as the session
// that spawned it (verified against tmuxManager.js: no window-per-subagent
// logic exists there). What it does still lands on disk, though - Claude
// Code writes each subagent its own transcript at
// <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl, with an
// agent-<agentId>.meta.json alongside it. This module turns that into the
// same kind of per-tick delta statusWatcher.js already produces for a
// session's own status.
import fs from 'node:fs';
import path from 'node:path';

// A session's own transcript sits at <projectDir>/<sessionId>.jsonl; its
// subagents live in the sibling directory <projectDir>/<sessionId>/subagents.
// Deriving it from the transcript's own path (rather than rebuilding it from
// a claudeHome + sessionId pair) means it always agrees with whichever file
// contextUsage.chooseTranscript actually picked - including after a /clear.
export function subagentsDirFor(transcriptPath) {
  if (!transcriptPath) return null;
  const sessionId = path.basename(transcriptPath, '.jsonl');
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents');
}

export function parseAgentMeta(rawJson) {
  let raw;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.agentType !== 'string') return null;
  return {
    agentType: raw.agentType,
    description: typeof raw.description === 'string' ? raw.description : '',
    toolUseId: typeof raw.toolUseId === 'string' ? raw.toolUseId : null,
    spawnDepth: Number.isFinite(raw.spawnDepth) ? raw.spawnDepth : 1,
  };
}
