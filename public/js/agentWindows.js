// public/js/agentWindows.js
//
// A window per running subagent, popped out of its session's glowing row
// edge, showing that agent's own conversation. What is inside comes from
// GET /api/sessions/:id/agents/:agentId - the SSE stream carries only the
// current tool, never the history, so a window fetches its blocks once and
// then follows the stream, asking each time only for what was appended
// since.
//
// Positions live here and only here, in memory: a window put somewhere by
// hand stays there for as long as the page lives, and a reload starts the
// cascade over. Persisting them would keep a state across sessions that
// helps nobody.
import { svg } from './icons.js';

// Six at once. Beyond that the terminal disappears behind windows - one
// session in this project's own history had 46 agents in its directory.
// The upper bound; how many actually fit is decided by the screen (see
// gridFor). One session in this project's own history had 46 agents in its
// directory.
const MAX_WINDOWS = 6;
const WINDOW_WIDTH = 360;
// Below this a window shows a title bar and barely two lines, which is not
// worth a tile. Above the upper bound a single row would run the full height
// of the screen for a conversation that is a few lines long.
const MIN_WINDOW_HEIGHT = 180;
const MAX_WINDOW_HEIGHT = 420;
const GAP = 12;
// Windows sit on an arc around the row's edge rather than in a grid: a grid
// puts every window the same distance away in the same direction, and the
// curves that are the point of the thing then run through the windows in
// front. On an arc each one has its own direction out of the edge.
const MIN_ARC_RADIUS = 140;
const MAX_ARC_RADIUS = 460;
// A little irregularity per agent, so an arc reads as one rather than as a
// mechanism. Derived from the agent's id, not drawn at random: a window
// must not jump on every re-layout.
const JITTER_RADIUS = 34;
const JITTER_Y = 18;
// Enough vertical distance between two windows on the arc that both title
// bars stay readable.
const ARC_MIN_SEPARATION = 96;
// A finished agent's window stays long enough to see that it finished, and
// to take in its last lines, then retracts by itself. Leaving it would fill
// the screen with windows that nothing is happening in any more.
const CLOSE_AFTER_DONE_MS = 4000;
// Below this the sidebar is collapsed, so there is no edge for a line to
// reach and no room to place a window by hand - they stack instead. Same
// breakpoint every other narrow rule in styles.css uses.
const NARROW_PX = 720;

