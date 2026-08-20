// public/js/agentLines.js
//
// The glowing connections between a session's row and its open agent windows,
// and the pulses that run along them. Owns the svg overlay and nothing else:
// it is handed waypoints and draws them, so the window module never touches a
// path, a filter or an animation.
//
// The glow is an SVG filter rather than `filter: drop-shadow`: a drop shadow
// is one offset copy and reads as a thin line with a haze, while a blurred
// copy of the stroke merged under the sharp one reads as light.
const GLOW_FILTER_ID = 'agentLineGlow';
const PULSE_DURATION_MS = 1100;
const RETRACT_MS = 420;
// How much of a corner is rounded off. Generous on purpose: with a small
// radius the turn out of a lane into a window is very nearly a right angle,
// and a line of right angles reads as plumbing rather than as a cable.
const CORNER_RADIUS = 34;

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

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// `travel` units from `from` towards `to`.
function towards(from, to, travel) {
  const span = distance(from, to);
  if (span === 0) return { ...from };
  return { x: from.x + ((to.x - from.x) * travel) / span, y: from.y + ((to.y - from.y) * travel) / span };
}

// Waypoints the route did not need: two in the same place, or one sitting on
// the straight line between its neighbours. Left in, each would add a corner
// where there is no turn.
function meaningful(points) {
  const kept = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && distance(last, point) < 1) continue;
    kept.push(point);
  }
  return kept.filter((point, i) => {
    if (i === 0 || i === kept.length - 1) return true;
    const [a, b] = [kept[i - 1], kept[i + 1]];
    const area = Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
    return area / Math.max(1, distance(a, b)) > 1;
  });
}

// A polyline with its corners rounded off - straight where nothing turns, and
// a real curve where something does. Exported so the crossing check can
// sample the very path that gets drawn (see scripts/probe/).
export function smoothPath(points) {
  const pts = meaningful(points);
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [before, corner, after] = [pts[i - 1], pts[i], pts[i + 1]];
    const radius = Math.min(CORNER_RADIUS, distance(before, corner) / 2, distance(corner, after) / 2);
    const start = towards(corner, before, radius);
    const end = towards(corner, after, radius);
    d += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y}, ${end.x} ${end.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

export function initAgentLines(svgEl) {
  svgEl.appendChild(glowDefs());
  // Two groups: the live lines, replaced on every draw, and the ones on their
  // way out, which a draw must not take with them.
  const live = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  const leaving = element('g', { filter: `url(#${GLOW_FILTER_ID})` });
  svgEl.append(live, leaving);

  // agentId -> its drawn path, so a pulse can follow the same line and a
  // retract can take the very element that was on screen.
  const drawn = new Map();

  // Everything at once, every time. Drawing per session was a bug twice over:
  // the second session's draw wiped the first one's lines, and with nothing
  // open the loop body never ran, so the last lines stayed on screen after
  // their windows were gone.
  function draw(routes) {
    live.replaceChildren();
    drawn.clear();
    for (const route of routes) {
      const d = smoothPath(route.points);
      if (!d) continue;
      const path = element('path', { d, class: 'agent-line' });
      live.appendChild(path);
      drawn.set(route.agentId, path);
    }
  }

  // A pulse stands for one message and travels the way the message did: out
  // from the row for something the session sent, back along the same line for
  // something the agent sent.
  //
  // CSS motion path rather than SMIL's animateMotion: SMIL runs on the main
  // thread and stutters whenever anything else is busy, which for a terminal
  // streaming output is most of the time.
  function pulse(agentId, direction = 'toAgent') {
    const path = drawn.get(agentId);
    if (!path) return;
    const dot = element('circle', { r: 4, cx: 0, cy: 0, class: `agent-pulse agent-pulse-${direction}` });
    dot.style.offsetPath = `path("${path.getAttribute('d')}")`;
    dot.style.offsetRotate = '0deg';
    live.appendChild(dot);
    const run = dot.animate(
      [{ offsetDistance: direction === 'toLead' ? '100%' : '0%' },
        { offsetDistance: direction === 'toLead' ? '0%' : '100%' }],
      { duration: PULSE_DURATION_MS, easing: 'ease-in-out' },
    );
    run.addEventListener('finish', () => dot.remove());
    // A pulse whose line is redrawn under it would otherwise stay for good,
    // since its finish event never fires once it is out of the tree.
    run.addEventListener('cancel', () => dot.remove());
  }

  // The connection closing, rather than the line simply not being drawn any
  // more: it pulls back towards the row and fades as it goes. Moved out of the
  // live group first, or the next draw would take it away mid-animation.
  function retract(agentId) {
    const path = drawn.get(agentId);
    if (!path) return;
    drawn.delete(agentId);
    const length = path.getTotalLength();
    leaving.appendChild(path);
    path.style.strokeDasharray = `${length}`;
    const run = path.animate(
      [{ strokeDashoffset: '0', opacity: 0.9 }, { strokeDashoffset: `${-length}`, opacity: 0 }],
      { duration: RETRACT_MS, easing: 'ease-in' },
    );
    run.addEventListener('finish', () => path.remove());
    run.addEventListener('cancel', () => path.remove());
  }

  function clear() {
    live.replaceChildren();
    drawn.clear();
  }

  return { draw, pulse, retract, clear };
}
