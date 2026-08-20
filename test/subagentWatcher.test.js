import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setMeta } from '../src/lib/sessionMeta.js';
import { subagentsDirFor, parseAgentMeta, currentToolFromAgentTranscript, agentAppearsDone, subagentSnapshot, diffSubagents, runSubagentWatcherOnce, startSubagentWatcherInterval } from '../src/lib/subagentWatcher.js';

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

test('parseAgentMeta reads agentType, description, toolUseId, parentAgentId, and spawnDepth', () => {
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
    parentAgentId: 'a19c417324c2ebbb8',
    spawnDepth: 2,
    name: null,
    teamName: null,
  });
});

// Verbatim from a real meta.json on this host: an agent spawned under a
// name carries no toolUseId at all, and the pair name/teamName is what
// finds it in its team's registry.
test('parseAgentMeta reads the name and team of an agent spawned under a name', () => {
  const raw = JSON.stringify({
    agentType: 'Vermessung',
    description: 'Module in src/lib vermessen',
    name: 'Vermessung',
    teamName: 'session-927ac664',
    taskKind: 'in_process_teammate',
    spawnDepth: 0,
  });
  assert.deepEqual(parseAgentMeta(raw), {
    agentType: 'Vermessung',
    description: 'Module in src/lib vermessen',
    toolUseId: null,
    parentAgentId: null,
    spawnDepth: 0,
    name: 'Vermessung',
    teamName: 'session-927ac664',
  });
});

test('parseAgentMeta defaults a missing description and spawnDepth, and a top-level agent has no parent', () => {
  const raw = JSON.stringify({ agentType: 'code-review', toolUseId: 'toolu_1' });
  assert.deepEqual(parseAgentMeta(raw), {
    agentType: 'code-review',
    description: '',
    toolUseId: 'toolu_1',
    parentAgentId: null,
    spawnDepth: 1,
    name: null,
    teamName: null,
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

test('agentAppearsDone accepts a last assistant turn that only answers', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is what I found.' }], stop_reason: 'end_turn' } });
  assert.equal(agentAppearsDone(jsonl), true);
});

test('agentAppearsDone rejects a last assistant turn that still calls a tool', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: {} }] } });
  assert.equal(agentAppearsDone(jsonl), false);
});

test('agentAppearsDone rejects a transcript without any assistant entry', () => {
  assert.equal(agentAppearsDone(line({ type: 'user', message: { content: [] } })), false);
  assert.equal(agentAppearsDone(''), false);
  assert.equal(agentAppearsDone(null), false);
});

test('agentAppearsDone falls back to the last VALID assistant entry on a broken line', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } })
    + '{"type":"assistant","message":{"con\n';
  assert.equal(agentAppearsDone(jsonl), true);
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
      currentTool: { name: 'Grep', input: { pattern: 'auth' } }, resolved: false, silent: false,
    },
    {
      agentId: 'bbb222', agentType: 'code-review', description: 'Review', spawnDepth: 1,
      currentTool: { name: 'Read', input: { file_path: 'x.js' } }, resolved: false, silent: false,
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

// A session whose transcript and subagents directory both exist, ready for
// agents to be written into it.
function sessionFixture(transcriptLines = []) {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), transcriptLines.map(line).join(''));
  return { claudeHome, subagentsDir };
}

function toolResult(toolUseId) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } };
}

test('subagentSnapshot resolves a nested agent from its PARENT agent transcript', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  // The parent's own Task call is still open in the session transcript -
  // only the parent's transcript carries the nested agent's tool_result.
  writeAgent(subagentsDir, 'parent1', { agentType: 'general-purpose', toolUseId: 'toolu_parent' },
    [toolResult('toolu_nested')]);
  writeAgent(subagentsDir, 'nested1',
    { agentType: 'code-review', toolUseId: 'toolu_nested', parentAgentId: 'parent1', spawnDepth: 2 }, []);

  const byId = new Map(subagentSnapshot(claudeHome, ['sess-1']).map((a) => [a.agentId, a]));
  assert.equal(byId.get('nested1').resolved, true);
  assert.equal(byId.get('parent1').resolved, false);
});