export function initAgentWindows({ containerEl, lineEl, sidebarEl }) {
  // agentId -> { el, sessionId, offset, x, y }
  const open = new Map();

  const narrow = () => window.innerWidth <= NARROW_PX;

  function anchorOf(sessionId) {
    const edge = document.querySelector(`.session-agents-edge[data-session-id="${sessionId}"]`);
    if (!edge) return null;
    const rect = edge.getBoundingClientRect();
    // A hidden edge is still found by querySelector and reports a rect of
    // zeroes - which would send the curve to the top left corner exactly
    // when the count drops and the edge disappears, while the finished
    // window is still on screen.
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.right, y: rect.top + rect.height / 2 };
  }

  function blockEl(block) {
    const el = document.createElement('div');
    if (block.kind === 'text') {
      el.className = 'agent-block-text';
      // Server-rendered and sanitized by the same renderer the Files tab
      // uses (see src/lib/fileRender.js) - not raw agent output.
      el.innerHTML = block.html;
      return el;
    }
    el.className = 'agent-block-tool';
    // Call and result on separate lines. As siblings in one flex row the
    // result became a third column and wrapped down the whole window.
    const call = document.createElement('div');
    call.className = 'agent-tool-call';
    const name = document.createElement('span');
    name.className = 'agent-tool-name';
    name.textContent = block.name;
    const detail = document.createElement('span');
    detail.className = 'agent-tool-detail';
    detail.textContent = block.detail ?? '';
    call.append(name, detail);
    el.appendChild(call);
    if (block.result) {
      const result = document.createElement('pre');
      result.className = 'agent-tool-result';
      result.textContent = block.result;
      el.appendChild(result);
    }
    return el;
  }

  async function loadInto(entry, agentId) {
    const url = `/api/sessions/${encodeURIComponent(entry.sessionId)}/agents/${encodeURIComponent(agentId)}?after=${entry.offset}`;
    let payload;
    try {
      payload = await (await fetch(url)).json();
    } catch {
      // A window that cannot reach the route keeps what it has; the next
      // delta tries again.
      return;
    }
    if (!Array.isArray(payload.blocks)) return;
    entry.offset = payload.offset ?? entry.offset;
    const body = entry.el.querySelector('.agent-window-body');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    for (const block of payload.blocks) body.appendChild(blockEl(block));
    // Follow the tail only when the reader was already there - scrolling
    // back to look at something must not be yanked away by an arriving
    // block.
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  function place(entry, width = entry.el.offsetWidth || WINDOW_WIDTH) {
    if (narrow()) return;
    // Clamped so a window cannot end up off screen - after a resize, or
    // after being dragged past an edge.
    const maxX = Math.max(0, window.innerWidth - width - GAP);
    const maxY = Math.max(0, window.innerHeight - 80);
    entry.x = Math.min(Math.max(entry.x, 0), maxX);
    entry.y = Math.min(Math.max(entry.y, 0), maxY);
    entry.el.style.left = `${entry.x}px`;
    entry.el.style.top = `${entry.y}px`;
    drawLines();
  }

  // A stable, id-derived wobble, so the arc looks like an arc of windows
  // rather than of slots - and so a window does not jump every time
  // something is re-laid out.
  function jitterOf(agentId) {
    let hash = 0;
    for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
    hash = Math.abs(hash);
    return {
      radius: (hash % (2 * JITTER_RADIUS)) - JITTER_RADIUS,
      y: ((hash >> 8) % (2 * JITTER_Y)) - JITTER_Y,
    };
  }

  // Windows on an arc to the right of the row's edge, one direction each.
  // Their height comes first, because it is what decides how much vertical
  // room is left to fan them out in - a screen full of tall windows has no
  // arc, only a column.
  function arcFor(sessionId, count) {
    const anchor = anchorOf(sessionId) ?? { x: 0, y: window.innerHeight / 2 };
    const usable = window.innerHeight - 2 * GAP;
    // Two windows' worth of vertical room at most, so there is always
    // somewhere for the next one to sit.
    const height = Math.min(MAX_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, Math.floor(usable / 2.2)));
    const top = GAP + height / 2;
    const bottom = window.innerHeight - GAP - height / 2;
    return {
      anchor,
      height,
      top,
      span: Math.max(0, bottom - top),
      radius: Math.max(MIN_ARC_RADIUS, Math.min(MAX_ARC_RADIUS, window.innerWidth - anchor.x - WINDOW_WIDTH - GAP)),
      count,
    };
  }

  // How many windows this screen can fan out before their title bars start
  // covering each other.
  function capacityFor(sessionId) {
    if (narrow()) return MAX_WINDOWS;
    const arc = arcFor(sessionId, MAX_WINDOWS);
    return Math.max(1, Math.min(MAX_WINDOWS, Math.floor(arc.span / ARC_MIN_SEPARATION) + 1));
  }

  function layout(sessionId) {
    if (narrow()) return;
    const mine = [...open.values()].filter((entry) => entry.sessionId === sessionId && !entry.moved);
    if (mine.length === 0) return;
    const arc = arcFor(sessionId, mine.length);
    mine.forEach((entry, index) => {
      // Evenly over the vertical room, then out to the arc: a window level
      // with the edge sits furthest away, one above or below comes back in.
      // That is what makes the set read as a half circle around the row
      // rather than as a row of its own.
      const t = mine.length === 1 ? 0.5 : index / (mine.length - 1);
      const centerY = arc.top + t * arc.span;
      const jitter = jitterOf(entry.agentId);
      const radius = Math.max(MIN_ARC_RADIUS, arc.radius + jitter.radius);
      const dy = centerY - arc.anchor.y;
      const dx = Math.max(MIN_ARC_RADIUS / 2, Math.sqrt(Math.max(0, radius * radius - dy * dy)));
      entry.x = arc.anchor.x + dx;
      entry.y = centerY - arc.height / 2 + jitter.y;
      entry.el.style.width = `${WINDOW_WIDTH}px`;
      entry.el.style.height = `${arc.height}px`;
      place(entry, WINDOW_WIDTH);
    });
  }

  function makeDraggable(entry, bar) {
    bar.addEventListener('pointerdown', (event) => {
      // The close button lives in the bar and has to stay a button.
      if (event.target.closest('.agent-window-close')) return;
      if (narrow()) return;
      event.preventDefault();
      bar.setPointerCapture(event.pointerId);
      const grabX = event.clientX - entry.x;
      const grabY = event.clientY - entry.y;
      entry.moved = true;
      const move = (e) => {
        entry.x = e.clientX - grabX;
        entry.y = e.clientY - grabY;
        place(entry);
      };
      const stop = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', stop);
        bar.removeEventListener('pointercancel', stop);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', stop);
      bar.addEventListener('pointercancel', stop);
    });
  }

  function openWindow(sessionId, agent) {
    const anchor = anchorOf(sessionId);
    const el = document.createElement('div');
    el.className = 'agent-window';
    el.innerHTML =
      '<div class="agent-window-bar">'
      + '<span class="agent-window-title"></span>'
      + `<button class="btn-quiet agent-window-close" title="Close">${svg('close', 'icon-symbol')}</button>`
      + '</div><div class="agent-window-body"></div>';
    el.querySelector('.agent-window-title').textContent = [agent.agentType, agent.description].filter(Boolean).join(' · ');
    containerEl.appendChild(el);

    const entry = {
      el,
      agentId: agent.agentId,
      sessionId,
      offset: 0,
      x: (anchor?.x ?? 0) + MIN_ARC_RADIUS,
      y: GAP,
      // Set once this window has been dragged: layout() leaves it alone
      // from then on, so a placement by hand survives the next one.
      moved: false,
    };
    open.set(agent.agentId, entry);
    place(entry);
    // Out of the edge: the window starts collapsed at the anchor and
    // expands into its place, so it reads as coming from the row.
    if (anchor && !narrow()) {
      el.animate(
        [{ transform: `translate(${anchor.x - entry.x}px, ${anchor.y - entry.y}px) scale(0.1)`, opacity: 0 },
          { transform: 'none', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
    el.querySelector('.agent-window-close').addEventListener('click', () => closeWindow(agent.agentId));
    makeDraggable(entry, el.querySelector('.agent-window-bar'));
    loadInto(entry, agent.agentId);
  }

  function closeWindow(agentId) {
    const entry = open.get(agentId);
    if (!entry) return;
    const anchor = anchorOf(entry.sessionId);
    open.delete(agentId);
    const done = () => {
      entry.el.remove();
      drawLines();
    };
    if (!anchor || narrow()) {
      done();
      return;
    }
    // Back into the edge, the same movement reversed.
    entry.el.animate(
      [{ transform: 'none', opacity: 1 },
        { transform: `translate(${anchor.x - entry.x}px, ${anchor.y - entry.y}px) scale(0.1)`, opacity: 0 }],
      { duration: 200, easing: 'ease-in' },
    ).addEventListener('finish', done);
  }

  // One cubic curve per open window, from the row edge to the window's left
  // side. Redrawn on every move rather than tracked per window: the
  // geometry is cheap and is always right this way.
  function drawLines() {
    lineEl.replaceChildren();
    if (narrow()) return;
    // Curves to windows in the same row would otherwise run as one bundle;
    // a different attach height per window fans them apart.
    const seen = new Map();
    for (const [agentId, entry] of open) {
      const anchor = anchorOf(entry.sessionId);
      if (!anchor) continue;
      const fan = seen.get(entry.sessionId) ?? 0;
      seen.set(entry.sessionId, fan + 1);
      const toX = entry.x;
      const toY = entry.y + 18 + fan * 12;
      const bend = Math.max(40, (toX - anchor.x) / 2);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${anchor.x} ${anchor.y} C ${anchor.x + bend} ${anchor.y}, ${toX - bend} ${toY}, ${toX} ${toY}`);
      path.setAttribute('class', 'agent-line');
      path.dataset.agentId = agentId;
      lineEl.appendChild(path);
    }
  }

  // A pulse per event, not a running animation: a still agent has a still
  // line, so the movement means something.
  function pulse(agentId) {
    const path = lineEl.querySelector(`.agent-line[data-agent-id="${agentId}"]`);
    if (!path) return;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'agent-pulse');
    const motion = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    motion.setAttribute('dur', '0.9s');
    motion.setAttribute('path', path.getAttribute('d'));
    motion.setAttribute('fill', 'freeze');
    dot.appendChild(motion);
    lineEl.appendChild(dot);
    motion.addEventListener('endEvent', () => dot.remove());
  }

  function toggle(sessionId, agents) {
    const mine = [...open.values()].some((entry) => entry.sessionId === sessionId);
    if (mine) {
      for (const [agentId, entry] of [...open] ) if (entry.sessionId === sessionId) closeWindow(agentId);
      return;
    }
    agents.filter((a) => a.status === 'active').slice(0, capacityFor(sessionId))
      .forEach((agent) => openWindow(sessionId, agent));
    layout(sessionId);
  }

  function noteDelta(sessionId, agents) {
    const showing = [...open.values()].filter((entry) => entry.sessionId === sessionId).length;
    let placed = showing;
    for (const agent of agents) {
      if (open.has(agent.agentId)) {
        const entry = open.get(agent.agentId);
        loadInto(entry, agent.agentId);
        pulse(agent.agentId);
        if (agent.status !== 'active') markDone(entry, agent.agentId);
        continue;
      }
      // An agent that starts while this session's windows are open gets one
      // too. Without this, only what was running at the moment of the click
      // ever appeared, and the next agent stayed invisible behind a count
      // that had already gone up.
      if (showing > 0 && agent.status === 'active' && placed < capacityFor(sessionId)) {
        openWindow(sessionId, agent);
        placed += 1;
        layout(sessionId);
      }
    }
  }

  function markDone(entry, agentId) {
    if (entry.closing) return;
    entry.closing = true;
    entry.el.classList.add('agent-window-done');
    const title = entry.el.querySelector('.agent-window-title');
    title.textContent = `${title.textContent} · finished`;
    setTimeout(() => closeWindow(agentId), CLOSE_AFTER_DONE_MS);
  }

  function closeAll() {
    for (const agentId of [...open.keys()]) closeWindow(agentId);
  }

  // A window whose row is gone - the session was ended, or the list no
  // longer shows it - has nothing left to belong to. Called after a list
  // rebuild, since no stream event reports a session's disappearance.
  function pruneMissingRows() {
    for (const [agentId, entry] of [...open]) {
      // The row, not its edge: the edge hides as soon as the count drops to
      // zero, and a finished window still has its few seconds to show that
      // it finished.
      if (!document.querySelector(`.session-row[data-session-id="${entry.sessionId}"]`)) closeWindow(agentId);
    }
  }

  window.addEventListener('resize', () => {
    // Re-tiled rather than only clamped: the number of columns that fit has
    // probably changed. A window placed by hand keeps its spot.
    for (const sessionId of new Set([...open.values()].map((entry) => entry.sessionId))) layout(sessionId);
    for (const entry of open.values()) place(entry);
    drawLines();
  });
  // The anchor moves with the list, so the curves have to follow it.
  sidebarEl?.addEventListener('scroll', drawLines, { passive: true });

  return { toggle, noteDelta, closeAll, pruneMissingRows, openCount: () => open.size };
}
