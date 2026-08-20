// An isolated CLAUDE_HOME with agents that read as running, so the browser
// has something to draw. The tmux session name has to be one that really
// runs, or the watcher skips it as dead.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.argv[2];
const DATA = process.argv[3];
const COUNT = Number(process.argv[4] ?? 4);
const TEAM = 'probe-team';

const live = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const tmuxSession = live[0];

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'teams', TEAM, 'inboxes'), { recursive: true });
fs.cpSync('/root/.claude/sessions', path.join(HOME, 'sessions'), { recursive: true });

const projectDir = path.join(HOME, 'projects', '-opt-claudux');
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
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/opt/claudux/src/lib/${name}.js` } }] } }));
});

fs.rmSync(DATA, { recursive: true, force: true });
fs.cpSync('/opt/claudux/data', DATA, { recursive: true });
console.log(JSON.stringify({ tmuxSession, agents: names.length }));
