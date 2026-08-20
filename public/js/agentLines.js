// public/js/agentLines.js
//
// The glowing connections between a session's row and its open agent windows,
// and the pulses that run along them. Owns the svg overlay and nothing else:
// it is handed finished curves and draws them, so the window module never
// touches a path, a filter or an animation.
//
// The glow is an SVG filter rather than `filter: drop-shadow`: a drop shadow
// is one offset copy and reads as a thin line with a haze, while a blurred
// copy of the stroke merged under the sharp one reads as light.
const GLOW_FILTER_ID = 'agentLineGlow';
// A pulse travels at a speed, not for a duration: the routes share a trunk
// but end at very different distances, and one duration for all of them had
// two dots on the same stretch moving at visibly different speeds.
// 0.65px/ms puts the shortest line in a layout - around 310px - at just under
// 0.7s, which is still long enough to register as a moving dot, and the
// longest at about 2s.
const PULSE_SPEED_PX_MS = 0.65;
const PULSE_MIN_MS = 700;
const PULSE_MAX_MS = 2400;
const RETRACT_MS = 420;

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

// The route's own segments, written out. The curve is decided in
// agentLayout.js, where it can be measured without a browser; nothing about
// the shape is decided here.
export function pathString(path) {
  const round = (value) => Math.round(value * 10) / 10;
  let d = `M ${round(path.start.x)} ${round(path.start.y)}`;
  for (const segment of path.segments) {
    d += segment.c1
      ? ` C ${round(segment.c1.x)} ${round(segment.c1.y)}, ${round(segment.c2.x)} ${round(segment.c2.y)},`
        + ` ${round(segment.to.x)} ${round(segment.to.y)}`
      : ` L ${round(segment.to.x)} ${round(segment.to.y)}`;
  }
  return d;
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
      const d = pathString(route.path);
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
    const duration = Math.min(PULSE_MAX_MS, Math.max(PULSE_MIN_MS, path.getTotalLength() / PULSE_SPEED_PX_MS));
    const run = dot.animate(
      [{ offsetDistance: direction === 'toLead' ? '100%' : '0%' },
        { offsetDistance: direction === 'toLead' ? '0%' : '100%' }],
      { duration, easing: 'ease-in-out' },
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
