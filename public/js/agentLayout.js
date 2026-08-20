// public/js/agentLayout.js
//
// Where the agent windows go, and which way a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node,
// and is how the crossings below were counted rather than guessed at.
//
// Windows fill rows from the TOP of the screen, so the set always starts in
// the same place instead of wherever its sidebar row happens to sit.
//
// A route is a list of waypoints, not a curve: out of the row into a corridor
// lane of its own, along that corridor to its row's band, along the band, and
// then into the window's near edge. agentLines.js rounds the corners. Two
// orderings keep the lines apart, and both are easy to break by accident:
//
//   * in the CORRIDOR, the line that turns off first takes the OUTERMOST
//     lane - anything still travelling is then to its left and cannot be
//     crossed,
//   * in a BAND, the window that is reached first takes the lane closest to
//     the windows - a line only crosses lanes while turning in, and those
//     belong to windows further along, which have not turned yet.

const WINDOW_WIDTH = 320;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 300;
const GAP = 12;
// Where the corridor starts, clear of the row's edge.
const CORRIDOR = 60;
// Between a row of windows and its band, and between two lanes.
const CLEARANCE = 26;
const LANE = 12;
// How far in from a window's leading corner its line meets it.
const ENTRY_INSET = 48;
// How far before the window the line leaves its band, so the turn has room
// to be a curve rather than a corner.
const TURN_LEAD = 34;
// Vertical distance between two lines where they leave the row. Without it
// they all start on the same point and run as one stroke for the first
// stretch, which is exactly the "single cable" look this is not supposed to
// be - and it is also what let them cross each other while peeling off.
const START_SPREAD = 9;

function gridFor(anchor, viewport, count) {
  const columns = Math.max(1, Math.floor((viewport.width - anchor.x - CORRIDOR - GAP) / (WINDOW_WIDTH + GAP)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const perRow = Math.min(count, columns);
  // Every row needs its band underneath it, and the band is as deep as the
  // number of lanes it carries.
  const band = CLEARANCE + perRow * LANE;
  const height = Math.min(MAX_HEIGHT, Math.max(
    MIN_HEIGHT,
    Math.floor((viewport.height - 2 * GAP - rows * band) / rows),
  ));
  // The corridor carries one lane per LINE, not one per column - reserving
  // only the latter let it reach into the windows, and two lines ran straight
  // through one.
  return { columns, rows, band, height, left: anchor.x + CORRIDOR + LANE * count + CLEARANCE };
}

// How many windows fit before a row would be shorter than it is worth.
export function layoutCapacity(anchor, viewport, limit) {
  const { columns, band } = gridFor(anchor, viewport, limit);
  const rows = Math.max(1, Math.floor((viewport.height - 2 * GAP) / (MIN_HEIGHT + band)));
  return Math.max(1, Math.min(limit, columns * rows));
}

// One box per agent id, in the order given: rows fill left to right from the
// top of the screen down.
export function layoutFor(agentIds, anchor, viewport) {
  const { columns, band, height, left } = gridFor(anchor, viewport, agentIds.length);
  return agentIds.map((agentId, index) => ({
    agentId,
    box: {
      x: left + (index % columns) * (WINDOW_WIDTH + GAP),
      y: GAP + Math.floor(index / columns) * (height + band),
      width: WINDOW_WIDTH,
      height,
    },
  }));
}

// The waypoints for every box, read from the boxes as they are right now
// rather than from the layout - so a window dragged anywhere takes its line
// along with it.
//
// The band belongs to a ROW, not to a window: which edge a line arrives on is
// decided by where there is room for the band, and every window in that row is
// entered the same way. Deciding it per window against the session row's own
// height put the band above a row that starts at the top of the screen, which
// is off the screen.
export function routesFor(boxes, anchor, viewport) {
  const rows = new Map();
  for (const box of boxes) {
    const key = `${Math.round(box.y)}x${Math.round(box.height)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(box);
  }

  const legs = [];
  for (const members of rows.values()) {
    members.sort((a, b) => a.x - b.x);
    const [first] = members;
    const need = CLEARANCE + members.length * LANE;
    const below = first.y + first.height + need <= viewport.height - GAP;
    const outward = below ? 1 : -1;
    const bandBase = below ? first.y + first.height + CLEARANCE : first.y - CLEARANCE;
    members.forEach((box, rank) => {
      legs.push({
        box,
        entry: {
          x: box.x + Math.min(ENTRY_INSET, box.width / 2),
          y: below ? box.y + box.height : box.y,
        },
        // The window reached first takes the lane closest to the windows: a
        // line only crosses lanes while turning in, and those belong to
        // windows further along, which have not turned yet.
        laneY: bandBase + outward * rank * LANE,
      });
    });
  }

  // Two orderings, and the pair of them is what leaves no crossings at all.
  // Measured over a hundred combinations of screen, row position and window
  // count: this pair scores zero, while every other pairing of the same two
  // rules scores between 333 and 502.
  //
  // Where they leave the row, top to bottom in the order of their lanes.
  const byLane = [...legs].sort((a, b) => a.laneY - b.laneY);
  byLane.forEach((leg, rank) => {
    leg.startY = anchor.y + (rank - (byLane.length - 1) / 2) * START_SPREAD;
  });
  // And in the corridor, the line whose lane is NEAREST the row takes the
  // outermost position: it turns off first, and everything still travelling
  // is then to its left, where it cannot be crossed.
  const byNearest = [...legs].sort((a, b) => Math.abs(b.laneY - anchor.y) - Math.abs(a.laneY - anchor.y));
  byNearest.forEach((leg, rank) => {
    leg.corridorX = anchor.x + CORRIDOR + rank * LANE;
  });

  return legs.map(({ box, entry, laneY, corridorX, startY }) => ({
    box,
    entry,
    // Duplicate and near-collinear points are dropped by the renderer, so a
    // line whose lane happens to sit level with the row simply comes out
    // straighter.
    points: [
      { x: anchor.x, y: startY },
      { x: corridorX, y: startY },
      { x: corridorX, y: laneY },
      { x: entry.x - TURN_LEAD, y: laneY },
      { x: entry.x, y: laneY },
      entry,
    ],
  }));
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
