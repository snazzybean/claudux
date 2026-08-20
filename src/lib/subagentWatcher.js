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
import { createResolvedTracker } from './resolvedIds.js';
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

// Whether an agent's own transcript ends on a turn that is actually over.
// Used only where no toolUseId links the agent to a caller (a named agent
// or a slash-command one); wherever an id exists it stays authoritative,
// since it does not have to read the end of a file that could still grow.
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

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
  if (content.some((block) => block?.type === 'tool_use')) return false;
  // "No tool_use in the last turn" alone is not enough, and the difference
  // is the common case rather than the edge: an agent that writes a line
  // of commentary between two tool calls looks exactly like one that has
  // answered - and since 'done' is sticky, its node faded mid-work and
  // never came back. An ended turn says so; a turn still in flight
  // carries stop_reason null.
  return TERMINAL_STOP_REASONS.has(lastAssistant.message?.stop_reason);
}

// An agent spawned under a name carries that name in its id, hyphen
// included (agent-aExportSweep-acebce40dd0e83d3), so the class cannot be
// alphanumeric only - that skipped such an agent entirely. It stays a
// whitelist all the same: the id goes straight into a path.join, and
// neither a dot nor a separator gets in.
export const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const AGENT_META_RE = /^agent-([a-zA-Z0-9_-]+)\.meta\.json$/;

// Where an agent's completion is recorded depends on who spawned it, so
// three cases rather than one session-wide lookup. `ownTranscript` is the
// text subagentSnapshot already read for currentTool - null when that read
// failed, which agentAppearsDone reads as "not done".
// Nothing written for this long and the agent is treated as gone. It is
// the only signal an interrupted agent leaves - it writes no closing
// message and no id is ever recorded for it, so nothing on disk tells it
// apart from one waiting on a slow tool call. Which is why it is reported
// separately from `resolved` and is not sticky: a genuinely slow agent
// comes back on its next line, and ten minutes is short enough that an
// abandoned one is not still circling long after the fact.
const SILENT_DONE_MS = 10 * 60 * 1000;

function agentIsResolved(dir, meta, sessionResolved, ownTranscript, tracker) {
  // A slash command spawns an agent without a Task call, so there is no id
  // to look for anywhere - its own transcript is the only evidence there is.
  if (!meta.toolUseId) return agentAppearsDone(ownTranscript);
  // A nested agent's tool_result lands in the transcript of the AGENT that
  // spawned it, never in the session's own - measured: 0 of 8 nested agents
  // were resolvable from the session file, all 8 from their parent's.
  if (meta.parentAgentId) {
    // Held to the same whitelist as an agent's own id: it reaches the same
    // path.join, and only the id in the FILE NAME was ever checked.
    if (!AGENT_ID_RE.test(meta.parentAgentId)) return false;
    try {
      const parentPath = path.join(dir, `agent-${meta.parentAgentId}.jsonl`);
      return tracker.idsFor(parentPath).has(meta.toolUseId);
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
export function subagentSnapshot(claudeHome, sessionIds, tracker = createResolvedTracker()) {
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
    resolved = tracker.idsFor(transcriptPath);
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
    let silentForMs = 0;
    try {
      const agentPath = path.join(dir, `agent-${agentId}.jsonl`);
      silentForMs = Date.now() - fs.statSync(agentPath).mtimeMs;
      ownTranscript = readTranscriptTail(agentPath);
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
      resolved: agentIsResolved(dir, meta, resolved, ownTranscript, tracker),
      silent: silentForMs >= SILENT_DONE_MS,
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
    // Sticky once resolved: nothing can legitimately un-resolve an agent,
    // since its own file writes nothing more once it's finished. Kept as a
    // floor under the resolution in resolvedIds.js rather than as its
    // fallback. Silence is deliberately outside that memory - it is a guess
    // about an agent that may still be working, and a slow one has to be
    // able to come back rather than stay pinned as finished.
    const settled = a.resolved || prior?.settled === true;
    const status = settled || a.silent ? 'done' : 'active';
    const toolKey = toolKeyOf(a);
    // Once an agent is done its own file writes nothing further - comparing
    // toolKey there would only ever compare against itself.
    // A first sighting that is already done is not news: no client has
    // ever heard of this agent, so there is no node to take away. Every
    // restart reads a session's finished subagents back in, and on a long
    // session that is dozens of them.
    const firstSightDone = !prior && status === 'done';
    const changed = !firstSightDone && (!prior || prior.status !== status || (status === 'active' && prior.toolKey !== toolKey));
    next.set(a.agentId, { status, settled, toolKey });
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
  // Own tracker per call unless one is handed in: correct either way, but
  // only a tracker that outlives the call reads a transcript once instead
  // of on every pass.
  tracker = createResolvedTracker(),
  registryFn = () => readRegistry(config.claudeHome),
  listFn = () => listTmuxSessions(),
  snapshotFn = (sessionIds) => subagentSnapshot(config.claudeHome, sessionIds, tracker),
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
  const tracker = createResolvedTracker();
  // Everything already published, merged per session. A client that
  // connects later never saw the deltas that made the running agents
  // appear, and the stream has nothing else to offer it - so the same
  // deltas, merged, are its opening picture. Merged here rather than read
  // from disk again: this is by definition what the earlier clients got.
  const published = new Map();

  function record(events) {
    for (const event of events) {
      const entry = published.get(event.tmuxSession) ?? { sessionId: event.sessionId, agents: new Map() };
      entry.sessionId = event.sessionId;
      for (const agent of event.agents) entry.agents.set(agent.agentId, agent);
      published.set(event.tmuxSession, entry);
    }
    // runSubagentWatcherOnce drops a session that stopped running from
    // `state`; without the same pruning here, its agents would be replayed
    // to every new client for the rest of the process's life.
    for (const key of published.keys()) if (!state.has(key)) published.delete(key);
  }

  const timer = setIntervalFn(() => {
    runFn(config, state, { tracker })
      .then((events) => {
        record(events);
        onEvents(events);
      })
      .catch((err) => console.error(`subagentWatcher: pass failed: ${err.message}`));
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearIntervalFn(timer),
    // Only what is still running: diffSubagents keeps a finished agent in
    // its state forever, and replaying one would have a fresh client fade
    // out a node it never saw appear.
    currentEvents() {
      const events = [];
      for (const [tmuxSession, entry] of published) {
        const agents = [...entry.agents.values()].filter((agent) => agent.status === 'active');
        if (agents.length > 0) events.push({ tmuxSession, sessionId: entry.sessionId, agents });
      }
      return events;
    },
  };
}