test('subagentSnapshot leaves a nested agent unresolved when only the session transcript has a tool_result', () => {
  const { claudeHome, subagentsDir } = sessionFixture([toolResult('toolu_nested'), toolResult('toolu_other')]);
  writeAgent(subagentsDir, 'parent1', { agentType: 'general-purpose', toolUseId: 'toolu_parent' }, []);
  writeAgent(subagentsDir, 'nested1',
    { agentType: 'code-review', toolUseId: 'toolu_nested', parentAgentId: 'parent1', spawnDepth: 2 }, []);

  const byId = new Map(subagentSnapshot(claudeHome, ['sess-1']).map((a) => [a.agentId, a]));
  assert.equal(byId.get('nested1').resolved, false,
    'a nested tool_use_id in the SESSION transcript belongs to some other call, not to this agent');
});

test('subagentSnapshot survives a nested agent whose parent transcript is missing', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  writeAgent(subagentsDir, 'nested1',
    { agentType: 'code-review', toolUseId: 'toolu_nested', parentAgentId: 'gone999', spawnDepth: 2 }, []);
  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});

test('subagentSnapshot resolves a toolUseId-less agent once its own transcript ends a turn', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  writeAgent(subagentsDir, 'slash11', { agentType: 'general-purpose', description: 'Slash command' },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }], stop_reason: 'end_turn' } }]);
  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, true);
});

test('subagentSnapshot leaves a toolUseId-less agent active while its transcript still calls tools', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  writeAgent(subagentsDir, 'slash11', { agentType: 'general-purpose', description: 'Slash command' },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }]);
  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});

test('subagentSnapshot skips a meta.json that parses but names no agentType', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  fs.writeFileSync(path.join(subagentsDir, 'agent-ddd444.meta.json'), JSON.stringify({ description: 'no type' }));
  writeAgent(subagentsDir, 'aaa111', { agentType: 'general-purpose', toolUseId: 'toolu_1' }, []);
  assert.deepEqual(subagentSnapshot(claudeHome, ['sess-1']).map((a) => a.agentId), ['aaa111']);
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

test('diffSubagents keeps an agent done even if a later snapshot reports it unresolved', () => {
  const first = diffSubagents(undefined, [agent()]);
  const second = diffSubagents(first.next, [agent({ resolved: true })]);
  assert.equal(second.events[0].status, 'done');

  // Whatever makes a snapshot report resolved:false for an agent that was
  // correctly marked done ticks ago, the memory of the earlier tick has to
  // win - an agent's own file writes nothing more once it is finished.
  const third = diffSubagents(second.next, [agent({ resolved: false })]);
  assert.equal(third.next.get('aaa111').status, 'done');
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
  const watcher = startSubagentWatcherInterval({ dataDir: '/unused', claudeHome: '/unused' }, {
    intervalMs: 5,
    setIntervalFn: (fn) => { tick = fn; return 'timer'; },
    clearIntervalFn: () => { calls.push('cleared'); },
    runFn: async () => [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [] }],
    onEvents: (events) => calls.push(events),
  });
  await tick();
  assert.deepEqual(calls[0], [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [] }]);
  watcher.stop();
  assert.equal(calls[1], 'cleared');
});

// A client that connects while agents are already running gets no delta for
// them - the events that made them appear were published before it was
// there. Merging what was published is that opening picture.
function intervalHarness(passes) {
  let tick;
  let pass = 0;
  const watcher = startSubagentWatcherInterval({ dataDir: '/unused', claudeHome: '/unused' }, {
    setIntervalFn: (fn) => { tick = fn; return 'timer'; },
    clearIntervalFn: () => {},
    runFn: async (config, state) => passes[pass++](state),
  });
  return { watcher, tick: () => tick() };
}

test('currentEvents replays every agent a running session has published', async () => {
  const { watcher, tick } = intervalHarness([
    (state) => {
      state.set('carrier-1', new Map());
      return [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [eventAgent(), eventAgent({ agentId: 'bbb222' })] }];
    },
    (state) => {
      state.set('carrier-1', new Map());
      return [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [eventAgent({ currentTool: { name: 'Bash', input: null } })] }];
    },
  ]);
  await tick();
  await tick();
  const [event] = watcher.currentEvents();
  assert.equal(event.tmuxSession, 'carrier-1');
  assert.equal(event.sessionId, 'sess-1');
  assert.deepEqual(event.agents.map((a) => a.agentId).sort(), ['aaa111', 'bbb222']);
  // The later delta wins - the replay is the current picture, not a log.
  assert.deepEqual(event.agents.find((a) => a.agentId === 'aaa111').currentTool, { name: 'Bash', input: null });
});

