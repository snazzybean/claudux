import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setMeta } from '../src/lib/sessionMeta.js';
import { subagentsDirFor, parseAgentMeta, currentToolFromAgentTranscript, resolvedToolUseIds, subagentSnapshot, diffSubagents, runSubagentWatcherOnce, startSubagentWatcherInterval } from '../src/lib/subagentWatcher.js';

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

function agent(overrides) {
  return {
    agentId: 'aaa111', agentType: 'general-purpose', description: 'Explore', spawnDepth: 1,
    currentTool: { name: 'Grep', input: { pattern: 'auth' } }, resolved: false,
    ...overrides,
  };
}

test('diffSubagents reports a brand-new agent', () => {
  const { events, next } = diffSubagents(undefined, [agent()]);
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, 'aaa111');
  assert.equal(events[0].status, 'active');
  assert.equal(next.get('aaa111').status, 'active');
});

test('diffSubagents stays quiet when nothing changed', () => {
  const first = diffSubagents(undefined, [agent()]);
  const second = diffSubagents(first.next, [agent()]);
  assert.deepEqual(second.events, []);
});

test('diffSubagents reports a changed current tool as the same agent, still active', () => {
  const first = diffSubagents(undefined, [agent()]);
  const second = diffSubagents(first.next, [agent({ currentTool: { name: 'Read', input: { file_path: 'x.js' } } })]);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].status, 'active');
  assert.equal(second.events[0].currentTool.name, 'Read');
});

test('diffSubagents reports the transition to done exactly once', () => {
  const first = diffSubagents(undefined, [agent()]);
  const second = diffSubagents(first.next, [agent({ resolved: true })]);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].status, 'done');

  // The regression this guards against: a naive implementation that drops
  // 'done' agents from `next` instead of keeping them would see no `prior`
  // on this third tick and re-report 'done' as if the agent were new again.
  const third = diffSubagents(second.next, [agent({ resolved: true })]);
  assert.deepEqual(third.events, []);
});

test('diffSubagents ignores a further tool change after an agent is done', () => {
  const first = diffSubagents(undefined, [agent()]);
  const second = diffSubagents(first.next, [agent({ resolved: true })]);
  const third = diffSubagents(second.next, [agent({ resolved: true, currentTool: { name: 'Bash', input: {} } })]);
  assert.deepEqual(third.events, [], 'a done agent writes no more lines - a changed tool here would be stale data');
});

test('diffSubagents reports two agents independently', () => {
  const first = diffSubagents(undefined, [agent(), agent({ agentId: 'bbb222' })]);
  assert.equal(first.events.length, 2);
  const second = diffSubagents(first.next, [agent({ resolved: true }), agent({ agentId: 'bbb222' })]);
  assert.deepEqual(second.events.map((e) => e.agentId), ['aaa111']);
});

test('runSubagentWatcherOnce reports a new agent for a running, claudux-managed session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-saw-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused' };
  const state = new Map();
  const events = await runSubagentWatcherOnce(config, state, {
    registryFn: () => new Map([['carrier-1', { pid: 1, sessionId: 'sess-1', tmuxSession: 'carrier-1', cwd: '/srv/project', status: 'busy', statusUpdatedAt: 1 }]]),
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    snapshotFn: () => [agent()],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].tmuxSession, 'carrier-1');
  assert.equal(events[0].sessionId, 'sess-1');
  assert.equal(events[0].agents[0].agentId, 'aaa111');
});

test('runSubagentWatcherOnce skips a tmux session claudux did not start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-saw-'));
  const config = { dataDir, claudeHome: '/unused' };
  const state = new Map();
  const events = await runSubagentWatcherOnce(config, state, {
    registryFn: () => new Map([['other-1', { pid: 1, sessionId: 'sess-x', tmuxSession: 'other-1', cwd: '/srv/x', status: 'busy', statusUpdatedAt: 1 }]]),
    listFn: async () => [{ name: 'other-1', dead: false }],
    snapshotFn: () => [agent()],
  });
  assert.deepEqual(events, []);
});

test('runSubagentWatcherOnce skips a dead carrier', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-saw-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused' };
  const state = new Map();
  const events = await runSubagentWatcherOnce(config, state, {
    registryFn: () => new Map([['carrier-1', { pid: 1, sessionId: 'sess-1', tmuxSession: 'carrier-1', cwd: '/srv/project', status: 'busy', statusUpdatedAt: 1 }]]),
    listFn: async () => [{ name: 'carrier-1', dead: true, deadStatus: null, deadSignal: 9 }],
    snapshotFn: () => [agent()],
  });
  assert.deepEqual(events, []);
});

test('runSubagentWatcherOnce emits nothing on a second tick with no change', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-saw-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused' };
  const state = new Map();
  const deps = {
    registryFn: () => new Map([['carrier-1', { pid: 1, sessionId: 'sess-1', tmuxSession: 'carrier-1', cwd: '/srv/project', status: 'busy', statusUpdatedAt: 1 }]]),
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    snapshotFn: () => [agent()],
  };
  await runSubagentWatcherOnce(config, state, deps);
  const events = await runSubagentWatcherOnce(config, state, deps);
  assert.deepEqual(events, []);
});

test('runSubagentWatcherOnce forgets state for a carrier that stopped running', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-saw-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused' };
  const state = new Map();
  await runSubagentWatcherOnce(config, state, {
    registryFn: () => new Map([['carrier-1', { pid: 1, sessionId: 'sess-1', tmuxSession: 'carrier-1', cwd: '/srv/project', status: 'busy', statusUpdatedAt: 1 }]]),
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    snapshotFn: () => [agent()],
  });
  assert.equal(state.size, 1);
  await runSubagentWatcherOnce(config, state, {
    registryFn: () => new Map(),
    listFn: async () => [],
    snapshotFn: () => [],
  });
  assert.equal(state.size, 0);
});

test('startSubagentWatcherInterval polls on the given interval and forwards events', async () => {
  const calls = [];
  let tick;
  const stop = startSubagentWatcherInterval({ dataDir: '/unused', claudeHome: '/unused' }, {
    intervalMs: 5,
    setIntervalFn: (fn) => { tick = fn; return 'timer'; },
    clearIntervalFn: () => { calls.push('cleared'); },
    runFn: async () => [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [] }],
    onEvents: (events) => calls.push(events),
  });
  await tick();
  assert.deepEqual(calls[0], [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [] }]);
  stop();
  assert.equal(calls[1], 'cleared');
});
