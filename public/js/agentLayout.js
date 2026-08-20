// public/js/agentLayout.js
//
// Where the agent windows go, and which way a line reaches each one. Pure
// arithmetic on rectangles - it touches no DOM and knows nothing about
// windows, which is what makes the shape checkable by importing it in node,
// and is how the crossings below were counted rather than guessed at.
//
// Windows fill rows from the top of the screen, so the set always starts in
// the same place instead of wherever its sidebar row happens to sit. At most
// two rows, and that limit is what the whole shape rests on: one trunk runs
// along the gap between them and reaches every window from inside that gap.
// A third row would sit behind the second, and no single trunk can reach it
// without crossing one.
//
// A route is a curve, not a polyline: out of the row, up the corridor, into
// the trunk, along it, and a last swing into the window - up into the
// underside of a window above the trunk, down into the top of one below.
// The curves are handed over as cubic segments rather than as corners to be
// rounded later, so what the probe samples is the very line that gets drawn.
//
// The climb happens in a corridor of its own, as a vertical run between two
// wide bends. Swinging straight from the row to the trunk instead looks
// obvious and measures terribly: with the row near the bottom of the screen
// that is a thousand pixels of height across ninety of width, and the curve
// arrives at the trunk in a bend of 96 degrees - a right angle with a
// rounding, which is exactly the "kantig" this is meant to fix. Height is
// what a bend needs, and the vertical run is where it comes from.
//
// The lines avoid each other by their shape, not by care: every stub leaves
// the trunk within its own window's width, so two stubs share no stretch of
// screen and there is nothing for them to cross but the trunk they all lie
// on. Each cubic stays inside the box spanned by its own end points, because
// its control points do - which is what makes that argument hold for curves
// and not just for the corners this used to draw.

const WINDOW_WIDTH = 320;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 300;
const GAP = 12;
// The strip left of the windows, where a line climbs from the row's height to
// the trunk's. Nothing is placed in it. Wide enough for the two bends at the
// ends of that climb to be bends - and it costs nothing, because at every
// screen width measured it leaves the same number of columns as 60 did.
const CORRIDOR = 112;
// How wide the bends in the corridor are allowed to be, capped at half of
// whatever run they turn in. 44 measured as the roundest: below it the bends
// themselves are the tightest turn on the route, above it they push the stubs
// so far along the trunk that those become the tightest instead.
const TURN_RADIUS = 44;
// The gap the trunk runs in. Wide, and that is the point: a stub's curve can
// be no deeper than the gap it turns in, and at the 26px this used to be,
// every arrival was a corner with a dent in it rather than a curve.
const TRUNK_GAP = 72;
const MAX_ROWS = 2;
// Where along its own top or bottom edge a window is met, and how close to a
// corner that is allowed to get. Both are fractions of the window, so the
// point slides along with a window that is dragged instead of staying put.
const ENTRY_FRACTION = 0.42;
const ENTRY_MARGIN = 28;
// A stub is never narrower than this, however tight the window sits.
const MIN_STUB = 40;
// Below this much climb - as a multiple of a bend's radius - the approach is
// one S rather than two bends. Measured across 350 layouts, anything from 1.4
// to 1.8 leaves the sharpest turn on screen at the same 158°; the middle of
// that plateau is the value, so a nudge to any other constant here cannot tip
// the choice.
const S_CURVE_BELOW = 1.5;
// A window below the trunk branches this much later than the one above it in
// the same column. They would otherwise leave at the same point and read as a
// crossing, though they only touch.
const COLUMN_STAGGER = 16;
// Rows are the boxes at the same height; hand-dragged windows land within a
// few pixels of each other rather than exactly.
const ROW_TOLERANCE = 6;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// `travel` units from `from` towards `to`.
function towards(from, to, travel) {
  const span = distance(from, to);
  if (span === 0) return { ...from };
  return { x: from.x + ((to.x - from.x) * travel) / span, y: from.y + ((to.y - from.y) * travel) / span };
}

// A quarter turn's control points sit this far along the tangents from the
// corner: 1 - 0.5523, the constant that makes a cubic match a circle.
const KAPPA_REST = 0.4477;