test('currentEvents leaves out an agent that has finished', async () => {
  const { watcher, tick } = intervalHarness([
    (state) => {
      state.set('carrier-1', new Map());
      return [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [eventAgent(), eventAgent({ agentId: 'bbb222' })] }];
    },
    (state) => {
      state.set('carrier-1', new Map());
      return [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [eventAgent({ status: 'done' })] }];
    },
  ]);
  await tick();
  await tick();
  assert.deepEqual(watcher.currentEvents()[0].agents.map((a) => a.agentId), ['bbb222']);
});

test('currentEvents forgets a session that stopped running', async () => {
  const { watcher, tick } = intervalHarness([
    (state) => {
      state.set('carrier-1', new Map());
      return [{ tmuxSession: 'carrier-1', sessionId: 'sess-1', agents: [eventAgent()] }];
    },
    (state) => {
      state.delete('carrier-1');
      return [];
    },
  ]);
  await tick();
  assert.equal(watcher.currentEvents().length, 1);
  await tick();
  assert.deepEqual(watcher.currentEvents(), []);
});

function eventAgent(overrides) {
  return {
    agentId: 'aaa111', agentType: 'general-purpose', description: 'Explore', spawnDepth: 1,
    currentTool: { name: 'Grep', input: { pattern: 'auth' } }, status: 'active',
    ...overrides,
  };
}

test('subagentSnapshot resolves an agent whose tool_result is far from the end of the transcript', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200 * 1024) }] } }));
  writeAgent(subagentsDir, 'aaa111', { agentType: 'general-purpose', toolUseId: 'toolu_1' }, []);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, true);
});

// One tracker for the process, not one per pass: a fresh tracker re-reads
// the whole session transcript, which on a long session is megabytes -
// every two seconds, for every open session.
test('startSubagentWatcherInterval hands every pass the same resolution tracker', async () => {
  const seen = [];
  let tick;
  startSubagentWatcherInterval({ dataDir: '/unused', claudeHome: '/unused' }, {
    setIntervalFn: (fn) => { tick = fn; return 'timer'; },
    runFn: async (config, state, opts) => { seen.push(opts.tracker); return []; },
  });
  await tick();
  await tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(typeof seen[0].idsFor, 'function');
});

// Every restart reads a session's whole history of subagents back in, and
// on a long session that is dozens of long-finished ones. Reporting them
// would have every connected browser draw a node and fade it out again for
// an agent that finished hours ago.
test('diffSubagents stays quiet about an agent that was already finished when first seen', () => {
  const { events, next } = diffSubagents(undefined, [agent({ resolved: true })]);
  assert.deepEqual(events, []);
  // Remembered all the same: without this the next tick would see no prior
  // and report it as a brand-new agent.
  assert.equal(next.get('aaa111').status, 'done');
});

// A parent agent that spawns several children writes plenty itself, so its
// own transcript outgrows a tail read just like a session's does - measured
// on this host, all 8 nested agents of one session sat outside it.
test('subagentSnapshot resolves a nested agent whose tool_result is far from the end of the parent transcript', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  writeAgent(subagentsDir, 'parent1', { agentType: 'general-purpose', toolUseId: 'toolu_parent' }, []);
  fs.appendFileSync(path.join(subagentsDir, 'agent-parent1.jsonl'),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'ok' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200 * 1024) }] } }));
  writeAgent(subagentsDir, 'child1', { agentType: 'general-purpose', toolUseId: 'toolu_child', parentAgentId: 'parent1', spawnDepth: 2 }, []);

  const byId = new Map(subagentSnapshot(claudeHome, ['sess-1']).map((a) => [a.agentId, a]));
  assert.equal(byId.get('child1').resolved, true);
});

