// public/js/agentLayout.js
//
// Where the agent windows go, and where a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node
// and counting the crossings rather than squinting at a screenshot.
//
// One column beside the row, entered on the left edge. That is not a taste
// decision: the lines all start at one point on the sidebar, and curves from
// a single point to points on one vertical line nest inside each other -
// there is no arrangement of them that crosses. Everything else tried here
// had to be argued about instead. An arc with the nearest edge picked per
// window mixes the arrival sides; a wobbled arc puts a lower window further
// left than a higher one; and rows with a strip of lanes above them cross
// nothing but send every line up the left margin and along the top of the
// screen, because the anchor is beside the windows and below them, not above.
//
// The column also leaves the terminal readable to the right of it, which the
// rows did not.

const MIN_WIDTH = 300;
const MAX_WIDTH = 420;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 300;
const GAP = 12;
// Clear of the row's edge, so a curve has room to leave it sideways before
// it turns.
const CORRIDOR = 96;
// Share of the width right of the sidebar the column may take. The rest
// stays terminal.
const WIDTH_SHARE = 0.34;

function geometryFor(anchor, viewport, count) {
  const left = anchor.x + CORRIDOR;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor((viewport.width - left) * WIDTH_SHARE)));
  const usable = viewport.height - 2 * GAP;
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor((usable - (count - 1) * GAP) / count)));
  const block = count * height + (count - 1) * GAP;
  // Centred on the row it belongs to, so the shortest line is the one to the
  // window level with it and the fan opens evenly up and down. Clamped when
  // the row sits near an edge of the screen.
  const top = Math.min(Math.max(anchor.y - block / 2, GAP), Math.max(GAP, viewport.height - GAP - block));
  return { left, width, height, top };
}

// How many windows fit before one would be shorter than it is worth.
export function layoutCapacity(anchor, viewport, limit) {
  const usable = viewport.height - 2 * GAP;
  return Math.max(1, Math.min(limit, Math.floor((usable + GAP) / (MIN_HEIGHT + GAP))));
}

// One box and one route per agent id, in the order given. The route is two
// points: out of the row's edge, and the arrival on the window's left edge.
export function layoutFor(agentIds, anchor, viewport) {
  const { left, width, height, top } = geometryFor(anchor, viewport, agentIds.length);
  return agentIds.map((agentId, index) => {
    const box = { x: left, y: top + index * (height + GAP), width, height };
    return {
      agentId,
      box,
      route: {
        from: anchor,
        entry: { x: box.x, y: box.y + height / 2 },
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
