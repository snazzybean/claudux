// An isolated CLAUDE_HOME with agents that read as running, so the browser
// has something to draw, plus one invented session whose transcript carries
// every shape the conversation view has to get right. The tmux session name
// of the agent half has to be one that really runs, or the watcher skips it
// as dead; the conversation half brings sessions of its own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { encodeProjectPath } from '../../src/lib/sessionStore.js';
import { REPO_ROOT, HOME_DIR } from './paths.mjs';

const HOME = process.argv[2];
const DATA = process.argv[3];
const COUNT = Number(process.argv[4] ?? 4);
const TEAM = 'probe-team';

const live = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const tmuxSession = live[0];

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'teams', TEAM, 'inboxes'), { recursive: true });
// Claude Code's own session registry, which is what makes an agent read as
// running. Tolerated missing: a checkout on a machine that has never run it
// still gets a usable fixture, just without that second signal.
try {
  fs.cpSync(path.join(HOME_DIR, '.claude', 'sessions'), path.join(HOME, 'sessions'), { recursive: true });
} catch { /* nothing has run here yet */ }

// This checkout is the project the agent half hangs its session off, so the
// directory name is derived the way Claude Code derives it.
const projectDir = path.join(HOME, 'projects', encodeProjectPath(REPO_ROOT));
const subagents = path.join(projectDir, tmuxSession, 'subagents');
fs.mkdirSync(subagents, { recursive: true });

const line = (entry) => `${JSON.stringify(entry)}\n`;
const names = ['Vermessung', 'Kommentare', 'Neulinge', 'Testgroessen', 'Klassen', 'Importe'].slice(0, COUNT);

// The session transcript: one spawn per agent, so the traffic tracker sees a
// message to each of them.
fs.writeFileSync(path.join(projectDir, `${tmuxSession}.jsonl`), names.map((name) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Agent', input: { name, subagent_type: 'general-purpose' } }] },
})).join(''));

// The team lists every one of them, and each transcript ends mid-turn, so
// both signals say "running".
fs.writeFileSync(path.join(HOME, 'teams', TEAM, 'config.json'), JSON.stringify({
  name: TEAM,
  members: [{ agentId: `team-lead@${TEAM}`, name: 'team-lead' },
    ...names.map((name) => ({ agentId: `${name}@${TEAM}`, name }))],
}));

names.forEach((name, i) => {
  const id = `a${name}-${'0123456789abcdef'.repeat(2).slice(0, 16)}`;
  fs.writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify({
    agentType: name, description: `Aufgabe ${i + 1}`, name, teamName: TEAM,
    taskKind: 'in_process_teammate', spawnDepth: 0,
  }));
  fs.writeFileSync(path.join(subagents, `agent-${id}.jsonl`),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: `Ich vermesse **${name}**.` }], stop_reason: null } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `wc -l src/lib/${name}.js` } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `${100 + i} src/lib/${name}.js` }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(REPO_ROOT, 'src', 'lib', `${name}.js`) } }] } }));
});

// Two files, not the whole directory. The rest of the real one is live
// secrets - `session-tokens/`, `hook-settings/`, the installation's
// `permission-hook.key` - and nothing here reads any of them: the two sweeps
// at server start tolerate a missing directory, and the hook key is created
// on demand (and written fresh below). What IS needed is the project list, so
// that a real project's path resolves to the transcript directory the agent
// half writes into, and its session meta, so the session has a row.
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
for (const name of ['projects.json', 'session-meta.json']) {
  try {
    fs.copyFileSync(path.join(REPO_ROOT, 'data', name), path.join(DATA, name));
  } catch { /* a data directory that has none yet */ }
}

// ---------- the conversation view ----------

// Sessions of its own, never a live one: conversation.mjs drives a real ttyd
// against them, and a second client on someone else's session resizes their
// terminal. src/ttyd/attach.sh accepts uuid names only, so they come from the
// kernel - and an empty one would make every `tmux -t` below hit the CURRENT
// session.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function newSessionName() {
  const name = fs.readFileSync('/proc/sys/kernel/random/uuid', 'utf8').trim();
  if (!UUID_RE.test(name)) throw new Error(`unusable tmux session name: "${name}"`);
  return name;
}