// An agent spawned under a name gets its name folded into its id, so the
// id carries a hyphen: agent-aExportSweep-acebce40dd0e83d3. A character
// class of [a-zA-Z0-9] silently skips the whole agent - the id is what
// finds its meta and its transcript, so no id means no agent at all.
test('subagentSnapshot reads an agent whose id carries a name and a hyphen', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  // Verbatim from a real meta.json written on this host: a named agent
  // carries no toolUseId, and its agentType is the name it was given.
  writeAgent(subagentsDir, 'aExportSweep-acebce40dd0e83d3', { agentType: 'ExportSweep', description: 'Count exports', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.js' } }] } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.agentId, 'aExportSweep-acebce40dd0e83d3');
  assert.equal(agentRow.resolved, false);
});

// The id reaches path.join(), so widening the class is only safe as long
// as it still cannot walk out of the directory - and parentAgentId, which
// reaches the same call, has to be held to it too.
test('subagentSnapshot skips an agent id that could leave the subagents directory', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  fs.writeFileSync(path.join(subagentsDir, 'agent-..%2fescape.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
  writeAgent(subagentsDir, 'aaa111', { agentType: 'general-purpose', toolUseId: 'toolu_1', parentAgentId: '../../escape', spawnDepth: 2 }, []);

  const snapshot = subagentSnapshot(claudeHome, ['sess-1']);
  assert.deepEqual(snapshot.map((a) => a.agentId), ['aaa111']);
  // An unusable parent id resolves to nothing rather than reading a path
  // of its choosing.
  assert.equal(snapshot[0].resolved, false);
});

// The case caught in the browser: an agent reading a file in slices wrote
// a line of commentary between two Bash calls and was reported done in the
// middle of its work - and 'done' is sticky, so its node faded and never
// came back. A turn that has really ended says so in stop_reason.
test('agentAppearsDone rejects an answer that is still mid-turn', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] }, stop_reason: 'tool_use' })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now the next slice.' }], stop_reason: null } });
  assert.equal(agentAppearsDone(jsonl), false);
});

test('agentAppearsDone accepts every stop_reason that ends a turn', () => {
  for (const stop of ['end_turn', 'stop_sequence', 'max_tokens']) {
    const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }], stop_reason: stop } });
    assert.equal(agentAppearsDone(jsonl), true, stop);
  }
});

test('subagentSnapshot keeps an id-less agent active while it narrates between tool calls', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  writeAgent(subagentsDir, 'aTokenAudit-f30030d664368b10', { agentType: 'TokenAudit', description: 'Check the scale', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Now the next slice.' }], stop_reason: null } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});

// An agent interrupted mid-turn never writes its closing message, so no
// marker will ever appear - and without a floor its node orbits for the
// life of the process. A running agent appends on every tool result, so
// silence on this scale is absence, not thought.
test('subagentSnapshot reports a long-silent agent as silent, not as resolved', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-sa-'));
  const projectDir = path.join(claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, 'sess-1', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), '');
  writeAgent(subagentsDir, 'abandoned1', { agentType: 'general-purpose', toolUseId: 'toolu_1' },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }]);
  const agentPath = path.join(subagentsDir, 'agent-abandoned1.jsonl');
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(agentPath, longAgo, longAgo);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.silent, true);
  // Silence is a guess, and the two are kept apart so the guess can be
  // taken back - see diffSubagents.
  assert.equal(agentRow.resolved, false);
});

// Silence says an agent is gone, and it is right about an aborted one -
// but a slow tool call looks the same, and there the guess has to be
// taken back. Sticky 'done' is for the signals that cannot be wrong.
test('diffSubagents lets an agent come back after silence turned out to be a slow tool call', () => {
  const first = diffSubagents(undefined, [agent()]);
  const silent = diffSubagents(first.next, [agent({ silent: true })]);
  assert.equal(silent.events[0].status, 'done');

  const back = diffSubagents(silent.next, [agent({ currentTool: { name: 'Bash', input: {} } })]);
  assert.equal(back.events.length, 1);
  assert.equal(back.events[0].status, 'active');
});

test('diffSubagents keeps a resolved agent done even if it writes again', () => {
  const first = diffSubagents(undefined, [agent()]);
  const done = diffSubagents(first.next, [agent({ resolved: true })]);
  assert.equal(done.events[0].status, 'done');
  const later = diffSubagents(done.next, [agent({ currentTool: { name: 'Bash', input: {} } })]);
  assert.deepEqual(later.events, []);
});

// A named agent records no tool_result anywhere, so its team's registry is
// the only exact answer about it - verified on this host: a teammate is in
// `members` while it runs and gone from there the moment it stops, whether
// it finished or was aborted.
function teamFixture(claudeHome, teamName, memberNames) {
  const dir = path.join(claudeHome, 'teams', teamName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    name: teamName,
    members: memberNames.map((name) => ({ agentId: `${name}@${teamName}`, name })),
  }));
}

