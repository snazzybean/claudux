// public/js/agentLayout.js
//
// Where the agent windows go, and how a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node
// and printing a table of it.
//
// The shape is rows of windows with an empty strip above each row, and every
// line runs in that strip and drops into its window's top edge. That is what
// keeps them from crossing: lines that share a start, run in one strip and
// arrive in the same left-to-right order as their windows nest inside each
// other by construction. Two earlier shapes did cross - an arc with the
// nearest edge chosen per window mixes the arrival sides, and a scattered
// arc puts a lower window further left than a higher one, which inverts the
// order the nesting depends on.

const WINDOW_WIDTH = 320;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 290;
const GAP = 12;
// Clear of the row's edge, so the corridor the lines turn in is not under
// the first window.
const CORRIDOR = 104;
// The empty strip above a row that its lines run in. Tall enough for several
// lanes to be told apart.
const BAND = 72;
// Vertical distance between two lines running in the same strip.
const LANE = 9;
// Where along a window's top edge its line arrives. Off-centre towards the
// side the lines come from, so the drop is short.
const ENTRY_INSET = 52;

function gridFor(anchor, viewport, count) {
  const left = anchor.x + CORRIDOR;
  const areaWidth = viewport.width - left - GAP;
  const areaHeight = viewport.height - 2 * GAP;
  const columns = Math.max(1, Math.min(count, Math.floor((areaWidth + GAP) / (WINDOW_WIDTH + GAP))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const height = Math.min(MAX_HEIGHT, Math.max(
    MIN_HEIGHT,
    Math.floor((areaHeight - rows * BAND - (rows - 1) * GAP) / rows),
  ));
  return { left, columns, rows, height };
}

// How many windows fit before a row would be shorter than it is worth.
export function layoutCapacity(anchor, viewport, limit) {
  const left = anchor.x + CORRIDOR;
  const columns = Math.max(1, Math.floor((viewport.width - left) / (WINDOW_WIDTH + GAP)));
  const rows = Math.max(1, Math.floor((viewport.height - 2 * GAP + GAP) / (BAND + MIN_HEIGHT + GAP)));
  return Math.max(1, Math.min(limit, columns * rows));
}

// One box and one route per agent id, in the order given. The route is three
// points: out of the row's edge, a turn in the corridor at the strip's
// height, and the arrival on the window's top edge.
export function layoutFor(agentIds, anchor, viewport) {
  const { left, columns, height } = gridFor(anchor, viewport, agentIds.length);
  return agentIds.map((agentId, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const box = {
      x: left + column * (WINDOW_WIDTH + GAP),
      y: GAP + row * (BAND + height + GAP) + BAND,
      width: WINDOW_WIDTH,
      height,
    };
    // A lane per column, so lines sharing a strip run parallel instead of on
    // top of each other - and the leftmost window takes the lane CLOSEST to
    // the windows. That order is what avoids crossings: a line drops out of
    // its lane at its own window, and every lane it would have to cross on
    // the way down belongs to a window further right, which has not dropped
    // yet. The other way round, measured, is three crossings for three
    // windows.
    const bandY = box.y - LANE * (1 + column);
    return {
      agentId,
      box,
      route: {
        from: anchor,
        corridor: { x: left - GAP - 8, y: bandY },
        entry: { x: box.x + ENTRY_INSET, y: box.y },
      },
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