// `bash --norc` rather than the login shell: the pane ends up in a screenshot
// whenever one is taken, and a configured prompt carries the host and the
// working directory into it.
function holdSession(name) {
  execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '120', '-y', '40',
    'bash', '--norc', '--noprofile']);
}

// The probe leaves its sessions standing, so the previous run's are killed
// here and nothing has to be torn down between two runs. Beside the data
// directory rather than inside it, which this script wipes.
const ownSessionsFile = `${path.resolve(DATA)}.probe-tmux.json`;
try {
  for (const name of JSON.parse(fs.readFileSync(ownSessionsFile, 'utf8'))) {
    if (!UUID_RE.test(name)) continue;
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
    } catch { /* already gone */ }
  }
} catch { /* no previous run */ }

const carrier = newSessionName();
// A second session with a meta entry and no transcript: its 404 is the one
// the probe expects rather than counts.
const emptyCarrier = newSessionName();
holdSession(carrier);
holdSession(emptyCarrier);
fs.writeFileSync(ownSessionsFile, JSON.stringify([carrier, emptyCarrier]));

// An account has to exist, or every project in the sidebar refuses to expand
// and there is no session row to click. Invented, and never used to start
// anything - the probe's sessions are made here rather than by Claudux.
const accountId = '99999999-8888-4777-8666-555544443333';
fs.writeFileSync(
  path.join(DATA, 'accounts.json'),
  JSON.stringify({ [accountId]: { name: 'probe account', abbreviation: 'PR', token: 'not-a-real-token' } }, null, 2),
  { mode: 0o600 },
);

const convProject = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'probe-conversation',
  path: path.join(path.dirname(path.resolve(HOME)), 'probe-conversation-project'),
  favorite: false,
  defaultAccountId: accountId,
};
fs.mkdirSync(convProject.path, { recursive: true });
const projectsFile = path.join(DATA, 'projects.json');
let projects = [];
try {
  projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
} catch { /* a data directory without projects yet */ }
fs.writeFileSync(projectsFile, JSON.stringify([convProject, ...projects], null, 2));

const metaFile = path.join(DATA, 'session-meta.json');
let sessionMeta = {};
try {
  sessionMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
} catch { /* no sessions recorded yet */ }
sessionMeta[carrier] = { projectId: convProject.id };
sessionMeta[emptyCarrier] = { projectId: convProject.id };
fs.writeFileSync(metaFile, JSON.stringify(sessionMeta, null, 2));

// createPermissionStore writes this lazily, inside the POST handler. Written
// here so the probe can derive the same secret before the first hook call -
// reading it first would find nothing, posting first would be refused.
fs.writeFileSync(path.join(DATA, 'permission-hook.key'), crypto.randomBytes(32), { mode: 0o600 });

