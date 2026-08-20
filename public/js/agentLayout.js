// public/js/agentLayout.js
//
// Where the agent windows go, and where a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node
// and counting the crossings rather than squinting at a screenshot.
//
// A trunk and its stubs: one horizontal line leaves the session's row at the
// row's own height and runs across, and every window hangs off it by a short
// stub - up into the underside of a window above the trunk, down into the top
// of one below it. Crossing-free for a plain reason: the stubs occupy
// disjoint stretches of the trunk and each stays within its own window's
// width, so there is nothing for them to cross but the trunk they all start
// on.
//
// Worth keeping written down, because both looked right on paper: an arc with
// the nearest edge picked per window mixes the arrival sides and crosses, and
// a single column with one shared bend is crossing-free but sends every line
// the long way round the screen - the anchor sits beside the windows, so a
// shape that ignores its height wastes the whole journey.

const WINDOW_WIDTH = 300;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 300;
const GAP = 12;
// Clear of the row's edge, so the first stub is not on top of the sidebar.
const CORRIDOR = 96;
// Between the trunk and the edge of a window: the room the stub curves in.
const STUB = 54;
// How far in from a window's leading corner its stub meets it. Off-centre, so
// the stub reads as hanging off the window rather than balancing it.
const ENTRY_INSET = 46;
// The trunk carries on a little past the last stub, so it ends as a line
// rather than at a junction.
const TRUNK_TAIL = 48;
// How far to the left of its window a stub leaves the trunk. Without it the
// stub is a vertical line out of the trunk; with it there is room for the
// curve that makes it read as a branch.
const STUB_LEAD = 38;
// A window below the trunk branches slightly later than the one above it in
// the same column, so the two never leave the trunk at the same point - that
// junction reads as one line splitting rather than as two lines meeting.
const BRANCH_SPLIT = 16;

function gridFor(anchor, viewport, count) {
  const left = anchor.x + CORRIDOR;
  const columns = Math.max(1, Math.floor((viewport.width - left) / (WINDOW_WIDTH + GAP)));
  const above = anchor.y - GAP - STUB;
  const below = viewport.height - GAP - anchor.y - STUB;
  const twoRows = count > columns;
  const room = twoRows ? Math.min(above, below) : Math.max(above, below);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, room));
  return { left, columns, twoRows, height, aboveIsRoomier: above >= below };
}

// How many windows fit before a second row would have nowhere to go.
export function layoutCapacity(anchor, viewport, limit) {
  const { columns, height } = gridFor(anchor, viewport, limit);
  const above = anchor.y - GAP - STUB >= height;
  const below = viewport.height - GAP - anchor.y - STUB >= height;
  return Math.max(1, Math.min(limit, columns * ((above ? 1 : 0) + (below ? 1 : 0) || 1)));
}

// One box per agent id, in the order given: the first row fills up, the rest
// go below the trunk.
export function layoutFor(agentIds, anchor, viewport) {
  const { left, columns, twoRows, height, aboveIsRoomier } = gridFor(anchor, viewport, agentIds.length);
  const firstRowAbove = twoRows ? true : aboveIsRoomier;
  return agentIds.map((agentId, index) => {
    const column = index % columns;
    const isAbove = Math.floor(index / columns) === 0 ? firstRowAbove : !firstRowAbove;
    return {
      agentId,
      box: {
        x: left + column * (WINDOW_WIDTH + GAP),
        y: isAbove ? anchor.y - STUB - height : anchor.y + STUB,
        width: WINDOW_WIDTH,
        height,
      },
    };
  });
}

// Where a window's stub leaves the trunk and where it meets the window. Read
// from the box as it is right now rather than from the layout, so a window
// dragged anywhere - including across the trunk - takes its stub along and
// changes which edge it is met on.
export function stubFor(box, anchor) {
  const above = box.y + box.height / 2 < anchor.y;
  const entry = {
    x: box.x + Math.min(ENTRY_INSET, box.width / 2),
    y: above ? box.y + box.height : box.y,
  };
  return {
    branch: { x: entry.x - STUB_LEAD + (above ? 0 : BRANCH_SPLIT), y: anchor.y },
    entry,
    above,
  };
}

// From the row's edge to just past the last stub.
export function trunkFor(boxes, anchor) {
  const ends = boxes.map((box) => stubFor(box, anchor).branch.x);
  return { from: anchor, to: { x: Math.max(anchor.x + CORRIDOR, ...ends) + TRUNK_TAIL, y: anchor.y } };
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
