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

// Where a line may meet a window, and which way it has to leave from there.
// Four sockets rather than one fixed corner: a window above the row is met
// at its underside, one below it at its top, and one straight out to the
// right on its left edge - so the curve arrives along the window's own edge
// instead of cutting across it or across the windows in between.
const SOCKETS = [
  { at: (box) => ({ x: box.x, y: box.y + box.height / 2 }), out: { x: -1, y: 0 } },
  { at: (box) => ({ x: box.x + box.width, y: box.y + box.height / 2 }), out: { x: 1, y: 0 } },
  { at: (box) => ({ x: box.x + box.width / 2, y: box.y }), out: { x: 0, y: -1 } },
  { at: (box) => ({ x: box.x + box.width / 2, y: box.y + box.height }), out: { x: 0, y: 1 } },
];

const MIN_BEND = 55;
const MAX_BEND = 170;

// The socket nearest the row wins, which is also the one whose edge faces
// it - and it is recomputed on every draw, so dragging a window to the other
// side of the screen moves the connection to the side that now faces back.
function socketFor(box, anchor) {
  let best = null;
  for (const socket of SOCKETS) {
    const point = socket.at(box);
    const distance = (point.x - anchor.x) ** 2 + (point.y - anchor.y) ** 2;
    if (!best || distance < best.distance) best = { point, out: socket.out, distance };
  }
  return best;
}

// A curve that leaves the row horizontally - the edge it starts from is a
// vertical strip, so out of it means to the right - and arrives along the
// socket's own direction. The bend grows with the distance: a short
// connection with a long bend loops back on itself.
function pathTo(anchor, box) {
  const socket = socketFor(box, anchor);
  const bend = Math.min(MAX_BEND, Math.max(MIN_BEND, Math.sqrt(socket.distance) / 2));
  const c1 = { x: anchor.x + bend, y: anchor.y };
  const c2 = { x: socket.point.x + socket.out.x * bend, y: socket.point.y + socket.out.y * bend };
  return `M ${anchor.x} ${anchor.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${socket.point.x} ${socket.point.y}`;
}

export function initAgentLines(svgEl) {
  svgEl.appendChild(glowDefs());
  // Its own group, so replaceChildren on it never takes the defs with it.
  const group = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  svgEl.appendChild(group);

  // agentId -> the path currently drawn for it, so a pulse can follow the
  // same curve without looking it up in the DOM.
  const paths = new Map();

  // One connection per open window: `{ agentId, anchor, box }`. The socket is
  // chosen here rather than passed in, so a caller that moves a window only
  // has to draw again.
  function draw(connections) {
    group.replaceChildren();
    paths.clear();
    for (const { agentId, anchor, box } of connections) {
      const d = pathTo(anchor, box);
      group.appendChild(element('path', { d, class: 'agent-line' }));
      paths.set(agentId, d);
    }
  }

  // One pulse per real event rather than a permanent traveller: the line's
  // own flow says "something hangs here", the pulse says "something just
  // happened".
  function pulse(agentId) {
    const d = paths.get(agentId);
    if (!d) return;
    const dot = element('circle', { r: 4, class: 'agent-pulse' });
    const motion = element('animateMotion', { dur: `${PULSE_DURATION_MS / 1000}s`, path: d, fill: 'freeze' });
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
