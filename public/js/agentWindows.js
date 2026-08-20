// public/js/agentWindows.js
//
// A window per running subagent, thrown out of its session's glowing row edge
// and showing that agent's own conversation. What is inside comes from
// GET /api/sessions/:id/agents/:agentId - the SSE stream carries only the
// current tool, never the history, so a window fetches its blocks once and
// then follows the stream, asking each time only for what was appended.
//
// This module owns the windows: which are open, what is in them, and how they
// behave. Where they go and how a line reaches them is agentLayout.js, the
// drawing of those lines is agentLines.js, and how anything moves is
// motion.js - three things that were in here and each grew a name of their
// own.
import { svg } from './icons.js';
import { layoutFor, layoutCapacity, clampBox, routesFor } from './agentLayout.js';
import { initAgentLines } from './agentLines.js';
import { boxOf, flipFrom, springEasing, staggerDelay } from './motion.js';

// The upper bound; how many actually fit is the screen's business (see
// arcCapacity). One session in this project's own history had 46 agents in
// its directory.
const MAX_WINDOWS = 6;
// A finished agent's window stays long enough to see that it finished and to
// take in its last lines, then retracts by itself.
const CLOSE_AFTER_DONE_MS = 4000;
// Below this the sidebar is collapsed, so there is no edge to hang off and no
// room to place a window by hand - they stack instead. Same breakpoint every
// other narrow rule in styles.css uses.
const NARROW_PX = 720;
// A pointer has to travel this far before it counts as a drag rather than a
// click.
const DRAG_THRESHOLD_PX = 4;
const OPEN_MS = 420;
const CLOSE_MS = 220;

