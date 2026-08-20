// public/js/agentArc.js
//
// Where the agent windows go: an arc around the row's glowing edge. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes it possible to reason about the shape at all
// (and to print a table of it for a given screen).
//
// Two things this got wrong before, both worth keeping written down:
// spreading the windows over the screen's HEIGHT rather than by angle put
// the outer ones further from the row than the radius, where the circle
// collapses and they end up back against the sidebar. And a SYMMETRIC fan is
// limited by its narrower side on both, so a row near the top of the sidebar
// produced a flat arc with everything clamped against the top edge.

const WINDOW_WIDTH = 360;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 420;
const GAP = 12;
const MIN_RADIUS = 220;
const MAX_RADIUS = 460;
// Half the widest opening of the fan. Whether it gets that far depends on the
// room above and below the row.
const HALF_OPENING = (62 * Math.PI) / 180;
// Vertical distance two windows need for both title bars to stay readable.
const MIN_SEPARATION = 96;
// How far a window may sit off its slot, as a share of the slot's own width.
// Evenly spaced windows are what read as a mechanism - the point of this is
// to break the regularity without letting two of them collide, so it stays
// under half a slot.
const SLOT_WOBBLE = 0.3;
const RADIUS_WOBBLE = 0.14;

// A stable number per agent. Derived from the id rather than drawn at random,
// so a window keeps its spot through every re-layout instead of hopping.
function seedOf(agentId) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// -1..1 from a seed, on two independent axes.
function wobbleOf(agentId) {
  const seed = seedOf(agentId);
  return {
    slot: ((seed % 1000) / 500) - 1,
    radius: (((seed >> 10) % 1000) / 500) - 1,
  };
}

function geometryFor(anchor, viewport) {
  const usable = viewport.height - 2 * GAP;
  // At most half the screen: every pixel of window height is a pixel the fan
  // has not got to open in, and a screen full of tall windows has no arc,
  // only a column.
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(usable / 2.2)));
  const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, viewport.width - anchor.x - WINDOW_WIDTH - GAP));
  const reach = (room) => Math.asin(Math.min(1, Math.max(0, room / radius)));
  return {
    height,
    radius,
    from: -Math.min(HALF_OPENING, reach(anchor.y - height / 2 - GAP)),
    to: Math.min(HALF_OPENING, reach(viewport.height - GAP - height / 2 - anchor.y)),
  };
}

// How many windows this screen can fan out before their title bars start
// covering each other.
export function arcCapacity(anchor, viewport, limit) {
  const { height, radius, from, to } = geometryFor(anchor, viewport);
  const extent = Math.min(radius * (Math.sin(to) - Math.sin(from)), Math.max(0, viewport.height - height - 2 * GAP));
  return Math.max(1, Math.min(limit, Math.floor(extent / MIN_SEPARATION) + 1));
}

// One box per agent id, in the order given. Each window's left edge sits on
// the arc: the one level with the row is furthest out, the ones above and
// below swing back in towards it.
export function arcPlacement(agentIds, anchor, viewport) {
  const { height, radius, from, to } = geometryFor(anchor, viewport);
  const slots = Math.max(1, agentIds.length - 1);
  const slotWidth = (to - from) / slots;
  const angles = agentIds.map((agentId, index) => {
    const base = agentIds.length === 1 ? (from + to) / 2 : from + index * slotWidth;
    return Math.min(to, Math.max(from, base + wobbleOf(agentId).slot * SLOT_WOBBLE * slotWidth));
  });
  // The wobble is free to push two windows towards each other, so the
  // minimum separation is enforced afterwards rather than hoped for: pushed
  // apart in order, since the last one may run into the end of the fan.
  const minSine = MIN_SEPARATION / radius;
  for (let i = 1; i < angles.length; i += 1) {
    const needed = Math.asin(Math.min(1, Math.sin(angles[i - 1]) + minSine));
    if (angles[i] < needed) angles[i] = Math.min(to, needed);
  }
  return agentIds.map((agentId, index) => {
    const reach = Math.max(MIN_RADIUS, radius * (1 + wobbleOf(agentId).radius * RADIUS_WOBBLE));
    return {
      agentId,
      width: WINDOW_WIDTH,
      height,
      x: anchor.x + reach * Math.cos(angles[index]),
      y: anchor.y + reach * Math.sin(angles[index]) - height / 2,
    };
  });
}

// Kept on screen: after a resize, or after being dragged past an edge.
export function clampBox(box, viewport) {
  const maxX = Math.max(0, viewport.width - box.width - GAP);
  const maxY = Math.max(0, viewport.height - box.height - GAP);
  return {
    ...box,
    x: Math.min(Math.max(box.x, 0), maxX),
    y: Math.min(Math.max(box.y, GAP), maxY),
  };
}