test('subagentSnapshot keeps a named agent active while its team still lists it', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead', 'Probe']);
  // The commentary-between-tool-calls case: without the registry this reads
  // as an answer and the agent would count as finished.
  writeAgent(subagentsDir, 'aProbe-f30030d664368b10',
    { agentType: 'Probe', name: 'Probe', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Now the next slice.' }], stop_reason: null } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});

test('subagentSnapshot counts a named agent as finished once its team drops it', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead']);
  writeAgent(subagentsDir, 'aProbe-f30030d664368b10',
    { agentType: 'Probe', name: 'Probe', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }]);
  // Older than the spawn-race grace, so absence is trusted.
  const agentPath = path.join(subagentsDir, 'agent-aProbe-f30030d664368b10.jsonl');
  const before = new Date(Date.now() - 60_000);
  fs.utimesSync(agentPath, before, before);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, true);
});

// The registry entry and the meta file are written at almost the same
// moment; reading between the two must not brand a brand-new agent as
// finished, since 'done' is sticky.
test('subagentSnapshot does not trust a team registry that has just been overtaken', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead']);
  writeAgent(subagentsDir, 'aFresh-f30030d664368b10',
    { agentType: 'Fresh', name: 'Fresh', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});

test('subagentSnapshot falls back to the transcript when there is no team registry', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  writeAgent(subagentsDir, 'aLonely-f30030d664368b10',
    { agentType: 'Lonely', name: 'Lonely', teamName: 'session-gone', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }], stop_reason: 'end_turn' } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, true);
});

// The registry knows a teammate by name alone, while its files carry a
// hash - so a second agent spawned under the same name in the same session
// would make the first one look alive again, and after a restart that is a
// first sighting, hence an event, a window and a glowing edge.
test('subagentSnapshot credits a team entry to the newest agent of that name only', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead', 'Vermessung']);
  const meta = { agentType: 'Vermessung', name: 'Vermessung', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 };
  const turn = [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }];
  writeAgent(subagentsDir, 'aVermessung-1111111111111111', meta, turn);
  writeAgent(subagentsDir, 'aVermessung-2222222222222222', meta, turn);

  // The first run finished long ago; the second is the one the team lists.
  const old = new Date(Date.now() - 60_000);
  for (const suffix of ['meta.json', 'jsonl']) {
    fs.utimesSync(path.join(subagentsDir, `agent-aVermessung-1111111111111111.${suffix}`), old, old);
  }

  const byId = new Map(subagentSnapshot(claudeHome, ['sess-1']).map((a) => [a.agentId, a]));
  assert.equal(byId.get('aVermessung-1111111111111111').resolved, true);
  assert.equal(byId.get('aVermessung-2222222222222222').resolved, false);
});

// The registry answers whether a teammate still exists, not whether it is
// still working: one that has delivered its answer stays a member and waits
// for another task (its own notification calls that "available"). So the
// registry alone reported every finished agent as running - measured here,
// the four that were stopped went away and the two that finished by
// themselves did not.
test('subagentSnapshot counts a named agent as finished once its own turn has ended', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead', 'Kommentare']);
  writeAgent(subagentsDir, 'aKommentare-99808aacae0eb4b4',
    { agentType: 'Kommentare', name: 'Kommentare', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the table.' }], stop_reason: 'end_turn' } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, true);
});

// The other half of the same pair: still a member AND still mid-turn is the
// only combination that means running.
test('subagentSnapshot keeps a named agent active while it is a member and mid-turn', () => {
  const { claudeHome, subagentsDir } = sessionFixture();
  teamFixture(claudeHome, 'session-abc', ['team-lead', 'Kommentare']);
  writeAgent(subagentsDir, 'aKommentare-99808aacae0eb4b4',
    { agentType: 'Kommentare', name: 'Kommentare', teamName: 'session-abc', taskKind: 'in_process_teammate', spawnDepth: 0 },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Now the next file.' }], stop_reason: null } }]);

  const [agentRow] = subagentSnapshot(claudeHome, ['sess-1']);
  assert.equal(agentRow.resolved, false);
});
