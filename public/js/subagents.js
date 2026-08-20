// public/js/subagents.js
//
// Renders two things from the same "subagents" SSE stream: an orbit of
// small nodes around the open session's status dot, and a quiet counter
// badge on every OTHER session's sidebar row. Deliberately not Codeman-
// style floating windows - there is no real second terminal behind a
// subagent (see the design doc), so a summary that needs no dragging and
// no position tracking is the honest representation.
import { escapeHtml } from './messages.js';

const ORBIT_RADIUS_BY_DEPTH = [22, 34, 46]; // spawnDepth 1, 2, 3+ - nested
// Task calls run visibly further out, an honest picture of the actual
// nesting rather than a made-up spacing.
//
// Center of the 112x112 box in styles.css's .subagent-orbit - kept as a
// constant here rather than read from the DOM, since the two have to
// agree exactly: the outermost radius (46) plus the node's own radius (4)
// must stay inside the box, or the SVG viewport (which clips by default,
// same as any non-root <svg>) cuts the outer ring off.
const ORBIT_CENTER = 56;

function radiusFor(spawnDepth) {
  const i = Math.min(Math.max(spawnDepth, 1), ORBIT_RADIUS_BY_DEPTH.length) - 1;
  return ORBIT_RADIUS_BY_DEPTH[i];
}

function toolLine(agent) {
  if (!agent.currentTool) return agent.description || agent.agentType;
  return `${agent.currentTool.name}${agent.currentTool.input?.file_path ? ` ${agent.currentTool.input.file_path}` : ''}`;
}

