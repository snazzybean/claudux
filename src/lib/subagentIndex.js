// Which agent transcript belongs to which spawning call. Claude Code names
// an agent's files after an id of its own, unrelated to the id of the call
// that started it, so the link exists nowhere but in the meta files beside
// them - the same ones subagentWatcher.js already reads for a different
// question.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseAgentMeta, AGENT_META_RE } from './subagentWatcher.js';

// The tool that spawns an agent, under the name it has now and the one it
// had before - Claudux also runs against older installations.
export const SPAWN_TOOLS = new Set(['Task', 'Agent']);

// A named agent carries no call id, so name and description together are all
// there is to go on. Both, not the name alone: a name gets reused, and the
// description is what Claude Code copies from the call into the meta.
function nameKey(name, description) {
  return `${name}\u0000${description ?? ''}`;
}

// One pass over a subagents directory, all three ways round. Read per call
// rather than cached: it is one readdir plus a handful of small files, and
// the caller only asks when a window actually carries a card.
//
// `names` is coarser than `byName` on purpose: it answers "is there any
// transcript under this name at all", which is what separates "nothing has
// been written yet" from "something has, and it cannot be attributed".
export function subagentIndex(dir) {
  const byToolUseId = new Map();
  const byName = new Map();
  const names = new Set();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    // A session that never spawned an agent has no such directory.
    return { byToolUseId, byName, names };
  }
  for (const file of files) {
    const match = AGENT_META_RE.exec(file);
    if (!match) continue;
    let meta;
    try {
      meta = parseAgentMeta(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // Read mid-write, or gone again between readdir and open.
    }
    if (!meta) continue;
    if (meta.toolUseId) byToolUseId.set(meta.toolUseId, match[1]);
    if (meta.name) {
      names.add(meta.name);
      const key = nameKey(meta.name, meta.description);
      byName.set(key, [...(byName.get(key) ?? []), match[1]]);
    }
  }
  return { byToolUseId, byName, names };
}

// A megabyte at a time, decoded across the seams: a transcript runs to tens
// of megabytes here, and splitting one whole into lines costs several times
// its size in memory.
const SCAN_CHUNK = 1024 * 1024;

function countLine(counts, line) {
  // Cheap gate before the parse: most lines of a transcript are turns, and
  // only a tool_use line can hold a spawning call.
  if (!line.includes('"tool_use"')) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return; // Read mid-write, or a fragment - not an error.
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part?.type !== 'tool_use' || !SPAWN_TOOLS.has(part.name)) continue;
    if (typeof part.input?.name !== 'string' || !part.input.name) continue;
    const key = nameKey(part.input.name, typeof part.input.description === 'string' ? part.input.description : '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

// How many NAMED spawning calls a whole transcript makes, per key - a call
// without a name is not counted at all, because only the name path ever asks.
//
// The whole file and not the window being rendered: five of six calls under
// one key routinely sit outside it, and a count taken from the window would
// call the sixth one unique.
export function countSpawnCalls(filePath) {
  const counts = new Map();
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return counts;
  }
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, SCAN_CHUNK, null);
      if (read === 0) break;
      const lines = (rest + decoder.write(buffer.subarray(0, read))).split('\n');
      rest = lines.pop();
      for (const line of lines) countLine(counts, line);
    }
  } finally {
    fs.closeSync(fd);
  }
  countLine(counts, rest + decoder.end());
  return counts;
}

// The scan above, deferred and done at most once. Handed to agentIdFor
// rather than called before it, because only a call that has a name, no
// usable call id and exactly one candidate meta needs it at all - for every
// other card the answer is the same whatever the count says.
export function spawnCallCounter(filePath) {
  let counts = null;
  return () => (counts ??= countSpawnCalls(filePath));
}

// Three answers, not two: the id, "nothing on disk carries this name", and
// "something does, but which one is not decidable". The last is not the
// absence of a transcript, so it must not read as one.
//
// The call id decides where there is one; it is the only key that proves
// anything. A name resolves only as one half of a ONE-TO-ONE pair - one meta
// answering to the call, and one call answering to that meta. One meta is
// not enough on its own: six calls made under the same name and description,
// with a single file on disk, would each claim it, and five of the six would
// be showing another agent's conversation.
//
// Even paired it stays a heuristic, because the counts are taken over the
// whole transcript and the whole directory while a card comes out of one
// window: a name whose second call has not been written yet pairs, and stops
// pairing when it is. Weaker than a proof, never wrong in the dangerous
// direction - it only ever moves a card from open to "cannot say".
export function agentIdFor(index, callCounts, { toolUseId = null, name = null, description = null } = {}) {
  if (toolUseId && index.byToolUseId.has(toolUseId)) {
    return { agentId: index.byToolUseId.get(toolUseId), ambiguous: false };
  }
  // The name alone, deliberately coarser than the key below: it answers
  // whether anything at all was written under this name, which is what
  // separates "wait a moment" from "cannot be attributed".
  if (!name || !index.names.has(name)) return { agentId: null, ambiguous: false };
  const candidates = index.byName.get(nameKey(name, description)) ?? [];
  if (candidates.length !== 1) return { agentId: null, ambiguous: true };
  const calls = callCounts().get(nameKey(name, description)) ?? 0;
  return calls === 1 ? { agentId: candidates[0], ambiguous: false } : { agentId: null, ambiguous: true };
}
