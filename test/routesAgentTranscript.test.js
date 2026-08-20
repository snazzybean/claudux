import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setMeta } from '../src/lib/sessionMeta.js';
import { tmpConfig, startApp } from './helpers/routeHarness.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

// A session Claudux started, with one subagent on disk. Mirrors the layout
// described in subagentWatcher.js's header.
function fixture(config, tmuxSession = 'carrier-1', agentId = 'aaa111') {
  setMeta(config.dataDir, tmuxSession, { accountId: 'id-1', projectId: 'proj-1' });
  const projectDir = path.join(config.claudeHome, 'projects', '-srv-project');
  const subagentsDir = path.join(projectDir, tmuxSession, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${tmuxSession}.jsonl`), '');
  fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'wc -l' } }] } }));
  return subagentsDir;
}

test('the route returns an agent\'s blocks and an offset to continue from', async () => {
  const config = tmpConfig();
  fixture(config);
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/carrier-1/agents/aaa111`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.blocks.map((b) => [b.name, b.detail]), [['Bash', 'wc -l']]);
    assert.ok(body.offset > 0);
  } finally {
    close();
  }
});

test('the route returns only what the transcript grew by after an offset', async () => {
  const config = tmpConfig();
  const subagentsDir = fixture(config);
  const { port, close } = startApp(config);
  try {
    const first = await (await fetch(`http://127.0.0.1:${port}/api/sessions/carrier-1/agents/aaa111`)).json();
    fs.appendFileSync(path.join(subagentsDir, 'agent-aaa111.jsonl'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
    const second = await (await fetch(`http://127.0.0.1:${port}/api/sessions/carrier-1/agents/aaa111?after=${first.offset}`)).json();
    assert.equal(second.blocks.length, 1);
    assert.equal(second.blocks[0].kind, 'text');
  } finally {
    close();
  }
});

// The id reaches a path.join, so it is checked before it gets there.
test('the route rejects an agent id that could leave the directory', async () => {
  const config = tmpConfig();
  fixture(config);
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/carrier-1/agents/${encodeURIComponent('../../escape')}`);
    assert.equal(res.status, 400);
  } finally {
    close();
  }
});

test('the route answers 404 for a session claudux did not start', async () => {
  const config = tmpConfig();
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/stranger-1/agents/aaa111`);
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});

test('the route answers 404 for an agent with no transcript', async () => {
  const config = tmpConfig();
  fixture(config);
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/carrier-1/agents/nosuch1`);
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});