// The corners of a polyline turned into real arcs - straight where nothing
// turns, a circular bend where something does. Emitted as cubic segments, so
// the shape lives here and the renderer only writes it out.
function roundedSegments(points, radius) {
  // Every radius from the original points, and none of them larger than half
  // the run it shares with its neighbour - so two bends at the ends of a short
  // run meet in the middle at worst, and never eat into each other. Measuring
  // against the previous bend's exit instead halves the second one: two bends
  // 86px apart came out at 43 and 21, and that 21 was a 142° corner in the
  // middle of an otherwise round line.
  const radii = points.map((corner, i) => (i === 0 || i === points.length - 1 ? 0 : Math.min(
    radius,
    distance(points[i - 1], corner) / 2,
    distance(corner, points[i + 1]) / 2,
  )));
  const segments = [];
  let from = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [corner, next] = [points[i], points[i + 1]];
    const r = radii[i];
    if (r < 1) continue;
    const enter = towards(corner, from, r);
    const leave = towards(corner, next, r);
    if (distance(from, enter) > 0.5) segments.push({ to: enter });
    segments.push({
      c1: towards(corner, from, r * KAPPA_REST),
      c2: towards(corner, next, r * KAPPA_REST),
      to: leave,
    });
    from = leave;
  }
  const last = points[points.length - 1];
  if (distance(from, last) > 0.5) segments.push({ to: last });
  return segments;
}

// Out of the row and onto the trunk, up to the point a window branches off.
// Two shapes, and which one is right depends on how far there is to climb:
// with room, two wide bends around a vertical run; with the row nearly level
// with the trunk, a single S across the corridor. Bends need height, and when
// there is almost none they shrink to a few pixels each - a row 24px from the
// trunk came out as a 109° zigzag, which is sharper than anything the shape
// this replaced ever produced.
function trunkApproach(anchor, corridorX, trunkY, branchX) {
  const rise = Math.abs(trunkY - anchor.y);
  if (rise < 0.5) return [{ to: { x: branchX, y: trunkY } }];
  if (rise < S_CURVE_BELOW * TURN_RADIUS) {
    const reach = (corridorX - anchor.x) / 2;
    const segments = [{
      c1: { x: anchor.x + reach, y: anchor.y },
      c2: { x: corridorX - reach, y: trunkY },
      to: { x: corridorX, y: trunkY },
    }];
    if (branchX > corridorX + 0.5) segments.push({ to: { x: branchX, y: trunkY } });
    return segments;
  }
  return roundedSegments([
    { x: anchor.x, y: anchor.y },
    { x: corridorX, y: anchor.y },
    { x: corridorX, y: trunkY },
    { x: branchX, y: trunkY },
  ], TURN_RADIUS);
}

function gridFor(anchor, viewport, count) {
  const left = anchor.x + CORRIDOR;
  const columns = Math.max(1, Math.floor((viewport.width - left - GAP) / (WINDOW_WIDTH + GAP)));
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(count / columns)));
  // The trunk's gap comes off the height once, whether it sits between two
  // rows or below the only one.
  const height = Math.min(MAX_HEIGHT, Math.max(
    MIN_HEIGHT,
    Math.floor((viewport.height - 2 * GAP - TRUNK_GAP) / rows),
  ));
  return { columns, rows, height, left };
}

// How many windows fit before a row would be shorter than it is worth.
export function layoutCapacity(anchor, viewport, limit) {
  const { columns } = gridFor(anchor, viewport, limit);
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.floor((viewport.height - 2 * GAP - TRUNK_GAP) / MIN_HEIGHT)));
  return Math.max(1, Math.min(limit, columns * rows));
}

// One box per agent id, in the order given: rows fill left to right from the
// top of the screen down, with the trunk's gap between them.
export function layoutFor(agentIds, anchor, viewport) {
  const { columns, height, left } = gridFor(anchor, viewport, agentIds.length);
  return agentIds.map((agentId, index) => ({
    agentId,
    box: {
      x: left + (index % columns) * (WINDOW_WIDTH + GAP),
      y: GAP + Math.floor(index / columns) * (height + TRUNK_GAP),
      width: WINDOW_WIDTH,
      height,
    },
  }));
}

// The boxes grouped by the height they sit at, top row first.
function rowsOf(boxes) {
  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - box.y) <= ROW_TOLERANCE) {
      row.boxes.push(box);
      row.bottom = Math.max(row.bottom, box.y + box.height);
    } else {
      rows.push({ y: box.y, bottom: box.y + box.height, boxes: [box] });
    }
  }
  return rows;
}

// The trunk runs between two rows of windows, never above or below the whole
// set: from below everything, a line to the top row would have to cross the
// bottom one. With a single row there is nothing to sit between, and it goes
// underneath - the row starts at the top of the screen, so above it there is
// no room.
//
// Read from the boxes as they are rather than from the layout, so a window
// dragged somewhere takes the trunk into account. Beyond two rows - which
// only dragging produces - the gap nearest the session's own row wins, and a
// window on the far side of another row does get a stub across it. One trunk
// cannot do better than that, and the alternative jumps around under the
// cursor while dragging.
function trunkHeight(rows, anchor) {
  if (rows.length < 2) return rows[0].bottom + TRUNK_GAP / 2;
  let best = null;
  for (let i = 1; i < rows.length; i += 1) {
    const y = (rows[i - 1].bottom + rows[i].y) / 2;
    const distance = Math.abs(y - anchor.y);
    if (!best || distance < best.distance) best = { y, distance };
  }
  return best.y;
}

