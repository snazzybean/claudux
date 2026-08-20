// Whether a subagent has finished. Four kinds of evidence, because Claude
// Code records a different one depending on how the agent was started and how
// it ended - and each of them alone was wrong about some common case:
//
//   * a `Task` agent's caller records a tool_result for its id (exact),
//   * a nested one's lands in its PARENT agent's transcript, not the
//     session's - measured here, 0 of 8 nested agents were resolvable from
//     the session file and all 8 from their parent's,
//   * a named agent records no id anywhere: its team's registry says whether
//     it still exists, and a terminal stop_reason in its own transcript says
//     whether it has answered. It stays a member after answering, so the
//     registry alone counted every finished agent as running,
//   * and an agent interrupted mid-turn writes no closing message at all,
//     which leaves nothing but silence.
//
// It decides and reads nothing: every piece of evidence is handed in, which
// is what keeps the file reading in subagentSnapshot and this testable
// against plain values.
import { liveTeamMembers } from './teamRegistry.js';

// Nothing written for this long and the agent is treated as gone. The last
// resort only, where neither an id nor a registry can answer - which after
// the registry is a `Task` agent whose caller never recorded a result.
// Reported separately from `resolved` and not sticky, since a slow tool call
// looks the same and has to be able to come back.
export const SILENT_DONE_MS = 10 * 60 * 1000;

// An agent's registry entry and its meta file are written at almost the same
// moment. Reading between the two must not brand a brand-new agent as
// finished, because that verdict is sticky.
const REGISTRY_GRACE_MS = 3000;

// Whether an agent's own transcript ends on a turn that is actually over.
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
  // "No tool_use in the last turn" alone is not enough, and the difference is
  // the common case rather than the edge: an agent that writes a line of
  // commentary between two tool calls looks exactly like one that has
  // answered - and since 'done' is sticky, its window faded mid-work and
  // never came back. An ended turn says so; a turn still in flight carries
  // stop_reason null.
  return TERMINAL_STOP_REASONS.has(lastAssistant.message?.stop_reason);
}

// `ownTranscript` is the text the snapshot already read for the agent's
// current tool - null when that read failed, which agentAppearsDone reads as
// "not done". `parentResolved` is the id set of the spawning agent's
// transcript, or null when there is no usable parent.
export function agentIsResolved(claudeHome, meta, {
  sessionResolved,
  parentResolved,
  ownTranscript,
  silentForMs,
  superseded,
}) {
  // A newer agent carries this one's name now, so the team's entry is not
  // about this instance - and a team never holds two of a name at once.
  if (superseded) return true;
  // A named agent has two signals, and each covers the other's blind spot.
  // Gone from the registry means stopped or killed, which leaves no closing
  // message behind; an ended turn means it has answered, member or not.
  if (meta.name && meta.teamName) {
    if (agentAppearsDone(ownTranscript)) return true;
    const live = liveTeamMembers(claudeHome, meta.teamName);
    // null means the registry could not be read, not that the team is empty -
    // only a readable one may be taken as evidence.
    if (live) return !live.has(meta.name) && silentForMs >= REGISTRY_GRACE_MS;
  }
  // A slash command spawns an agent without a Task call, so there is no id to
  // look for anywhere - its own transcript is the only evidence there is.
  if (!meta.toolUseId) return agentAppearsDone(ownTranscript);
  if (meta.parentAgentId) return parentResolved?.has(meta.toolUseId) === true;
  return sessionResolved.has(meta.toolUseId);
}
