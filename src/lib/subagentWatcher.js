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
import { chooseTranscript, readTranscriptTail } from './contextUsage.js';

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

const AGENT_META_RE = /^agent-([a-zA-Z0-9]+)\.meta\.json$/;

// One snapshot of every subagent currently on disk for a session - no
// history, no diffing. `sessionIds` are every id the tmux session may have
// carried across a /clear (see contextUsage.chooseTranscript) - subagents
// belong to whichever file is the CURRENT one.
export function subagentSnapshot(claudeHome, sessionIds) {
  const transcriptPath = chooseTranscript(claudeHome, sessionIds);
  const dir = subagentsDirFor(transcriptPath);
  if (!dir) return [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    // No subagents directory: a session that never spawned a Task, not an
    // error.
    return [];
  }
  let resolved;
  try {
    resolved = resolvedToolUseIds(readTranscriptTail(transcriptPath));
  } catch {
    resolved = new Set();
  }

  const agents = [];
  for (const file of files) {
    const match = AGENT_META_RE.exec(file);
    if (!match) continue;
    const agentId = match[1];
    let meta;
    try {
      meta = parseAgentMeta(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!meta) continue;
    let currentTool = null;
    try {
      currentTool = currentToolFromAgentTranscript(readTranscriptTail(path.join(dir, `agent-${agentId}.jsonl`)));
    } catch {
      // The jsonl hasn't been written yet, or was read mid-write - the
      // agent still shows up, just without a current tool.
    }
    agents.push({
      agentId,
      agentType: meta.agentType,
      description: meta.description,
      spawnDepth: meta.spawnDepth,
      currentTool,
      resolved: meta.toolUseId ? resolved.has(meta.toolUseId) : false,
    });
  }
  return agents;
}

function toolKeyOf(agent) {
  return agent.currentTool ? `${agent.currentTool.name}:${JSON.stringify(agent.currentTool.input)}` : null;
}

function eventFor(agent, status) {
  return {
    agentId: agent.agentId,
    agentType: agent.agentType,
    description: agent.description,
    spawnDepth: agent.spawnDepth,
    currentTool: agent.currentTool,
    status,
  };
}

// Compares a fresh snapshot against what the previous tick knew.
//
// A `done` agent stays in `next` with that status FOREVER (for the life of
// this process's state Map) rather than being dropped - see the task
// description above for why dropping it re-fires the event forever.
export function diffSubagents(previous, snapshot) {
  const previousMap = previous ?? new Map();
  const next = new Map();
  const events = [];
  for (const a of snapshot) {
    const status = a.resolved ? 'done' : 'active';
    const toolKey = toolKeyOf(a);
    const prior = previousMap.get(a.agentId);
    // Once an agent is done its own file writes nothing further - comparing
    // toolKey there would only ever compare against itself.
    const changed = !prior || prior.status !== status || (status === 'active' && prior.toolKey !== toolKey);
    next.set(a.agentId, { status, toolKey });
    if (changed) events.push(eventFor(a, status));
  }
  return { events, next };
}