export function initAgentWindows({ containerEl, lineEl, sidebarEl }) {
  const lines = initAgentLines(lineEl);
  // agentId -> { el, agentId, sessionId, offset, box, moved, closing }
  const open = new Map();
  // Agents whose window was closed by hand. Without this, the next delta
  // reopened it a moment later - the rule that gives a newly started agent a
  // window cannot tell "new" from "dismissed" on its own.
  const dismissed = new Set();
  const spring = springEasing();

  const narrow = () => window.innerWidth <= NARROW_PX;
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  function anchorOf(sessionId) {
    const edge = document.querySelector(`.session-agents-edge[data-session-id="${sessionId}"]`);
    if (!edge) return null;
    const rect = edge.getBoundingClientRect();
    // A hidden edge is still found by querySelector and reports a rect of
    // zeroes, which would put the anchor in the top left corner exactly when
    // the count drops and a finished window is still on screen.
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.right, y: rect.top + rect.height / 2 };
  }

  function entriesOf(sessionId) {
    return [...open.values()].filter((entry) => entry.sessionId === sessionId);
  }

  function bySession() {
    const grouped = new Map();
    for (const entry of open.values()) {
      if (!grouped.has(entry.sessionId)) grouped.set(entry.sessionId, []);
      grouped.get(entry.sessionId).push(entry);
    }
    return grouped;
  }

  // ---------- what is inside ----------

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

  async function loadInto(entry) {
    const url = `/api/sessions/${encodeURIComponent(entry.sessionId)}/agents/${encodeURIComponent(entry.agentId)}?after=${entry.offset}`;
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
    // Follow the tail only while the reader is already there - scrolling back
    // to look at something must not be yanked away by an arriving block.
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  // ---------- where they sit ----------

  function applyBox(entry, box) {
    entry.box = box;
    entry.el.style.left = `${box.x}px`;
    entry.el.style.top = `${box.y}px`;
    entry.el.style.width = `${box.width}px`;
    entry.el.style.height = `${box.height}px`;
  }

  function drawLines() {
    if (narrow()) {
      lines.clear();
      return;
    }
    // One call with every session's routes: drawing per session wiped the
    // previous session's lines, and with nothing open the loop body never ran
    // at all, which left the last lines on screen after their windows had
    // gone.
    const routes = [];
    for (const [sessionId, entries] of bySession()) {
      const anchor = anchorOf(sessionId);
      const placed = entries.filter((entry) => entry.box);
      if (!anchor || placed.length === 0) continue;
      const byBox = new Map(placed.map((entry) => [entry.box, entry.agentId]));
      for (const route of routesFor(placed.map((entry) => entry.box), anchor)) {
        routes.push({ agentId: byBox.get(route.box), points: route.points });
      }
    }
    lines.draw(routes);
  }

  // Re-places every window of a session that has not been moved by hand, and
  // animates each one from where it was rather than letting it jump - the
  // FLIP that makes a re-arrangement read as one movement.
  function layout(sessionId, { animate = true } = {}) {
    if (narrow()) return;
    const mine = entriesOf(sessionId).filter((entry) => !entry.moved);
    if (mine.length === 0) return;
    const anchor = anchorOf(sessionId) ?? { x: 0, y: window.innerHeight / 2 };
    const before = animate ? mine.map((entry) => boxOf(entry.el)) : null;
    const placed = layoutFor(mine.map((entry) => entry.agentId), anchor, viewport());
    mine.forEach((entry, index) => {
      applyBox(entry, clampBox(placed[index].box, viewport()));
      if (before) flipFrom(entry.el, before[index], { durationMs: OPEN_MS, easing: spring });
    });
    drawLines();
  }

  // Windows overlap, and a covered one has to be reachable: any touch of a
  // window puts it on top. By z-index rather than by moving the element -
  // re-inserting a node between pointerdown and click swallows the click, so
  // raising a window by re-appending it made its own close button stop
  // working, which is how the probe found this.
  let topZ = 0;
  function raise(entry) {
    topZ += 1;
    entry.el.style.zIndex = String(topZ);
  }

  function makeDraggable(entry, bar) {
    bar.addEventListener('pointerdown', (event) => {
      // The close button lives in the bar and has to stay a button.
      if (event.target.closest('.agent-window-close')) return;
      if (narrow()) return;
      event.preventDefault();
      bar.setPointerCapture(event.pointerId);
      const grabX = event.clientX - entry.box.x;
      const grabY = event.clientY - entry.box.y;
      const startX = event.clientX;
      const startY = event.clientY;
      const move = (e) => {
        // A click on the bar is a pointerdown and a pointerup in the same
        // spot; only real movement counts as a drag. Without the threshold,
        // clicking a window to bring it forward pinned it out of the layout
        // for good.
        if (!entry.moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        // From here on layout() leaves this window alone, so a placement by
        // hand survives the next re-arrangement.
        entry.moved = true;
        applyBox(entry, clampBox({ ...entry.box, x: e.clientX - grabX, y: e.clientY - grabY }, viewport()));
        drawLines();
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

  // ---------- opening and closing ----------

  function openWindow(sessionId, agent, index) {
    const el = document.createElement('div');
    el.className = 'agent-window';
    el.innerHTML =
      '<div class="agent-window-bar">'
      + '<span class="agent-window-title"></span>'
      + `<button class="btn-quiet agent-window-close" title="Close">${svg('close', 'icon-symbol')}</button>`
      + '</div><div class="agent-window-body"></div>';
    el.querySelector('.agent-window-title').textContent = [agent.agentType, agent.description].filter(Boolean).join(' · ');
    containerEl.appendChild(el);

    const entry = { el, agentId: agent.agentId, sessionId, offset: 0, box: null, moved: false, closing: false };
    open.set(agent.agentId, entry);

    if (anchorOf(sessionId) && !narrow()) {
      // Out of the edge, one after the other: opening a set in the same frame
      // reads as one block appearing, a few dozen milliseconds apart reads as
      // a sequence. The spring lets each overshoot slightly, which is what
      // makes it look thrown rather than moved.
      el.animate(
        [{ transform: 'scale(0.15)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: OPEN_MS, delay: staggerDelay(index), easing: spring, fill: 'backwards' },
      );
    }
    el.querySelector('.agent-window-close').addEventListener('click', () => closeWindow(agent.agentId, { dismiss: true }));
    // Capture, so a window comes forward even when the click lands on
    // something inside it that stops the event.
    el.addEventListener('pointerdown', () => raise(entry), { capture: true });
    makeDraggable(entry, el.querySelector('.agent-window-bar'));
    loadInto(entry);
  }

  function closeWindow(agentId, { dismiss = false } = {}) {
    const entry = open.get(agentId);
    if (!entry) return;
    if (dismiss) dismissed.add(agentId);
    // The connection closes visibly rather than the line just stopping being
    // drawn: it pulls back towards the row while the window retracts.
    lines.retract(agentId);
    const anchor = anchorOf(entry.sessionId);
    open.delete(agentId);
    const done = () => {
      entry.el.remove();
      drawLines();
    };
    if (!anchor || narrow() || !entry.box) {
      done();
      return;
    }
    // Back into the edge, the same movement reversed.
    entry.el.animate(
      [{ transform: 'none', opacity: 1 },
        {
          transform: `translate(${anchor.x - entry.box.x}px, ${anchor.y - entry.box.y - entry.box.height / 2}px) scale(0.15)`,
          opacity: 0,
        }],
      { duration: CLOSE_MS, easing: 'ease-in' },
    ).addEventListener('finish', done);
  }

  function markDone(entry) {
    if (entry.closing) return;
    entry.closing = true;
    // The end reaching this agent, shown as it happens: a pulse out along the
    // line, and then the line itself pulls back when the window goes.
    lines.pulse(entry.agentId, 'toAgent');
    entry.el.classList.add('agent-window-done');
    const title = entry.el.querySelector('.agent-window-title');
    title.textContent = `${title.textContent} · finished`;
    setTimeout(() => closeWindow(entry.agentId), CLOSE_AFTER_DONE_MS);
  }

  // ---------- what app.js calls ----------

  function capacityFor(sessionId) {
    if (narrow()) return MAX_WINDOWS;
    const anchor = anchorOf(sessionId) ?? { x: 0, y: window.innerHeight / 2 };
    return layoutCapacity(anchor, viewport(), MAX_WINDOWS);
  }

  function toggle(sessionId, agents) {
    if (entriesOf(sessionId).length > 0) {
      // Closing the set is not dismissing its agents: opening it again is
      // meant to show everything that is running, not what survived.
      for (const entry of entriesOf(sessionId)) closeWindow(entry.agentId);
      return;
    }
    for (const agent of agents) dismissed.delete(agent.agentId);
    agents.filter((agent) => agent.status === 'active').slice(0, capacityFor(sessionId))
      .forEach((agent, index) => openWindow(sessionId, agent, index));
    // No FLIP on the first placement: the windows are already arriving from
    // the edge, and animating a move on top of that fights it.
    layout(sessionId, { animate: false });
  }

  function noteDelta(sessionId, agents) {
    const showing = entriesOf(sessionId).length;
    let placed = showing;
    for (const agent of agents) {
      const entry = open.get(agent.agentId);
      if (entry) {
        loadInto(entry);
        // Only a real message gets a pulse. Every other delta is the agent
        // changing tools, and a line that flashes for that says nothing.
        if (agent.signal) lines.pulse(agent.agentId, agent.signal);
        if (agent.status !== 'active') markDone(entry);
        continue;
      }
      // An agent that starts while this session's windows are open gets one
      // too. Without this, only what was running at the moment of the click
      // ever appeared, and the next agent stayed invisible behind a count
      // that had already gone up.
      if (showing > 0 && agent.status === 'active' && !dismissed.has(agent.agentId) && placed < capacityFor(sessionId)) {
        openWindow(sessionId, agent, 0);
        placed += 1;
        layout(sessionId);
      }
    }
  }

  function closeAll() {
    for (const agentId of [...open.keys()]) closeWindow(agentId);
  }

  // The row, not its edge: the edge hides as soon as the count drops to zero,
  // and a finished window still has its few seconds to show that it did.
  function pruneMissingRows() {
    for (const entry of [...open.values()]) {
      if (!document.querySelector(`.session-row[data-session-id="${entry.sessionId}"]`)) closeWindow(entry.agentId);
    }
  }

  // Below the breakpoint the windows are a stack laid out by the stylesheet,
  // so the inline box a wider screen wrote has to come off - CSS cannot
  // override an inline style without shouting.
  function unpin(entry) {
    entry.box = null;
    for (const property of ['left', 'top', 'width', 'height']) entry.el.style.removeProperty(property);
  }

  window.addEventListener('resize', () => {
    if (narrow()) {
      for (const entry of open.values()) unpin(entry);
      drawLines();
      return;
    }
    for (const sessionId of new Set([...open.values()].map((entry) => entry.sessionId))) layout(sessionId);
    for (const entry of open.values()) if (entry.moved && entry.box) applyBox(entry, clampBox(entry.box, viewport()));
    drawLines();
  });
  // The anchor moves with the list, so the curves have to follow it.
  sidebarEl?.addEventListener('scroll', drawLines, { passive: true });

  return { toggle, noteDelta, closeAll, pruneMissingRows, openCount: () => open.size };
}