// sessionRowSelector(id) and activeSessionId() are passed in rather than
// imported from app.js - same reason usage.js takes sessionId() as a
// parameter: an `export let` assigned elsewhere never reaches the
// importing module, and importing app.js back would re-run its top-level
// side effects at an unpredictable point.
export function initSubagents({
  orbitEl, popoverEl, backdropEl,
  sessionRowSelector = (id) => document.querySelector(`.session-row[data-session-id="${id}"] .session-agents-edge`),
  activeSessionId,
}) {
  // sessionId -> Map(agentId -> agent snapshot with status)
  const known = new Map();
  let popoverOpenAgentId = null;

  function closePopover() {
    popoverOpenAgentId = null;
    popoverEl.hidden = true;
    backdropEl.hidden = true;
  }

  function openPopover(agent, nodeEl) {
    popoverOpenAgentId = agent.agentId;
    const rect = nodeEl.getBoundingClientRect();
    // .panel-overlay, not .terminal-wrap: #subagentPopover's own
    // position:absolute (via .menu-panel) resolves top/right against its
    // nearest POSITIONED ancestor, which is .panel-overlay itself (it sets
    // position:absolute; .terminal-wrap is one level further out and would
    // put the popover 8px/10px off - the same containing block #usagePopover
    // relies on for its own static top/right).
    const overlayRect = orbitEl.closest('.panel-overlay').getBoundingClientRect();
    popoverEl.style.top = `${rect.top - overlayRect.top + rect.height + 6}px`;
    popoverEl.style.right = `${overlayRect.right - rect.right}px`;
    popoverEl.innerHTML =
      `<div class="subagent-popover-type">${escapeHtml(agent.agentType)}</div>` +
      `<div class="subagent-popover-desc">${escapeHtml(agent.description || '')}</div>` +
      `<div class="subagent-popover-tool">${escapeHtml(toolLine(agent))}</div>`;
    popoverEl.hidden = false;
    backdropEl.hidden = false;
  }

  backdropEl.addEventListener('click', closePopover);

  function renderOrbit(sessionAgents) {
    if (popoverOpenAgentId && !sessionAgents.has(popoverOpenAgentId)) closePopover();
    const active = [...sessionAgents.values()].filter((a) => a.status !== 'faded');
    if (active.length === 0) {
      orbitEl.hidden = true;
      orbitEl.replaceChildren();
      return;
    }
    orbitEl.hidden = false;
    orbitEl.replaceChildren();
    active.forEach((agent, i) => {
      const angle = (i / active.length) * Math.PI * 2;
      const r = radiusFor(agent.spawnDepth);
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('r', '4');
      node.setAttribute('cx', String(ORBIT_CENTER + r * Math.cos(angle)));
      node.setAttribute('cy', String(ORBIT_CENTER + r * Math.sin(angle)));
      // subagent-node-done isn't part of the class attribute set here: a
      // CSS transition only animates a property change across two renders
      // of an EXISTING element, so applying opacity:0 at creation time
      // would leave the node invisible on its very first painted frame
      // instead of fading. On the tick a node first turns 'done' (justDone)
      // the class is added a frame later, after this element has already
      // painted at its normal opacity, so the transition has something to
      // animate from. A later re-render of the same still-fading node (an
      // unrelated sibling event can trigger one before the 2s timeout below
      // fires) adds the class immediately instead - it's already faded by
      // then, and rAF-delaying it again would restart the transition from
      // full opacity, same class of bug justPulsed already guards against.
      node.setAttribute('class', 'subagent-node');
      if (agent.status === 'done') {
        if (agent.justDone) {
          requestAnimationFrame(() => node.classList.add('subagent-node-done'));
        } else {
          node.classList.add('subagent-node-done');
        }
      }
      node.dataset.agentId = agent.agentId;
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `${agent.agentType}: ${toolLine(agent)}`);
      node.addEventListener('click', () => openPopover(agent, node));
      // Same Enter/Space-activates idiom as the sidebar's own custom
      // buttons (.lock-btn, .dot[data-stop] in app.js) - role="button"
      // alone doesn't make a non-native element keyboard-operable.
      node.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openPopover(agent, node);
      });
      orbitEl.appendChild(node);
      if (agent.justPulsed) {
        node.animate(
          [{ r: 4 }, { r: 7 }, { r: 4 }],
          { duration: 500, easing: 'ease-out' },
        );
      }
    });
  }

  // On every row, open session or not: the windows behind the edge work
  // for a session you are not looking at just as well, which is where they
  // earn their keep.
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
    for (const agent of agents) {
      const previous = sessionAgents.get(agent.agentId);
      sessionAgents.set(agent.agentId, {
        ...agent,
        // A pulse fires once, on the tick that reports it - never replayed
        // from a later renderOrbit() call for an unrelated reason.
        justPulsed: agent.status === 'active' && Boolean(previous),
        // Same one-shot idiom for the fade-out trigger: true only on the
        // tick a node's status first reports 'done', so renderOrbit knows
        // to delay the -done class by a frame just this once (see there).
        justDone: agent.status === 'done' && previous?.status !== 'done',
      });
      // A 'done' agent gets exactly one more render as 'done' (the fade-out
      // CSS transition), then is marked 'faded' so renderOrbit stops
      // drawing it without needing a timer in this module.
      if (agent.status === 'done') {
        setTimeout(() => {
          const current = known.get(sessionId)?.get(agent.agentId);
          if (current) current.status = 'faded';
          if (activeSessionId() === sessionId) renderOrbit(known.get(sessionId));
        }, 2000);
      }
    }
    known.set(sessionId, sessionAgents);
    updateEdge(sessionId, sessionAgents);
    if (activeSessionId() === sessionId) renderOrbit(sessionAgents);
  }

  function sessionOpened(sessionId) {
    closePopover();
    renderOrbit(known.get(sessionId) ?? new Map());
    refreshEdges();
  }

  // No session is open any more. Its own name for it rather than
  // sessionOpened(null): the delta stream never reports "this session is
  // gone", and activeSessionId() turning null triggers no render on its
  // own, so without this the orbit and popover of the session that just
  // closed would stay on screen indefinitely.
  function close() {
    closePopover();
    renderOrbit(new Map());
    refreshEdges();
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

  return { handleEvent, sessionOpened, close, refreshEdges, agentsOf };
}

// ---------- Diagnostic overlay for the stream itself ----------
//
// Enabled with `?debug=subagents`. An empty orbit has three very different
// causes that look identical on screen - nothing running, nothing arriving,
// or something arriving for a session that is not the open one - and this
// tells them apart: what the connection is doing, what came in, for which
// session, and how many nodes the orbit actually holds as a result. Written
// after an empty orbit was chased through the backend twice while the
// backend was fine both times.
const DEBUG_TICK_MS = 250;
const DEBUG_HISTORY_LENGTH = 4;

const READY_STATE_NAMES = ['CONNECTING', 'OPEN', 'CLOSED'];

export function startSubagentDebug({ source, orbitEl, activeSessionId }) {
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
      // The orbit is drawn from `known`, so a node count of 0 next to a
      // non-zero event count puts the fault on this side of the wire.
      `orbit nodes   ${orbitEl.querySelectorAll('.subagent-node').length}${orbitEl.hidden ? ' (orbit hidden)' : ''}`,
      `received      ${history.join('\n              ') || '-'}`,
    ].join('\n');
  }, DEBUG_TICK_MS);
}
