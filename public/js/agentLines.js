// public/js/agentLines.js
//
// The glowing connections between a session's row and its open agent
// windows, and the pulses that run along them. Owns the svg overlay and
// nothing else: it is handed anchor and target points and draws, so the
// window module does not have to know about paths, filters or SVG at all.
//
// The glow is a filter rather than `filter: drop-shadow`: a drop shadow is
// one offset copy and reads as a thin line with a haze, while a blurred copy
// of the stroke merged under the sharp one is what reads as light.
const GLOW_FILTER_ID = 'agentLineGlow';
const PULSE_DURATION_MS = 900;

const SVG_NS = 'http://www.w3.org/2000/svg';

function element(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function glowDefs() {
  const defs = element('defs', {});
  const filter = element('filter', {
    id: GLOW_FILTER_ID,
    // Wide enough that the blur is not cut off at the path's own box.
    x: '-50%', y: '-50%', width: '200%', height: '200%',
  });
  // The blur twice under the sharp stroke: one copy is a haze, two is a
  // glow. Held as a reference rather than looked up again - a type selector
  // for a camelCase SVG tag is a trap in an HTML document.
  const merge = element('feMerge', {});
  merge.append(
    element('feMergeNode', { in: 'haze' }),
    element('feMergeNode', { in: 'haze' }),
    element('feMergeNode', { in: 'SourceGraphic' }),
  );
  filter.append(element('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 4, result: 'haze' }), merge);
  defs.appendChild(filter);
  return defs;
}

// The trunk is one straight line out of the session's row; a stub is a
// branch off it that turns into the window's near edge. Horizontal out of the
// trunk and vertical into the window, so it reads as a cable coming off a
// tray rather than as a diagonal pointing at something.
//
// Which points those are is agentLayout.js's decision - this only draws.
function trunkPath({ from, to }) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function stubPath({ branch, entry, above }) {
  const rise = above ? -1 : 1;
  const reach = Math.max(24, Math.abs(entry.y - branch.y) / 2);
  return `M ${branch.x} ${branch.y}`
    + ` C ${branch.x + reach} ${branch.y}, ${entry.x} ${entry.y - rise * reach}, ${entry.x} ${entry.y}`;
}

// What a pulse travels: out along the trunk to this window's branch, then up
// or down its stub. One path, so the dot never jumps between two.
function pulsePath(trunk, stub) {
  return `M ${trunk.from.x} ${trunk.from.y} L ${stub.branch.x} ${stub.branch.y}`
    + stubPath(stub).slice(stubPath(stub).indexOf(' C'));
}

export function initAgentLines(svgEl) {
  svgEl.appendChild(glowDefs());
  // Its own group, so replaceChildren on it never takes the defs with it.
  const group = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  svgEl.appendChild(group);

  // agentId -> the path currently drawn for it, so a pulse can follow the
  // same curve without looking it up in the DOM.
  const paths = new Map();

  // The trunk plus one stub per open window. A pulse gets the whole way from
  // the row to its window, which is neither of the drawn paths - hence the
  // third one, kept but not rendered.
  function draw({ trunk, stubs }) {
    group.replaceChildren();
    paths.clear();
    if (!trunk || stubs.length === 0) return;
    group.appendChild(element('path', { d: trunkPath(trunk), class: 'agent-line agent-trunk' }));
    for (const stub of stubs) {
      group.appendChild(element('path', { d: stubPath(stub), class: 'agent-line' }));
      paths.set(stub.agentId, pulsePath(trunk, stub));
    }
  }

  // A pulse stands for one message, and it travels the way the message did:
  // out from the row for something the session sent the agent, back along the
  // same path for something the agent sent the session. The line's own flow
  // says "something hangs here"; a pulse says "this just went past".
  function pulse(agentId, direction = 'toAgent') {
    const d = paths.get(agentId);
    if (!d) return;
    const dot = element('circle', { r: 4, class: `agent-pulse agent-pulse-${direction}` });
    const motion = element('animateMotion', {
      dur: `${PULSE_DURATION_MS / 1000}s`,
      path: d,
      fill: 'freeze',
      // Same path either way; a message from the agent simply runs it
      // backwards, which is also what makes the two read as one channel.
      keyPoints: direction === 'toLead' ? '1;0' : '0;1',
      keyTimes: '0;1',
      calcMode: 'linear',
    });
    dot.appendChild(motion);
    group.appendChild(dot);
    motion.addEventListener('endEvent', () => dot.remove());
  }

  function clear() {
    group.replaceChildren();
    paths.clear();
  }

  return { draw, pulse, clear };
}
