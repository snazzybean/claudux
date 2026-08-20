import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { subagentsDirFor, parseAgentMeta, currentToolFromAgentTranscript, resolvedToolUseIds, subagentSnapshot } from '../src/lib/subagentWatcher.js';

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

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

test('currentToolFromAgentTranscript returns the last tool_use block', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }] } })
    + line({ type: 'user', message: { content: [] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
  assert.deepEqual(currentToolFromAgentTranscript(jsonl), { name: 'Bash', input: { command: 'ls' } });
});

test('currentToolFromAgentTranscript returns null without any tool_use block', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
  assert.equal(currentToolFromAgentTranscript(jsonl), null);
});

test('currentToolFromAgentTranscript skips broken lines', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: {} }] } })
    + '{ half a line\n';
  assert.deepEqual(currentToolFromAgentTranscript(jsonl), { name: 'Grep', input: {} });
});

test('resolvedToolUseIds collects tool_use_id from tool_result blocks', () => {
  const jsonl =
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'done' }] } });
  assert.deepEqual([...resolvedToolUseIds(jsonl)], ['toolu_1', 'toolu_2']);
});

test('resolvedToolUseIds ignores non-tool_result content and broken lines', () => {
  const jsonl = line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '{ broken\n';
  assert.deepEqual([...resolvedToolUseIds(jsonl)], []);
});

function writeAgent(dir, agentId, meta, transcriptLines) {
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), transcriptLines.map(line).join(''));
}

test('subagentSnapshot reads every agent in the subagents directory', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');

  writeAgent(subagentsDir, 'aaa111', { agentType: 'general-purpose', description: 'Explore', toolUseId: 'toolu_1' },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'auth' } }] } }]);
  writeAgent(subagentsDir, 'bbb222', { agentType: 'code-review', description: 'Review', toolUseId: 'toolu_2' },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.js' } }] } }]);

  const snapshot = subagentSnapshot(claudeHome, ['sess-1']).sort((a, b) => a.agentId.localeCompare(b.agentId));

  assert.deepEqual(snapshot, [
    {
      agentId: 'aaa111', agentType: 'general-purpose', description: 'Explore', spawnDepth: 1,
      currentTool: { name: 'Grep', input: { pattern: 'auth' } }, resolved: false,
    },
    {
      agentId: 'bbb222', agentType: 'code-review', description: 'Review', spawnDepth: 1,
      currentTool: { name: 'Read', input: { file_path: 'x.js' } }, resolved: false,
    },
  ]);
});

test('subagentSnapshot marks an agent resolved once the parent transcript carries its tool_result', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }));
  writeAgent(subagentsDir, 'aaa111', { agentType: 'general-purpose', toolUseId: 'toolu_1' }, []);

  const [agent] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agent.resolved, true);
});

test('subagentSnapshot returns an empty list without a subagents directory', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  assert.deepEqual(subagentSnapshot(claudeHome, ['sess-1']), []);
});

test('subagentSnapshot skips a meta.json without a matching jsonl instead of throwing', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  // meta.json written first, jsonl not yet - the two files don't land atomically.
  fs.writeFileSync(path.join(subagentsDir, 'agent-ccc333.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));

  const [agent] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agent.currentTool, null);
});
