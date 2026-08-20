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
import { readRegistry, reconcile } from './sessionRegistry.js';
import { listTmuxSessions, aliveSessionNames } from './tmuxManager.js';
import { getMeta, claudeSessionIdsForTmux } from './sessionMeta.js';

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
    // Set only for a NESTED agent - it names the agent that spawned this
    // one, and thus the transcript that will carry its tool_result.
    parentAgentId: typeof raw.parentAgentId === 'string' ? raw.parentAgentId : null,
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

// A subagent's own transcript carries no explicit completion marker, but
// its agentic loop stops emitting tool_use once it has nothing left to do -
// the same "no tool_use in the last turn" signal that ends any Claude Code
// turn. Used only where ID-based resolution isn't possible (no toolUseId,
// as with a slash-command-spawned agent): the toolUseId paths stay
// authoritative wherever an id exists, since they don't depend on guessing
// "no more tool calls are coming" from a file that could still grow.
export function agentAppearsDone(jsonlText) {
  let lastAssistant = null;
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (entry?.type === 'assistant') lastAssistant = entry;
  }
  const content = lastAssistant?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return !content.some((block) => block?.type === 'tool_use');
}

// The reliable "it's done" signal wherever a toolUseId exists: the caller
// recording a tool_result for the Task call. Collected from every user-role
// line, not just the last one: several subagents can resolve in one tick.
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

// Where an agent's completion is recorded depends on who spawned it, so
// three cases rather than one session-wide lookup. `ownTranscript` is the
// text subagentSnapshot already read for currentTool - null when that read
// failed, which agentAppearsDone reads as "not done".
function agentIsResolved(dir, meta, sessionResolved, ownTranscript) {
  // A slash command spawns an agent without a Task call, so there is no id
  // to look for anywhere - its own transcript is the only evidence there is.
  if (!meta.toolUseId) return agentAppearsDone(ownTranscript);
  // A nested agent's tool_result lands in the transcript of the AGENT that
  // spawned it, never in the session's own.
  if (meta.parentAgentId) {
    try {
      const parentPath = path.join(dir, `agent-${meta.parentAgentId}.jsonl`);
      return resolvedToolUseIds(readTranscriptTail(parentPath)).has(meta.toolUseId);
    } catch {
      // Parent file missing (an orphaned meta) or read mid-write - not
      // resolved yet, and never a reason to lose the whole snapshot.
      return false;
    }
  }
  return sessionResolved.has(meta.toolUseId);
}

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
    // Read once, used twice: the agent's own transcript answers both what
    // it is doing right now and - where no id links it to a caller -
    // whether it has stopped calling tools at all.
    let ownTranscript = null;
    try {
      ownTranscript = readTranscriptTail(path.join(dir, `agent-${agentId}.jsonl`));
    } catch {
      // The jsonl hasn't been written yet, or was read mid-write - the
      // agent still shows up, just without a current tool.
    }
    agents.push({
      agentId,
      agentType: meta.agentType,
      description: meta.description,
      spawnDepth: meta.spawnDepth,
      currentTool: currentToolFromAgentTranscript(ownTranscript),
      resolved: agentIsResolved(dir, meta, resolved, ownTranscript),
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
    const prior = previousMap.get(a.agentId);
    // Sticky once done. resolvedToolUseIds only sees the last 64 kB of the
    // transcript, so a session with many finished subagents eventually
    // scrolls an agent's tool_result out of that window and reports it
    // unresolved again - without the memory of the prior tick the agent
    // would flip back to 'active' and stay there. Nothing can legitimately
    // un-resolve an agent: its own file writes nothing more once it's done.
    const status = a.resolved || prior?.status === 'done' ? 'done' : 'active';
    const toolKey = toolKeyOf(a);
    // Once an agent is done its own file writes nothing further - comparing
    // toolKey there would only ever compare against itself.
    const changed = !prior || prior.status !== status || (status === 'active' && prior.toolKey !== toolKey);
    next.set(a.agentId, { status, toolKey });
    if (changed) events.push(eventFor(a, status));
  }
  return { events, next };
}

// One pass over every running, claudux-managed session: snapshot its
// subagents, diff against the previous tick, return only the sessions with
// a change. Deliberately its own registry/tmux loop rather than sharing
// runWatcherOnce's - that one also resolves accounts and sends
// notifications, neither of which subagent tracking needs.
export async function runSubagentWatcherOnce(config, state, {
  registryFn = () => readRegistry(config.claudeHome),
  listFn = () => listTmuxSessions(),
  snapshotFn = (sessionIds) => subagentSnapshot(config.claudeHome, sessionIds),
} = {}) {
  const registry = registryFn();
  const sessions = await listFn();
  // Same reconcile statusWatcher.js runs, and for the same reason: without
  // it, a session reassigned to a new id after /clear would leave
  // claudeSessionIdsForTmux unaware of the new file, and subagentSnapshot
  // would keep reading a subagents directory that stopped growing.
  reconcile(config.dataDir, registry, sessions.map((s) => s.name));
  const running = new Set(aliveSessionNames(sessions));

  const events = [];
  for (const [tmuxSession, entry] of registry) {
    if (!running.has(tmuxSession)) continue;
    const meta = getMeta(config.dataDir, tmuxSession);
    if (!meta) continue; // not a session Claudux started
    const sessionIds = claudeSessionIdsForTmux(config.dataDir, tmuxSession);
    const snapshot = snapshotFn(sessionIds);
    const { events: agentEvents, next } = diffSubagents(state.get(tmuxSession), snapshot);
    state.set(tmuxSession, next);
    if (agentEvents.length > 0) {
      events.push({ tmuxSession, sessionId: entry.sessionId, agents: agentEvents });
    }
  }
  // No leftovers, same reasoning as statusWatcher.js: otherwise this map
  // grows for the process's whole lifetime.
  for (const key of state.keys()) if (!running.has(key)) state.delete(key);
  return events;
}

export function startSubagentWatcherInterval(config, {
  intervalMs = 2000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  runFn = runSubagentWatcherOnce,
  onEvents = () => {},
} = {}) {
  const state = new Map();
  const timer = setIntervalFn(() => {
    runFn(config, state)
      .then(onEvents)
      .catch((err) => console.error(`subagentWatcher: pass failed: ${err.message}`));
  }, intervalMs);
  timer.unref?.();
  return () => clearIntervalFn(timer);
}
