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
const MIN_WINDOW_WIDTH = 260;
// Below this a window shows a title bar and barely two lines, which is not
// worth a tile. Above the upper bound a single row would run the full height
// of the screen for a conversation that is a few lines long.
const MIN_WINDOW_HEIGHT = 180;
const MAX_WINDOW_HEIGHT = 420;
const GAP = 12;
// Distance from the row, so the curve between them is visible at all: the
// lines are drawn under the windows, and a window starting at its own
// anchor hides its own line. Dropped on a narrow screen, where that space
// is the difference between one column and none.
const ANCHOR_GAP = 96;
const ANCHOR_GAP_TIGHT = 24;
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

  // Spread over the area right of the row rather than cascaded from it: a
  // cascade of six 360px windows is six windows on top of each other, and
  // the whole point is seeing several agents at once.
  //
  // The screen decides the grid, not the other way round. As many columns
  // as fit at the preferred width, the rest as rows, and never more rows
  // than a readable window height allows - so a narrow screen gets fewer,
  // fully visible windows instead of a pile.
  function gridFor(sessionId, count) {
    const anchor = anchorOf(sessionId);
    const areaHeight = window.innerHeight - 2 * GAP;
    const maxRows = Math.max(1, Math.floor((areaHeight + GAP) / (MIN_WINDOW_HEIGHT + GAP)));
    const wideEnough = window.innerWidth - (anchor?.x ?? 0) - ANCHOR_GAP - GAP >= 2 * (MIN_WINDOW_WIDTH + GAP);
    const left = (anchor?.x ?? 0) + (wideEnough ? ANCHOR_GAP : ANCHOR_GAP_TIGHT);
    const areaWidth = window.innerWidth - left - GAP;
    const columns = Math.max(1, Math.min(count, Math.floor((areaWidth + GAP) / (WINDOW_WIDTH + GAP))));
    const rows = Math.min(maxRows, Math.ceil(count / columns));
    return {
      left,
      columns,
      rows,
      capacity: columns * maxRows,
      width: Math.min(WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, Math.floor((areaWidth + GAP) / columns) - GAP)),
      height: Math.min(MAX_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, Math.floor((areaHeight + GAP) / rows) - GAP)),
    };
  }

  // How many windows this screen can show at once without stacking them.
  function capacityFor(sessionId) {
    return narrow() ? MAX_WINDOWS : Math.min(MAX_WINDOWS, gridFor(sessionId, MAX_WINDOWS).capacity);
  }

  function layout(sessionId) {
    if (narrow()) return;
    const mine = [...open.values()].filter((entry) => entry.sessionId === sessionId && !entry.moved);
    if (mine.length === 0) return;
    const grid = gridFor(sessionId, mine.length);
    mine.forEach((entry, index) => {
      entry.x = grid.left + (index % grid.columns) * (grid.width + GAP);
      entry.y = GAP + Math.floor(index / grid.columns) * (grid.height + GAP);
      entry.el.style.width = `${grid.width}px`;
      entry.el.style.height = `${grid.height}px`;
      place(entry, grid.width);
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
      sessionId,
      offset: 0,
      x: (anchor?.x ?? 0) + ANCHOR_GAP,
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
