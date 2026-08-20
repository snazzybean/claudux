import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { subagentsDirFor, parseAgentMeta } from '../src/lib/subagentWatcher.js';

// Claude Code writes a session's own transcript at
// <projectDir>/<sessionId>.jsonl and its subagents' transcripts at
// <projectDir>/<sessionId>/subagents/agent-<id>.jsonl - verified against
// real files under ~/.claude/projects/*/*/subagents/.
test('subagentsDirFor derives the sibling subagents directory from the transcript path', () => {
  const transcriptPath = '/root/.claude/projects/-srv-project/abc-123.jsonl';
  assert.equal(
    subagentsDirFor(transcriptPath),
    path.join('/root/.claude/projects/-srv-project', 'abc-123', 'subagents'),
  );
});

test('subagentsDirFor returns null without a transcript path', () => {
  assert.equal(subagentsDirFor(null), null);
});

test('parseAgentMeta reads agentType, description, toolUseId, and spawnDepth', () => {
  const raw = JSON.stringify({
    agentType: 'general-purpose',
    description: 'Angle Efficiency',
    toolUseId: 'toolu_01Bu4gHiR5R22yqLC6sRSyGa',
    parentAgentId: 'a19c417324c2ebbb8',
    spawnDepth: 2,
  });
  assert.deepEqual(parseAgentMeta(raw), {
    agentType: 'general-purpose',
    description: 'Angle Efficiency',
    toolUseId: 'toolu_01Bu4gHiR5R22yqLC6sRSyGa',
    spawnDepth: 2,
  });
});

test('parseAgentMeta defaults a missing description and spawnDepth', () => {
  const raw = JSON.stringify({ agentType: 'code-review', toolUseId: 'toolu_1' });
  assert.deepEqual(parseAgentMeta(raw), {
    agentType: 'code-review',
    description: '',
    toolUseId: 'toolu_1',
    spawnDepth: 1,
  });
});

test('parseAgentMeta rejects broken JSON and a missing agentType', () => {
  assert.equal(parseAgentMeta('{ half a line'), null);
  assert.equal(parseAgentMeta(JSON.stringify({ description: 'no type' })), null);
});
