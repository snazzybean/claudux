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
const MAX_WINDOWS = 6;
// Far enough from the edge that the curve between them is visible - the
// lines sit under the windows, so a window starting right at its anchor
// hides its own line.
const CASCADE_START_X = 96;
const CASCADE_STEP_X = 28;
// Bigger than the title bar, so the bar of every window behind stays
// readable - the point of a cascade.
const CASCADE_STEP_Y = 38;
const WINDOW_WIDTH = 360;
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
    const name = document.createElement('span');
    name.className = 'agent-tool-name';
    name.textContent = block.name;
    const detail = document.createElement('span');
    detail.className = 'agent-tool-detail';
    detail.textContent = block.detail ?? '';
    el.append(name, detail);
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

  function place(entry) {
    if (narrow()) return;
    // Clamped so a window cannot end up off screen - after a resize, or
    // after being dragged past an edge.
    const maxX = Math.max(0, window.innerWidth - WINDOW_WIDTH - 8);
    const maxY = Math.max(0, window.innerHeight - 80);
    entry.x = Math.min(Math.max(entry.x, 0), maxX);
    entry.y = Math.min(Math.max(entry.y, 0), maxY);
    entry.el.style.left = `${entry.x}px`;
    entry.el.style.top = `${entry.y}px`;
    drawLines();
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

  function openWindow(sessionId, agent, index) {
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
      sessionId,
      offset: 0,
      x: (anchor?.x ?? 0) + CASCADE_START_X + index * CASCADE_STEP_X,
      y: (anchor?.y ?? 0) + index * CASCADE_STEP_Y,
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
    for (const [agentId, entry] of open) {
      const anchor = anchorOf(entry.sessionId);
      if (!anchor) continue;
      const toX = entry.x;
      const toY = entry.y + 16;
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
    agents.filter((a) => a.status === 'active').slice(0, MAX_WINDOWS)
      .forEach((agent, index) => openWindow(sessionId, agent, index));
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
      if (showing > 0 && agent.status === 'active' && placed < MAX_WINDOWS) {
        openWindow(sessionId, agent, placed);
        placed += 1;
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
      if (!anchorOf(entry.sessionId)) closeWindow(agentId);
    }
  }

  window.addEventListener('resize', () => {
    for (const entry of open.values()) place(entry);
    drawLines();
  });
  // The anchor moves with the list, so the curves have to follow it.
  sidebarEl?.addEventListener('scroll', drawLines, { passive: true });

  return { toggle, noteDelta, closeAll, pruneMissingRows, openCount: () => open.size };
}
