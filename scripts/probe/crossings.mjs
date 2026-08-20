// Do the lines of the shipped layout cross, or run through a window?
//
// `agentLayout.js` touches no DOM, so the routes it produces can be assembled
// in node and measured - which is the only reason two wrong shapes and four
// wrong orderings were caught rather than shipped. Run it after touching
// anything in that module.
//
//     node scripts/probe/crossings.mjs
//
// The two orderings inside routesFor are what the result hangs on: lines leave
// the session's row at their own height in the order of their lanes, and in
// the corridor the line whose lane is nearest the row takes the outermost
// place. Measured when they were chosen, the three other pairings of those
// same two rules scored 333, 381 and 502 crossings against this one's zero.
import { layoutFor, layoutCapacity, routesFor } from '../../public/js/agentLayout.js';

const seg = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
// Sampling the straight waypoints is enough: rounding a corner moves the line
// by at most the radius and never past a neighbour's lane.
function samples(points) {
  const pts = [];
  for (let i = 1; i < points.length; i += 1) {
    for (let t = 0; t < 1; t += 0.01) pts.push(seg(points[i - 1], points[i], t));
  }
  pts.push(points[points.length - 1]);
  return pts;
}
const sgn = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
function crosses(a, b) {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      // Parallel segments cannot cross, they can only lie on each other.
      if (Math.abs((q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x)) < 1e-9) continue;
      if (sgn(p, q, r) !== sgn(p, q, s) && sgn(r, s, p) !== sgn(r, s, q)) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  }
  return null;
}
const inside = (p, box) => p.x > box.x + 2 && p.x < box.x + box.width - 2
  && p.y > box.y + 2 && p.y < box.y + box.height - 2;

let cases = 0;
let crossings = 0;
let through = 0;
const worst = [];
for (const [w, h] of [[1999, 1491], [1328, 800], [1224, 1731], [1600, 900], [2560, 1440]]) {
  for (const ay of [60, 200, 500, 900, h - 60]) {
    for (const want of [1, 2, 3, 5, 6]) {
      const viewport = { width: w, height: h };
      const anchor = { x: 320, y: Math.max(40, Math.min(h - 40, ay)) };
      const count = Math.min(want, layoutCapacity(anchor, viewport, 6));
      const boxes = layoutFor(Array.from({ length: count }, (_, i) => `a${i}`), anchor, viewport).map((o) => o.box);
      const routes = routesFor(boxes, anchor);
      const paths = routes.map((route) => samples(route.points));
      cases += 1;
      let bad = 0;
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) if (crosses(paths[i], paths[j])) bad += 1;
      }
      let hit = 0;
      paths.forEach((pts, i) => boxes.forEach((box, j) => { if (i !== j && pts.some((p) => inside(p, box))) hit += 1; }));
      crossings += bad;
      through += hit;
      if (bad || hit) worst.push(`${w}x${h} Zeile y=${anchor.y} ${count} Fenster → ${bad} Kreuzungen, ${hit} durch fremde Fenster`);
    }
  }
}
console.log(`${cases} Fälle: ${crossings} Kreuzungen, ${through} Durchdringungen`);
for (const line of worst) console.log(`  ${line}`);
