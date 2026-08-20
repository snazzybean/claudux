// Which ordering of start heights and corridor lanes leaves no crossings?
//
// agentLayout.routesFor decides two things: at which height each line leaves
// the session's row, and which corridor lane it takes. Both orderings are
// load-bearing and neither is obvious - this assembles the same waypoints with
// the orderings as parameters and counts crossings over a hundred combinations
// of screen, row position and window count.
//
// The pair in use scores zero; the three other pairings of the same two rules
// score between 333 and 502. Run it after touching either ordering.
//
//     node scripts/probe/orderings.mjs
import { layoutFor, layoutCapacity } from '/opt/claudux/public/js/agentLayout.js';

const CORRIDOR = 60;
const CLEARANCE = 26;
const LANE = 12;
const ENTRY_INSET = 48;
const TURN_LEAD = 34;
const GAP = 12;
const START_SPREAD = 9;

function legsOf(boxes, anchor, viewport) {
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
    const base = below ? first.y + first.height + CLEARANCE : first.y - CLEARANCE;
    members.forEach((box, rank) => {
      legs.push({
        box,
        entry: { x: box.x + Math.min(ENTRY_INSET, box.width / 2), y: below ? box.y + box.height : box.y },
        laneY: base + outward * rank * LANE,
      });
    });
  }
  return legs;
}

function pointsOf(legs, anchor, { startBy, corridorBy }) {
  const byStart = [...legs].sort(startBy(anchor));
  byStart.forEach((leg, i) => { leg.startY = anchor.y + (i - (byStart.length - 1) / 2) * START_SPREAD; });
  const byCorridor = [...legs].sort(corridorBy(anchor));
  byCorridor.forEach((leg, i) => { leg.corridorX = anchor.x + CORRIDOR + i * LANE; });
  return legs.map((leg) => [
    { x: anchor.x, y: leg.startY },
    { x: leg.corridorX, y: leg.startY },
    { x: leg.corridorX, y: leg.laneY },
    { x: leg.entry.x - TURN_LEAD, y: leg.laneY },
    { x: leg.entry.x, y: leg.laneY },
    leg.entry,
  ]);
}

const seg = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function samples(points) {
  const pts = [];
  for (let i = 1; i < points.length; i += 1) for (let t = 0; t < 1; t += 0.01) pts.push(seg(points[i - 1], points[i], t));
  return pts;
}
const sgn = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
function crossings(paths) {
  let n = 0;
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      outer: for (let a = 1; a < paths[i].length; a += 1) {
        for (let b = 1; b < paths[j].length; b += 1) {
          const [p, q, r, s] = [paths[i][a - 1], paths[i][a], paths[j][b - 1], paths[j][b]];
          if (Math.abs((q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x)) < 1e-9) continue;
          if (sgn(p, q, r) !== sgn(p, q, s) && sgn(r, s, p) !== sgn(r, s, q)) { n += 1; break outer; }
        }
      }
    }
  }
  return n;
}

const variants = {
  'Spur aufsteigend / Korridor aufsteigend': {
    startBy: () => (a, b) => a.laneY - b.laneY,
    corridorBy: () => (a, b) => a.laneY - b.laneY,
  },
  'Spur aufsteigend / Korridor absteigend': {
    startBy: () => (a, b) => a.laneY - b.laneY,
    corridorBy: () => (a, b) => b.laneY - a.laneY,
  },
  'Spur aufsteigend / Korridor nach Nähe': {
    startBy: () => (a, b) => a.laneY - b.laneY,
    corridorBy: (anchor) => (a, b) => Math.abs(b.laneY - anchor.y) - Math.abs(a.laneY - anchor.y),
  },
  'Nähe / Korridor nach Nähe': {
    startBy: (anchor) => (a, b) => Math.abs(a.laneY - anchor.y) - Math.abs(b.laneY - anchor.y),
    corridorBy: (anchor) => (a, b) => Math.abs(b.laneY - anchor.y) - Math.abs(a.laneY - anchor.y),
  },
};

const cases = [];
for (const [w, h] of [[1999, 1491], [1328, 800], [1224, 1731], [1600, 900]]) {
  for (const ay of [80, 300, 700, 1100, h - 80]) {
    for (const count of [2, 3, 5, 6, 8]) cases.push([w, h, ay, count]);
  }
}

for (const [label, variant] of Object.entries(variants)) {
  let total = 0;
  let worst = null;
  for (const [w, h, ay, count] of cases) {
    const vp = { width: w, height: h };
    const anchor = { x: 320, y: Math.max(40, Math.min(h - 40, ay)) };
    // Never more than the screen can hold - beyond that the rows run off the
    // bottom and the geometry is meaningless anyway.
    const n = Math.min(count, layoutCapacity(anchor, vp, 6));
    const boxes = layoutFor(Array.from({ length: n }, (_, i) => `a${i}`), anchor, vp).map((o) => o.box);
    const crossed = crossings(pointsOf(legsOf(boxes, anchor, vp), anchor, variant).map(samples));
    total += crossed;
    if (crossed > 0 && (!worst || crossed > worst.n)) worst = { n: crossed, w, h, ay, count: n };
  }
  console.log(`${label.padEnd(42)} Kreuzungen gesamt: ${total}${worst ? `   schlimmster Fall: ${worst.n} bei ${worst.w}x${worst.h} y=${worst.ay} ${worst.count} Fenster` : ''}`);
}
console.log(`(${cases.length} Fälle je Variante)`);