// Where a line meets a window: on the edge facing the trunk, at a point that
// is a fraction of the way along it. A window the trunk runs through is met
// on its leading edge instead, which is the only side left.
function entryFor(box, trunkY) {
  const x = clamp(box.x + box.width * ENTRY_FRACTION, box.x + ENTRY_MARGIN, box.x + box.width - ENTRY_MARGIN);
  if (box.y >= trunkY) return { x: x + COLUMN_STAGGER, y: box.y, side: 'top' };
  if (box.y + box.height <= trunkY) return { x, y: box.y + box.height, side: 'bottom' };
  return {
    x: box.x,
    y: clamp(trunkY, box.y + ENTRY_MARGIN, box.y + box.height - ENTRY_MARGIN),
    side: 'left',
  };
}

// A route is a start point and a list of segments, each either a straight
// `{ to }` or a cubic `{ c1, c2, to }`. agentLines.js turns them into a path
// string and does nothing else with them; samplePath below walks the same
// segments, which is how the probe measures the drawn line.
export function routesFor(boxes, anchor) {
  if (boxes.length === 0) return [];
  const rows = rowsOf(boxes);
  const trunkY = trunkHeight(rows, anchor);
  const leftMost = Math.min(...boxes.map((box) => box.x));
  // The vertical run, just clear of the windows: as far right as the corridor
  // allows, because the bend into it can be no wider than half the distance
  // from the row - and that distance is all there is.
  const corridorX = Math.max(anchor.x + 28, leftMost - 24);

  // No stub may branch off before the corridor's bend has finished: inside it
  // the trunk is still curving, and a stub leaving there both crossed the
  // lines still following the bend and squeezed the bend's own radius down to
  // a few pixels. Measured, that one omission was 88 crossings and a 117°
  // corner - it is a constraint, not a constant to be chosen carefully.
  const trunkStart = corridorX + 2 * TURN_RADIUS;

  // One width for every stub, and it is derived rather than chosen: as wide as
  // the leftmost window has room for between the trunk's start and its own
  // entry point. Picking a width instead left the first window with a stub
  // half the length of its neighbours', because its own was the only one the
  // clamp above ever cut short.
  const entries = boxes.map((box) => entryFor(box, trunkY));
  const stubWidth = Math.max(MIN_STUB, Math.min(...entries.map((entry) => entry.x)) - trunkStart);

  return boxes.map((box, index) => {
    const entry = entries[index];
    const branchX = entry.side === 'left'
      ? Math.max(trunkStart, entry.x)
      : Math.max(trunkStart, entry.x - stubWidth);
    const segments = trunkApproach(anchor, corridorX, trunkY, branchX);

    if (entry.side === 'left') {
      if (Math.abs(entry.y - trunkY) > 0.5) segments.push({ to: { x: entry.x, y: entry.y } });
    } else {
      // Horizontal off the trunk, vertical into the edge. Both control points
      // sit inside the rectangle between branch and entry, so the curve does
      // too - which is what keeps a stub inside its own window's width.
      segments.push({
        c1: { x: branchX + (entry.x - branchX) * 0.55, y: trunkY },
        c2: { x: entry.x, y: entry.y - (entry.y - trunkY) * 0.5 },
        to: { x: entry.x, y: entry.y },
      });
    }

    return { box, entry, trunkY, path: { start: { x: anchor.x, y: anchor.y }, segments } };
  });
}

// Points along a route, for measuring it. Here rather than in the probe
// because it has to read the segments exactly as the renderer does, and one
// reading of that format is enough.
export function samplePath(path, perSegment = 24) {
  const points = [{ ...path.start }];
  let from = path.start;
  for (const segment of path.segments) {
    if (!segment.c1) {
      points.push({ ...segment.to });
    } else {
      for (let i = 1; i <= perSegment; i += 1) {
        const t = i / perSegment;
        const u = 1 - t;
        const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        points.push({
          x: a * from.x + b * segment.c1.x + c * segment.c2.x + d * segment.to.x,
          y: a * from.y + b * segment.c1.y + c * segment.c2.y + d * segment.to.y,
        });
      }
    }
    from = segment.to;
  }
  return points;
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
