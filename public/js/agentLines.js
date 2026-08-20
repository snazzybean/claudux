// public/js/agentLines.js
//
// The glowing connections between a session's row and its open agent windows,
// and the pulses that run along them. Owns the svg overlay and nothing else:
// it is handed routes and draws them, so the window module never touches a
// path, a filter or an animation.
//
// The glow is an SVG filter rather than `filter: drop-shadow`: a drop shadow
// is one offset copy and reads as a thin line with a haze, while a blurred
// copy of the stroke merged under the sharp one reads as light.
const GLOW_FILTER_ID = 'agentLineGlow';
const PULSE_DURATION_MS = 1100;

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
  // The blur twice under the sharp stroke: one copy is a haze, two is a glow.
  // Held as a reference rather than looked up again - a type selector for a
  // camelCase SVG tag is a trap in an HTML document.
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

// Out of the row into this line's own lane, along the lane, then a quarter
// turn into the window's edge. Horizontal where it leaves and vertical where
// it arrives, so it reads as a cable rather than as a diagonal pointing at
// something.
function pathFor({ entry, lane }) {
  return `M ${lane.fromX} ${lane.fromY}`
    + ` C ${lane.fromX + 40} ${lane.fromY}, ${lane.entryX - 24} ${lane.y}, ${lane.entryX} ${lane.y}`
    + ` L ${lane.turnX} ${lane.y}`
    + ` C ${entry.x} ${lane.y}, ${entry.x} ${lane.y}, ${entry.x} ${entry.y}`;
}

export function initAgentLines(svgEl) {
  svgEl.appendChild(glowDefs());
  // Its own group, so replacing the lines never takes the defs with it.
  const group = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  svgEl.appendChild(group);

  // agentId -> the path drawn for it, so a pulse can follow the same curve
  // without looking it up in the DOM.
  const paths = new Map();

  // Everything at once, every time. Drawing per session was a bug twice over:
  // the second session's draw wiped the first one's lines, and with nothing
  // open the loop body never ran, so the last lines stayed on screen after
  // their windows were gone.
  function draw(routes) {
    group.replaceChildren();
    paths.clear();
    for (const route of routes) {
      const d = pathFor(route);
      group.appendChild(element('path', { d, class: 'agent-line' }));
      paths.set(route.agentId, d);
    }
  }

  // A pulse stands for one message and travels the way the message did: out
  // from the row for something the session sent, back along the same path for
  // something the agent sent. The line's own flow says "something hangs
  // here"; a pulse says "this just went past".
  //
  // CSS motion path rather than SMIL's animateMotion: SMIL runs on the main
  // thread and stutters whenever anything else is busy, which for a terminal
  // streaming output is most of the time.
  function pulse(agentId, direction = 'toAgent') {
    const d = paths.get(agentId);
    if (!d) return;
    const dot = element('circle', { r: 4, cx: 0, cy: 0, class: `agent-pulse agent-pulse-${direction}` });
    dot.style.offsetPath = `path("${d}")`;
    dot.style.offsetRotate = '0deg';
    group.appendChild(dot);
    const from = direction === 'toLead' ? '100%' : '0%';
    const to = direction === 'toLead' ? '0%' : '100%';
    const run = dot.animate(
      [{ offsetDistance: from }, { offsetDistance: to }],
      { duration: PULSE_DURATION_MS, easing: 'ease-in-out' },
    );
    run.addEventListener('finish', () => dot.remove());
    // A pulse whose line is redrawn under it would otherwise sit there for
    // good, since its finish event never fires once it is out of the tree.
    run.addEventListener('cancel', () => dot.remove());
  }

  function clear() {
    group.replaceChildren();
    paths.clear();
  }

  return { draw, pulse, clear };
}
