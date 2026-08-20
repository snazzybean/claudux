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

// What an agent (main session or subagent) is doing RIGHT NOW: the last
// tool_use block of its own transcript. Same skip-broken-lines handling as
// contextFromTranscript - these files can be read mid-write.
export function currentToolFromAgentTranscript(jsonlText) {
  let tool = null;
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        tool = { name: block.name, input: block.input ?? null };
      }
    }
  }
  return tool;
}

// A subagent's own transcript carries no completion marker - the only
// reliable "it's done" signal is the PARENT session recording a tool_result
// for the Task call's toolUseId. Collected from every user-role line, not
// just the last one: several subagents can resolve within the same tick.
export function resolvedToolUseIds(transcriptText) {
  const ids = new Set();
  for (const rawLine of String(transcriptText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (entry?.type !== 'user') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}
