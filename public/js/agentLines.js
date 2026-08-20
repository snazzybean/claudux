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

// A single curve that leaves the row sideways and arrives at the window
// sideways: the control points sit horizontally out from both ends, so the
// line comes out of the edge and goes into the window instead of pointing at
// it. The bend grows with the distance, since a short connection with a long
// bend loops back on itself.
//
// Which points those are is agentLayout.js's decision - this only draws.
const MIN_BEND = 60;
const MAX_BEND = 200;

// The bend comes from the HORIZONTAL distance alone, which every window in
// the column shares - and that is what makes the set provably free of
// crossings rather than merely usually free. With one bend and one target x,
// a point on the curve is an affine function of the target's y with a
// positive coefficient, so the vertical order at every step is the order of
// the windows. Taking the bend from the diagonal distance instead, which is
// what stood here, gave the far windows a wider belly and let them overtake
// the near ones: five crossings out of six windows, measured.
function pathAlong({ from, entry }) {
  const bend = Math.min(MAX_BEND, Math.max(MIN_BEND, Math.abs(entry.x - from.x) / 2));
  return `M ${from.x} ${from.y}`
    + ` C ${from.x + bend} ${from.y}, ${entry.x - bend} ${entry.y}, ${entry.x} ${entry.y}`;
}

export function initAgentLines(svgEl) {
  svgEl.appendChild(glowDefs());
  // Its own group, so replaceChildren on it never takes the defs with it.
  const group = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  svgEl.appendChild(group);

  // agentId -> the path currently drawn for it, so a pulse can follow the
  // same curve without looking it up in the DOM.
  const paths = new Map();

  // One route per open window: `{ agentId, from, entry }`.
  function draw(routes) {
    group.replaceChildren();
    paths.clear();
    for (const route of routes) {
      const d = pathAlong(route);
      group.appendChild(element('path', { d, class: 'agent-line' }));
      paths.set(route.agentId, d);
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
