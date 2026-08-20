// public/js/subagents.js
//
// Keeps what the "subagents" SSE stream has said about every session, and
// turns it into the one thing visible without a click: the glowing edge on
// that session's sidebar row, with the number of agents running there. The
// windows behind that edge are agentWindows.js; this module owns the state
// they read.
//
// Deliberately not tied to the open session. An orbit over the terminal
// stood here before and only ever knew the session you already had in
// front of you, which is the one you can watch anyway.

// sessionRowSelector(id) is passed in rather than imported from app.js -
// same reason usage.js takes sessionId() as a parameter: an `export let`
// assigned elsewhere never reaches the importing module, and importing
// app.js back would re-run its top-level side effects at an unpredictable
// point.
export function initSubagents({
  sessionRowSelector = (id) => document.querySelector(`.session-row[data-session-id="${id}"] .session-agents-edge`),
} = {}) {
  // sessionId -> Map(agentId -> agent snapshot with status)
  const known = new Map();

  // On every row, open session or not: the windows behind the edge work for
  // a session you are not looking at just as well, which is where they earn
  // their keep.
  function updateEdge(sessionId, sessionAgents) {
    const edge = sessionRowSelector(sessionId);
    if (!edge) return;
    const count = [...sessionAgents.values()].filter((a) => a.status === 'active').length;
    edge.hidden = count === 0;
    edge.dataset.count = String(count);
    edge.textContent = count > 0 ? String(count) : '';
  }

  function handleEvent({ sessionId, agents }) {
    const sessionAgents = known.get(sessionId) ?? new Map();
    for (const agent of agents) sessionAgents.set(agent.agentId, agent);
    known.set(sessionId, sessionAgents);
    updateEdge(sessionId, sessionAgents);
  }

  // render() in app.js rebuilds the whole session list, and every rebuilt
  // edge comes back hidden. The stream only carries deltas, so nothing
  // would re-apply a count until an agent's state actually changes - which
  // for a stable set of running agents may be never. Same idiom as the
  // activity dots: re-apply what is already known after a rebuild.
  function refreshEdges() {
    for (const [sessionId, sessionAgents] of known) updateEdge(sessionId, sessionAgents);
  }

  // A reader for this module's own state rather than the map itself - the
  // window module needs the list, not the ability to change it.
  function agentsOf(sessionId) {
    return [...(known.get(sessionId)?.values() ?? [])];
  }

  return { handleEvent, refreshEdges, agentsOf };
}

// ---------- Diagnostic overlay for the stream itself ----------
//
// Enabled with `?debug=subagents`. An empty screen has three very different
// causes that look identical - nothing running, nothing arriving, or
// something arriving for a session whose row is not where you are looking -
// and this tells them apart: what the connection is doing, what came in,
// for which session, and how many windows are open as a result. Written
// after an empty orbit was chased through the backend twice while the
// backend was fine both times.
const DEBUG_TICK_MS = 250;
const DEBUG_HISTORY_LENGTH = 4;

const READY_STATE_NAMES = ['CONNECTING', 'OPEN', 'CLOSED'];

export function startSubagentDebug({ source, openWindowCount, activeSessionId }) {
  const box = document.createElement('div');
  box.className = 'debug-overlay debug-overlay-bottom';
  document.body.appendChild(box);

  const counts = { status: 0, subagents: 0 };
  let lastAt = null;
  const history = [];

  for (const type of ['status', 'subagents']) {
    source.addEventListener(type, (event) => {
      counts[type] += 1;
      lastAt = Date.now();
      if (type !== 'subagents') return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        history.push('unparsable payload');
        return;
      }
      const agents = (payload.agents ?? []).map((a) => `${a.agentId.slice(0, 10)}/${a.status}/${a.currentTool?.name ?? '-'}`);
      history.push(`${(payload.sessionId ?? '?').slice(0, 8)} ${agents.join(' ') || '(none)'}`);
      if (history.length > DEBUG_HISTORY_LENGTH) history.shift();
    });
  }

  setInterval(() => {
    const open = activeSessionId();
    box.textContent = [
      `stream        ${READY_STATE_NAMES[source.readyState] ?? source.readyState}`,
      `events        ${counts.subagents}x subagents, ${counts.status}x status`,
      `last event    ${lastAt === null ? 'none yet' : `${((Date.now() - lastAt) / 1000).toFixed(1)}s ago`}`,
      `open session  ${open ? String(open).slice(0, 8) : 'none open'}`,
      // A window count of 0 next to a non-zero event count puts the fault
      // on this side of the wire.
      `agent windows ${openWindowCount()}`,
      `received      ${history.join('\n              ') || '-'}`,
    ].join('\n');
  }, DEBUG_TICK_MS);
}