// One transcript that carries every shape the view has to get right: a second
// root (what a compact leaves behind), an abandoned sibling (what a rewind
// leaves behind), thinking, a tool call with its result, a diff, three Agent
// calls that resolve three different ways, a TodoWrite, and a queue with two
// entries left in it.
function writeConversationFixture(claudeHome, projectPath, sessionId) {
  const dir = path.join(claudeHome, 'projects', encodeProjectPath(projectPath));
  const agentDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const turn = (type, uuid, parentUuid, content) =>
    line({ type, uuid, parentUuid, entrypoint: 'cli', message: { content } });
  const text = (type, uuid, parent, body) => turn(type, uuid, parent, [{ type: 'text', text: body }]);

  // Enough length below the interesting part that the stream scrolls on a
  // phone - paging upwards and "the scroll does not jump" need somewhere to
  // scroll to.
  const filler = [];
  let parent = 's10';
  for (let i = 0; i < 24; i += 1) {
    const body = `Padding turn ${i}. ${'The trunk runs along the gap between the two rows. '.repeat(6)}`;
    filler.push(text(i % 2 === 0 ? 'user' : 'assistant', `pad${i}`, parent, body));
    parent = `pad${i}`;
  }

  fs.writeFileSync(file, [
    text('user', 'r1', null, 'first segment, before the compact'),
    text('assistant', 'r2', 'r1', 'still the first segment'),
    // A second null-parent line: what a /compact leaves behind, and the older
    // segment above it is conversation rather than an abandoned branch.
    text('user', 's1', null, 'second segment starts here'),
    turn('assistant', 's2', 's1', [{ type: 'thinking', thinking: 'weighing two options before the measurement' }]),
    // Forks off s1 beside s2, so the chain proves it was taken back.
    text('user', 'gone', 's1', 'this one was taken back'),
    turn('assistant', 's3', 's2', [{ type: 'tool_use', id: 'toolu_probe1', name: 'Bash', input: { command: 'echo hello' } }]),
    turn('user', 's4', 's3', [{ type: 'tool_result', tool_use_id: 'toolu_probe1', content: 'hello' }]),
    turn('assistant', 's5', 's4', [{ type: 'tool_use', id: 'toolu_probe2', name: 'Edit', input: { file_path: `${projectPath}/app.js` } }]),
    // A structuredPatch line IS the Edit's tool_result, which is why it
    // carries both.
    line({
      type: 'user',
      uuid: 's6',
      parentUuid: 's5',
      entrypoint: 'cli',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_probe2', content: 'The file has been updated.' }] },
      toolUseResult: {
        type: 'update',
        filePath: `${projectPath}/app.js`,
        structuredPatch: [{ oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, lines: ['-was', '+is'] }],
      },
    }),
    // Three spawns, one per answer subagentIndex can give: the call id is on
    // disk, several metas answer to the name, nothing answers to the name.
    turn('assistant', 's7', 's6', [{ type: 'tool_use', id: 'toolu_probe3', name: 'Agent', input: { subagent_type: 'Explore', description: 'look around' } }]),
    turn('assistant', 's8', 's7', [{ type: 'tool_use', id: 'toolu_probe4', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'the ambiguous one', name: 'twin' } }]),
    turn('assistant', 's9', 's8', [{ type: 'tool_use', id: 'toolu_probe5', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'never got going', name: 'no-show' } }]),
    turn('assistant', 's10', 's9', [{ type: 'tool_use', id: 'toolu_probe6', name: 'TodoWrite', input: { todos: [{ content: 'measure the crossings', status: 'in_progress' }] } }]),
    ...filler,
    // The last foldout in the stream, which is the one the poll must not
    // close.
    turn('assistant', 'z1', parent, [{ type: 'tool_use', id: 'toolu_probe7', name: 'Bash', input: { command: 'echo done' } }]),
    turn('user', 'z2', 'z1', [{ type: 'tool_result', tool_use_id: 'toolu_probe7', content: 'done' }]),
    text('assistant', 'z3', 'z2', 'and that is the end of it'),
    line({ type: 'queue-operation', operation: 'enqueue', content: 'a message that is waiting' }),
    line({ type: 'queue-operation', operation: 'enqueue', content: 'and a second one behind it' }),
    // A real transcript ends on a line without a uuid.
    line({ type: 'permission-mode', permissionMode: 'auto', sessionId }),
  ].join(''));

  const meta = (agentId, body) =>
    fs.writeFileSync(path.join(agentDir, `agent-${agentId}.meta.json`), JSON.stringify(body));
  meta('a1111aaa2222bbb3', { agentType: 'Explore', description: 'look around', toolUseId: 'toolu_probe3', spawnDepth: 1 });
  fs.writeFileSync(path.join(agentDir, 'agent-a1111aaa2222bbb3.jsonl'),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Eleven stubs, none of them crossing.' }] } }));
  // Two metas under one name and description: nothing says which spawn is
  // which, and that is not the same as nothing having been written.
  meta('atwin-1111', { agentType: 'general-purpose', description: 'the ambiguous one', name: 'twin', teamName: 'probe-conv' });
  meta('atwin-2222', { agentType: 'general-purpose', description: 'the ambiguous one', name: 'twin', teamName: 'probe-conv' });
  return file;
}

const transcript = writeConversationFixture(HOME, convProject.path, carrier);

const handoff = {
  project: convProject.name,
  projectPath: convProject.path,
  carrier,
  emptyCarrier,
  transcript,
};
fs.writeFileSync(path.join(DATA, 'probe-conversation.json'), JSON.stringify(handoff, null, 2));
console.log(JSON.stringify({ tmuxSession, agents: names.length, conversation: handoff }, null, 2));
