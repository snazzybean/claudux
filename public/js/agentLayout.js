// public/js/agentLayout.js
//
// Where the agent windows go, and where a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node
// and counting the crossings rather than squinting at a screenshot.
//
// Every window gets its OWN line from the row, and the lines run as an
// ordered bundle: each one swings into a lane of its own, runs along it, and
// turns into its window. That ordering is what keeps them apart, and it is
// the established answer for a fan-out of edges from one point (edge
// bundling with ordered lanes) rather than something invented here.
//
// The rule that carries it: the window that turns off FIRST takes the lane
// closest to the windows. A line only crosses lanes while turning, and those
// lanes belong to windows further along, which have not turned yet. Reversed,
// it measures as three crossings out of three windows.
//
// Two shapes were tried before and are worth not repeating. An arc with the
// nearest edge picked per window mixes the arrival sides and crosses. And one
// shared trunk with short stubs hanging off it is crossing-free but reads as
// a single cable with taps rather than as a connection per agent.

const WINDOW_WIDTH = 300;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 300;
const GAP = 12;
// Clear of the row's edge, so the bundle is not on top of the sidebar.
const CORRIDOR = 96;
// Between the bundle's outermost lane and the edge of a window: the room the
// turn needs.
const CLEARANCE = 30;
// Distance between two lanes of the bundle.
const LANE = 11;
// How far in from a window's leading corner its line meets it. Off-centre, so
// the line reads as hanging off the window rather than balancing it.
const ENTRY_INSET = 46;
// Where the bundle turns off the row: far enough out that the swing into a
// lane is a curve rather than a kink.
const LANE_ENTRY = 56;
// How far before its window a line leaves its lane to turn in.
const TURN_LEAD = 40;

// The bundle needs room between the row and the windows: one lane per window
// on that side, plus the clearance the turn takes.
function bundleDepth(count) {
  return CLEARANCE + count * LANE;
}

function gridFor(anchor, viewport, count) {
  const left = anchor.x + CORRIDOR;
  const columns = Math.max(1, Math.floor((viewport.width - left) / (WINDOW_WIDTH + GAP)));
  const depth = bundleDepth(Math.min(count, columns));
  const above = anchor.y - GAP - depth;
  const below = viewport.height - GAP - anchor.y - depth;
  const twoRows = count > columns;
  const room = twoRows ? Math.min(above, below) : Math.max(above, below);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, room));
  return { left, columns, twoRows, height, depth, aboveIsRoomier: above >= below };
}

// How many windows fit before a second row would have nowhere to go.
export function layoutCapacity(anchor, viewport, limit) {
  const { columns, height, depth } = gridFor(anchor, viewport, limit);
  const above = anchor.y - GAP - depth >= height;
  const below = viewport.height - GAP - anchor.y - depth >= height;
  return Math.max(1, Math.min(limit, columns * ((above ? 1 : 0) + (below ? 1 : 0) || 1)));
}

// One box per agent id, in the order given: the first row fills up, the rest
// go below the trunk.
export function layoutFor(agentIds, anchor, viewport) {
  const { left, columns, twoRows, height, depth, aboveIsRoomier } = gridFor(anchor, viewport, agentIds.length);
  const firstRowAbove = twoRows ? true : aboveIsRoomier;
  return agentIds.map((agentId, index) => {
    const column = index % columns;
    const isAbove = Math.floor(index / columns) === 0 ? firstRowAbove : !firstRowAbove;
    return {
      agentId,
      box: {
        x: left + column * (WINDOW_WIDTH + GAP),
        y: isAbove ? anchor.y - depth - height : anchor.y + depth,
        width: WINDOW_WIDTH,
        height,
      },
    };
  });
}

// One route per window, as an ordered bundle: swing out of the row into a
// lane of this window's own, run along it, turn into the window.
//
// Read from the boxes as they are right now rather than from the layout, so a
// window dragged anywhere - including across to the other side of the row,
// where it is met on its other edge - takes its line along with it. The lane
// order is decided here too, per side and by how far along the window sits:
// the one that turns off first gets the lane nearest the windows, so a turn
// never crosses a lane that is still in use.
export function routesFor(boxes, anchor) {
  const sides = { above: [], below: [] };
  for (const box of boxes) {
    const above = box.y + box.height / 2 < anchor.y;
    const entry = {
      x: box.x + Math.min(ENTRY_INSET, box.width / 2),
      y: above ? box.y + box.height : box.y,
    };
    sides[above ? 'above' : 'below'].push({ box, entry, above });
  }
  const routes = [];
  for (const side of ['above', 'below']) {
    const members = sides[side].sort((a, b) => a.entry.x - b.entry.x);
    members.forEach(({ box, entry, above }, rank) => {
      const dir = above ? -1 : 1;
      const laneY = anchor.y + dir * (CLEARANCE + (members.length - rank) * LANE);
      routes.push({
        box,
        entry,
        lane: { entryX: anchor.x + LANE_ENTRY, y: laneY, turnX: entry.x - TURN_LEAD },
      });
    });
  }
  return routes;
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
