// Do the lines of the shipped layout cross, or run through a window?
//
// `agentLayout.js` touches no DOM, so the routes it produces can be assembled
// in node and measured - which is the only reason two wrong shapes and four
// wrong orderings were caught rather than shipped. Run it after touching
// anything in that module.
//
//     node scripts/probe/crossings.mjs
//
// It samples the curves themselves, through the module's own samplePath: with
// the shape held as cubic segments, measuring the corner points instead would
// pass a bulge straight through a window without noticing.
//
// What keeps the count at zero is the shape, not an ordering: one trunk along
// the gap between the two rows, and a stub that leaves it inside its own
// window's width. Through-windows is the property to watch here - the trunk
// crosses the full width of the screen, so a row placed wrong shows up there
// first.
import { layoutFor, layoutCapacity, routesFor, samplePath } from '../../public/js/agentLayout.js';

const sgn = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
function crosses(a, b) {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      // All four strictly on one side or the other: a transversal crossing.
      // Touching is not crossing, and every route touches the trunk that all
      // of them lie on, plus the swing out of the row that they share.
      const [s1, s2, s3, s4] = [sgn(p, q, r), sgn(p, q, s), sgn(r, s, p), sgn(r, s, q)];
      if (s1 && s2 && s3 && s4 && s1 !== s2 && s3 !== s4) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  }
  return null;
}
const inside = (p, box) => p.x > box.x + 2 && p.x < box.x + box.width - 2
  && p.y > box.y + 2 && p.y < box.y + box.height - 2;

// A crossing check that reports zero is worth nothing unless it can still
// find one, and this one deliberately ignores touching - so it is shown a
// pair that does cross before it is believed. Asymmetric on purpose: with two
// mirror-image curves the intersection lands exactly on a sample point of
// both, where "strictly on one side" cannot hold and a real crossing slips
// through. That is the one blind spot; nothing the layout produces is that
// symmetric.
function selfCheck() {
  const a = { start: { x: 0, y: 3 }, segments: [{ c1: { x: 97, y: 11 }, c2: { x: 103, y: 197 }, to: { x: 200, y: 203 } }] };
  const b = { start: { x: 0, y: 197 }, segments: [{ c1: { x: 111, y: 189 }, c2: { x: 89, y: 7 }, to: { x: 200, y: 11 } }] };
  if (!crosses(samplePath(a, 40), samplePath(b, 40))) {
    console.error('Der Kreuzungspruefer findet eine bekannte Kreuzung nicht - das Ergebnis unten ist wertlos.');
    process.exit(1);
  }
}

// The sharpest bend anywhere along a route, in degrees: 180 is straight, 90 is
// a right angle. This is what "kantig" means as a number - the corners the
// old shape rounded off were capped by half the segment they turned in, and
// came out at barely more than a right angle no matter the radius asked for.
const STEP_PX = 14;
function sharpestBend(points) {
  const at = (i) => points[Math.min(points.length - 1, i)];
  let sharpest = 180;
  let travelled = 0;
  const marks = [0];
  for (let i = 1; i < points.length; i += 1) {
    travelled += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (travelled >= STEP_PX) { marks.push(i); travelled = 0; }
  }
  for (let m = 1; m < marks.length - 1; m += 1) {
    const [before, corner, after] = [at(marks[m - 1]), at(marks[m]), at(marks[m + 1])];
    const u = { x: corner.x - before.x, y: corner.y - before.y };
    const v = { x: after.x - corner.x, y: after.y - corner.y };
    const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    if (lengths === 0) continue;
    const cos = Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y) / lengths));
    sharpest = Math.min(sharpest, 180 - (Math.acos(cos) * 180) / Math.PI);
  }
  return sharpest;
}

selfCheck();

let cases = 0;
let crossings = 0;
let through = 0;
let sharpest = 180;
let sharpestAt = '';
const worst = [];
for (const [w, h] of [[1999, 1491], [1328, 800], [1224, 1731], [1600, 900], [2560, 1440]]) {
  for (const want of [1, 2, 3, 5, 6]) {
    const viewport = { width: w, height: h };
    const count = Math.min(want, layoutCapacity({ x: 320, y: h / 2 }, viewport, 6));
    const boxes = layoutFor(Array.from({ length: count }, (_, i) => `a${i}`), { x: 320, y: h / 2 }, viewport)
      .map((o) => o.box);
    // The row's distance from the trunk is what the shape actually turns on,
    // so the heights are picked relative to the trunk rather than to the
    // screen. Absolute heights alone missed a 142° corner that showed up the
    // first time the real page was measured: it needs the row to sit a little
    // under a hundred pixels from the trunk, and no round number did that.
    const { trunkY } = routesFor(boxes, { x: 320, y: h / 2 }, viewport)[0];
    const heights = new Set([40, h - 40, Math.round(h / 2)]);
    for (const delta of [-160, -86, -60, -24, -6, 0, 6, 24, 60, 86, 160]) {
      heights.add(Math.max(40, Math.min(h - 40, Math.round(trunkY + delta))));
    }
    for (const ay of heights) {
      const anchor = { x: 320, y: ay };
      const routes = routesFor(boxes, anchor, viewport);
      const paths = routes.map((route) => samplePath(route.path, 40));
      cases += 1;
      let bad = 0;
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) if (crosses(paths[i], paths[j])) bad += 1;
      }
      let hit = 0;
      paths.forEach((pts, i) => boxes.forEach((box, j) => { if (i !== j && pts.some((p) => inside(p, box))) hit += 1; }));
      crossings += bad;
      through += hit;
      for (const pts of paths) {
        const bend = sharpestBend(pts);
        if (bend < sharpest) { sharpest = bend; sharpestAt = `${w}x${h} y=${ay} (Trunk ${Math.round(trunkY)}) ${count} Fenster`; }
      }
      if (bad || hit) worst.push(`${w}x${h} Zeile y=${ay} ${count} Fenster → ${bad} Kreuzungen, ${hit} durch fremde Fenster`);
    }
  }
}
console.log(`${cases} Fälle: ${crossings} Kreuzungen, ${through} Durchdringungen`);
console.log(`engste Wendung: ${sharpest.toFixed(1)}° (${sharpestAt}) - 180° ist gerade, 90° ein rechter Winkel`);
for (const line of worst) console.log(`  ${line}`);
