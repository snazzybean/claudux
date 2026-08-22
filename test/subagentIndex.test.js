import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subagentIndex, agentIdFor, countSpawnCalls, spawnCallCounter } from '../src/lib/subagentIndex.js';

// A directory holding the meta files, and beside it the transcript whose
// calls they answer to - the pairing needs both sides, so every case here
// states both.
function fixture(metas, calls = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-index-'));
  const dir = path.join(root, 'subagents');
  fs.mkdirSync(dir);
  for (const [agentId, meta] of Object.entries(metas)) {
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), typeof meta === 'string' ? meta : JSON.stringify(meta));
  }
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, calls.map((input, i) => `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `toolu_0${i}`, name: 'Agent', input }] },
  })}\n`).join(''));
  return { dir, transcript };
}

function lookUp({ dir, transcript }, spec) {
  return agentIdFor(subagentIndex(dir), spawnCallCounter(transcript), spec);
}

// The two ids are unrelated strings - only the meta file beside the
// transcript links them.
test('subagentIndex maps a spawning call to the file name of the agent it spawned', () => {
  const f = fixture({ a0011aa22bb33cc44: { agentType: 'general-purpose', toolUseId: 'toolu_01AAA' } });
  assert.deepEqual(lookUp(f, { toolUseId: 'toolu_01AAA' }), { agentId: 'a0011aa22bb33cc44', ambiguous: false });
});

// A teammate spawned under a name gets no call id in its meta at all, so the
// name is the only thing left to identify it by - and only as one half of a
// pair that has no second claimant on either side.
test('subagentIndex pairs a teammate with the one call that answers to it', () => {
  const f = fixture(
    { 'aprobe-run-99887766': { agentType: 'probe-run', description: 'measure it', name: 'probe-run', teamName: 'session-abc' } },
    [{ name: 'probe-run', description: 'measure it' }],
  );
  assert.deepEqual(
    lookUp(f, { name: 'probe-run', description: 'measure it' }),
    { agentId: 'aprobe-run-99887766', ambiguous: false },
  );
});

// THE dangerous case: same name, same description, one file on disk. Each
// card would claim it, and all but one would show another agent's
// conversation.
test('subagentIndex refuses when several identical calls face a single meta', () => {
  const f = fixture(
    { 'aprobe-run-1111': { agentType: 'probe-run', description: 'measure it', name: 'probe-run' } },
    [{ name: 'probe-run', description: 'measure it' }, { name: 'probe-run', description: 'measure it' }],
  );
  assert.deepEqual(lookUp(f, { name: 'probe-run', description: 'measure it' }), { agentId: null, ambiguous: true });
});

// The other side of the same pairing.
test('subagentIndex refuses when one call faces several metas', () => {
  const f = fixture(
    {
      'aprobe-run-1111': { agentType: 'probe-run', description: 'measure it', name: 'probe-run' },
      'aprobe-run-2222': { agentType: 'probe-run', description: 'measure it', name: 'probe-run' },
    },
    [{ name: 'probe-run', description: 'measure it' }],
  );
  assert.deepEqual(lookUp(f, { name: 'probe-run', description: 'measure it' }), { agentId: null, ambiguous: true });
});

// A name whose transcripts are all under other descriptions: something IS on
// disk under that name, so this is "cannot be attributed", not "nothing has
// been written".
test('subagentIndex calls a name on disk with another description ambiguous, not absent', () => {
  const f = fixture(
    { 'aprobe-run-1111': { agentType: 'probe-run', description: 'the first errand', name: 'probe-run' } },
    [{ name: 'probe-run', description: 'the first errand' }, { name: 'probe-run', description: 'a different errand' }],
  );
  assert.deepEqual(lookUp(f, { name: 'probe-run', description: 'a different errand' }), { agentId: null, ambiguous: true });
  assert.equal(lookUp(f, { name: 'probe-run', description: 'the first errand' }).agentId, 'aprobe-run-1111');
});

// The call id is unique where it exists, so it answers even for a name that
// no pairing could settle.
test('agentIdFor prefers the call id over an unpairable name', () => {
  const f = fixture(
    {
      'aprobe-run-1111': { agentType: 'probe-run', description: 'measure it', name: 'probe-run' },
      'aprobe-run-2222': { agentType: 'probe-run', description: 'measure it', name: 'probe-run' },
      a3333: { agentType: 'probe-run', toolUseId: 'toolu_01BBB' },
    },
    [{ name: 'probe-run', description: 'measure it' }],
  );
  assert.deepEqual(
    lookUp(f, { toolUseId: 'toolu_01BBB', name: 'probe-run', description: 'measure it' }),
    { agentId: 'a3333', ambiguous: false },
  );
});

// "Nothing on disk carries this name" is the one answer that means there is
// no transcript, and the only one worth waiting for.
test('agentIdFor answers null without ambiguity for a name nothing on disk carries', () => {
  const f = fixture({ a0011: { agentType: 'general-purpose', toolUseId: 'toolu_01AAA' } });
  assert.deepEqual(lookUp(f, { toolUseId: 'toolu_01ZZZ' }), { agentId: null, ambiguous: false });
  assert.deepEqual(lookUp(f, { name: 'never-ran', description: 'x' }), { agentId: null, ambiguous: false });
  assert.deepEqual(lookUp(f, {}), { agentId: null, ambiguous: false });
});

// A session that never spawned an agent has no such directory - not an error.
test('subagentIndex reads a missing directory as an empty one', () => {
  const counts = spawnCallCounter(path.join(os.tmpdir(), 'no-such-transcript.jsonl'));
  const empty = subagentIndex(path.join(os.tmpdir(), 'no-such-subagents-dir'));
  assert.equal(agentIdFor(empty, counts, { toolUseId: 'toolu_01AAA' }).agentId, null);
  assert.equal(agentIdFor(subagentIndex(null), counts, { name: 'x', description: 'y' }).agentId, null);
});

// These files are read while Claude Code writes them.
test('subagentIndex skips a meta it cannot read and keeps the rest', () => {
  const f = fixture({
    a0011: '{"agentType":"general-pur',
    a0022: { agentType: 'general-purpose', toolUseId: 'toolu_01BBB' },
  });
  assert.equal(lookUp(f, { toolUseId: 'toolu_01BBB' }).agentId, 'a0022');
});

// Everything else in that directory is the transcripts themselves.
test('subagentIndex looks at meta files only', () => {
  const { dir } = fixture({ a0011: { agentType: 'general-purpose', toolUseId: 'toolu_01AAA' } });
  fs.writeFileSync(path.join(dir, 'agent-a0011.jsonl'), '{"type":"assistant"}\n');
  assert.equal(subagentIndex(dir).byToolUseId.size, 1);
});

// The separator is written as an escape. A literal control byte in the
// source would work and be invisible - no lint and no behaviour test can see
// one, which is the whole reason this looks at the file instead.
test('the key separator is an escape in the source, not a raw byte', () => {
  const source = fs.readFileSync(new URL('../src/lib/subagentIndex.js', import.meta.url));
  assert.equal(source.includes(0), false);
});

// Two agents whose name and description happen to join to the same string
// must not read as one entry.
test('subagentIndex keeps name and description apart in its key', () => {
  const f = fixture(
    {
      a0011: { agentType: 'x', name: 'probe', description: 'run twice' },
      a0022: { agentType: 'x', name: 'probe run', description: 'twice' },
    },
    [{ name: 'probe', description: 'run twice' }, { name: 'probe run', description: 'twice' }],
  );
  assert.equal(lookUp(f, { name: 'probe', description: 'run twice' }).agentId, 'a0011');
  assert.equal(lookUp(f, { name: 'probe run', description: 'twice' }).agentId, 'a0022');
});

// ---------- counting the calls ----------

test('countSpawnCalls counts each name and description separately', () => {
  const { transcript } = fixture({}, [
    { name: 'probe', description: 'once' },
    { name: 'probe', description: 'once' },
    { name: 'probe', description: 'twice' },
    { subagent_type: 'Explore', description: 'unnamed calls do not count' },
  ]);
  const counts = countSpawnCalls(transcript);
  assert.equal(counts.size, 2);
  assert.deepEqual([...counts.values()].sort(), [1, 2]);
});

// A call can sit anywhere in a transcript, and a chunked read must not lose
// one on a chunk boundary or garble a description that straddles it.
test('countSpawnCalls reads past its chunk size and across a split character', () => {
  const { transcript } = fixture({}, [{ name: 'probe', description: 'Kommentardichte über alles' }]);
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 * 1024 * 1024) } })}\n${fs.readFileSync(transcript, 'utf8')}`,
  );
  const counts = countSpawnCalls(transcript);
  assert.equal(counts.size, 1);
  assert.equal([...counts.values()][0], 1);
});

test('countSpawnCalls reads a file that is not there as no calls at all', () => {
  assert.equal(countSpawnCalls(path.join(os.tmpdir(), 'no-such-transcript.jsonl')).size, 0);
});

// A card that could never pair must not cost a scan of a transcript that
// runs to tens of megabytes.
test('agentIdFor leaves the transcript unread where the count cannot change the answer', () => {
  const f = fixture({ a0011: { agentType: 'x', toolUseId: 'toolu_01AAA' } });
  let scans = 0;
  const counting = () => { scans += 1; return new Map(); };
  const index = subagentIndex(f.dir);
  agentIdFor(index, counting, { toolUseId: 'toolu_01AAA' });
  agentIdFor(index, counting, { name: 'never-ran', description: 'x' });
  agentIdFor(index, counting, {});
  assert.equal(scans, 0);
});

test('spawnCallCounter scans at most once however often it is asked', () => {
  const { transcript } = fixture({}, [{ name: 'probe', description: 'once' }]);
  const counter = spawnCallCounter(transcript);
  const first = counter();
  assert.equal(counter(), first);
});
