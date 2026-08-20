// Opens the real page against the fixture, clicks the glowing edge, and
// reports what is actually on screen: how many windows and lines, whether any
// line crosses another or runs through a window, whether a pulse appears AND
// moves in both directions, whether dragging takes a line along, and whether
// every window can be closed. See README.md for why this exists.
import fs from 'node:fs';
import { chromium } from '/root/.npm/_npx/705bc6b22212b352/node_modules/playwright/index.mjs';

const [, , PORT = '4098', OUT = '/tmp/probe', SIZE = '1999x1491', PROJECT = 'roommind', TRANSCRIPT = ''] = process.argv;
const [W, H] = SIZE.split('x').map(Number);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const problems = [];
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });

await page.goto(`http://127.0.0.1:${PORT}/?debug=subagents`, { waitUntil: 'networkidle' });
// Session rows exist only for an expanded project - a collapsed one clips
// them away and app.js does not build them.
await page.waitForSelector('.project-head', { timeout: 20000 });
await page.locator('.project-head', { hasText: PROJECT }).first().click();
await page.waitForSelector('.session-agents-edge:not([hidden])', { timeout: 20000 });
const count = (await page.locator('.session-agents-edge:not([hidden])').first().textContent()).trim();

await page.locator('.session-agents-edge:not([hidden])').first().click();
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}-open.png` });

const seen = await page.evaluate(() => {
  const sample = (p) => {
    const n = 140; const pts = [];
    for (let i = 0; i <= n; i += 1) { const q = p.getPointAtLength((p.getTotalLength() * i) / n); pts.push({ x: q.x, y: q.y }); }
    return pts;
  };
  const paths = [...document.querySelectorAll('.agent-line')];
  const boxes = [...document.querySelectorAll('.agent-window')].map((el) => {
    const r = el.getBoundingClientRect();
    return { title: el.querySelector('.agent-window-title').textContent, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const sampled = paths.map(sample);
  // Which side of ab does c lie on - as a distance in pixels, with anything
  // under half of one counted as "on the line". Sampling the same trunk from
  // two paths of different lengths lands on different points along it, and
  // their cross products come out at 1e-6 rather than 0, which a bare
  // Math.sign reads as opposite sides. That alone reported ten crossings in
  // a picture that has none.
  const sgn = (a, b, c) => {
    const span = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const gap = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / span;
    return Math.abs(gap) < 0.5 ? 0 : Math.sign(gap);
  };
  let crossings = 0;
  const where = [];
  for (let i = 0; i < sampled.length; i += 1) {
    for (let j = i + 1; j < sampled.length; j += 1) {
      for (let a = 1; a < sampled[i].length; a += 1) {
        for (let b = 1; b < sampled[j].length; b += 1) {
          const [p, q, r, s] = [sampled[i][a - 1], sampled[i][a], sampled[j][b - 1], sampled[j][b]];
          // Strictly on one side, all four: every line shares the climb and
          // the trunk with every other one, and touching is not crossing.
          const [s1, s2, s3, s4] = [sgn(p, q, r), sgn(p, q, s), sgn(r, s, p), sgn(r, s, q)];
          if (s1 && s2 && s3 && s4 && s1 !== s2 && s3 !== s4) {
            crossings += 1;
            where.push(`${i}x${j} bei (${Math.round(p.x)},${Math.round(p.y)})`);
            a = 1e9; b = 1e9;
          }
        }
      }
    }
  }
  // The sharpest bend along a line, in degrees, measured over roughly 14px of
  // its length: 180 is straight, 90 a right angle. Read off the drawn svg
  // rather than the model, because "kantig" is a property of what is on
  // screen.
  const sharpestBend = (pts, len) => {
    const step = Math.max(1, Math.round(14 / (len / (pts.length - 1))));
    let sharpest = 180;
    for (let i = step; i + step < pts.length; i += step) {
      const u = { x: pts[i].x - pts[i - step].x, y: pts[i].y - pts[i - step].y };
      const v = { x: pts[i + step].x - pts[i].x, y: pts[i + step].y - pts[i].y };
      const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
      if (!lengths) continue;
      const cos = Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y) / lengths));
      sharpest = Math.min(sharpest, 180 - (Math.acos(cos) * 180) / Math.PI);
    }
    return sharpest;
  };
  const inside = (p, b) => p.x > b.x + 2 && p.x < b.x + b.w - 2 && p.y > b.y + 2 && p.y < b.y + b.h - 2;
  let through = 0;
  sampled.forEach((pts) => boxes.forEach((b) => { if (pts.some((p) => inside(p, b))) through += 1; }));
  return {
    boxes,
    anchor: paths.length
      ? [Math.round(paths[0].getPointAtLength(0).x), Math.round(paths[0].getPointAtLength(0).y)]
      : null,
    lines: paths.map((p, i) => ({
      len: Math.round(p.getTotalLength()),
      bend: Math.round(sharpestBend(sampled[i], p.getTotalLength())),
    })),
    crossings,
    where,
    through,
  };
});

console.log(`Zähler am Rand: ${count}`);
console.log(`Fenster: ${seen.boxes.length}, Anker der Linien bei (${seen.anchor})`);
for (const b of seen.boxes) console.log(`   ${b.title.padEnd(32)} ${b.w}x${b.h} bei (${b.x},${b.y})`);
console.log(`Linien: ${seen.lines.length}, Längen ${seen.lines.map((l) => l.len).join('/')}`);
console.log(`engste Wendung je Linie: ${seen.lines.map((l) => `${l.bend}°`).join('/')} (180° ist gerade)`);
console.log(`Kreuzungen: ${seen.crossings}   durch fremde Fenster: ${seen.through}`);
for (const spot of seen.where) console.log(`   kreuzt ${spot}`);

// A pulse needs a real message: append one to the session transcript and wait
// for the watcher's next pass to report it.
if (TRANSCRIPT) {
  const name = seen.boxes[0].title.split(' · ')[0];
  fs.appendFileSync(TRANSCRIPT, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: name, message: 'Zwischenstand?' } }] },
  })}\n`);
  const moved = await page.evaluate(async () => {
    const seenAt = [];
    for (let i = 0; i < 60; i += 1) {
      const dot = document.querySelector('.agent-pulse');
      if (dot) {
        const r = dot.getBoundingClientRect();
        seenAt.push([Math.round(r.x), Math.round(r.y)]);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return seenAt;
  });
  const distinct = new Set(moved.map((p) => p.join(','))).size;
  console.log(`Impuls: ${moved.length} Messungen an ${distinct} verschiedenen Stellen`);
  if (moved.length) console.log(`   von (${moved[0]}) nach (${moved[moved.length - 1]})`);
  await page.screenshot({ path: `${OUT}-pulse.png` });
}

// The other direction: the agent's own transcript gains a SendMessage call,
// which is how an agent writes back. Expect a red pulse running the same path
// backwards.
if (TRANSCRIPT) {
  const dir = TRANSCRIPT.replace(/\.jsonl$/, '/subagents');
  const own = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0];
  fs.appendFileSync(`${dir}/${own}`, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: 'fertig' } }] },
  })}\n`);
  const back = await page.evaluate(async () => {
    const at = [];
    for (let i = 0; i < 60; i += 1) {
      const dot = document.querySelector('.agent-pulse-toLead');
      if (dot) { const r = dot.getBoundingClientRect(); at.push([Math.round(r.x), Math.round(r.y)]); }
      await new Promise((r) => setTimeout(r, 100));
    }
    return at;
  });
  console.log(`Gegenimpuls (rot): ${back.length} Messungen an ${new Set(back.map((p) => p.join(','))).size} Stellen`);
  if (back.length) console.log(`   von (${back[0]}) nach (${back[back.length - 1]})`);
}

// Dragging: the line has to follow, and a window pulled across the row has to
// be met on its other edge.
{
  const bar = page.locator('.agent-window-bar').first();
  const before = await page.evaluate(() => {
    const p = document.querySelector('.agent-line');
    const q = p.getPointAtLength(p.getTotalLength());
    return [Math.round(q.x), Math.round(q.y)];
  });
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 460, box.y - 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const win = document.querySelector('.agent-window').getBoundingClientRect();
    const ends = [...document.querySelectorAll('.agent-line')].map((p) => {
      const q = p.getPointAtLength(p.getTotalLength());
      return [Math.round(q.x), Math.round(q.y)];
    });
    return { win: [Math.round(win.x), Math.round(win.y), Math.round(win.width), Math.round(win.height)], ends };
  });
  // On an edge, wherever along it: the entry point is a fraction of the
  // window's own width and slides with it, so a test that expects it a fixed
  // distance from a corner tests last month's layout.
  const [wx, wy, ww, wh] = after.win;
  const onEdge = after.ends.some(([x, y]) => {
    const alongX = x >= wx - 3 && x <= wx + ww + 3;
    const alongY = y >= wy - 3 && y <= wy + wh + 3;
    return (alongX && (Math.abs(y - wy) < 3 || Math.abs(y - (wy + wh)) < 3))
      || (alongY && (Math.abs(x - wx) < 3 || Math.abs(x - (wx + ww)) < 3));
  });
  console.log(`Ziehen: Ende vorher (${before}), Fenster jetzt bei (${after.win[0]},${after.win[1]}), Linie sitzt an einer Kante: ${onEdge ? 'ja' : 'NEIN'}`);
  await page.screenshot({ path: `${OUT}-dragged.png` });
}

// Close them the way a person would: bring the window forward, then hit its
// button.
// The LAST window in the DOM is the topmost one - raising moves a window to
// the end - so that is the only one whose button is guaranteed uncovered.
// Close them the way a person would: bring one forward, then hit its button.
// A closing window stays in the DOM until its animation ends, so each step
// waits for the count to actually drop rather than for a fixed time.
const failed = [];
for (let guard = 0; guard < 20; guard += 1) {
  const before = await page.locator('.agent-window').count();
  if (before === 0) break;
  const title = await page.evaluate(() => {
    // The topmost window by z-index, raised so its own button is uncovered.
    const wins = [...document.querySelectorAll('.agent-window')];
    const top = wins.sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0)).at(-1);
    top.dataset.probeTarget = '1';
    return top.querySelector('.agent-window-title').textContent;
  });
  await page.locator('.agent-window[data-probe-target] .agent-window-bar').click({ position: { x: 8, y: 8 } });
  await page.locator('.agent-window[data-probe-target] .agent-window-close').click();
  try {
    await page.waitForFunction((n) => document.querySelectorAll('.agent-window').length < n, before, { timeout: 4000 });
  } catch {
    failed.push(title);
    const why = await page.evaluate(() => {
      const win = document.querySelector('.agent-window[data-probe-target]');
      if (!win) return 'Fenster ist weg, Zähler aber nicht gefallen';
      const btn = win.querySelector('.agent-window-close');
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        knopf: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        daLiegt: at ? `${at.tagName}.${at.className}` : 'nichts',
        fensterZahl: document.querySelectorAll('.agent-window').length,
        animationen: win.getAnimations().map((a) => `${a.playState}`),
      };
    });
    console.log(`   Grund: ${JSON.stringify(why)}`);
    await page.evaluate(() => document.querySelector('.agent-window[data-probe-target]')?.removeAttribute('data-probe-target'));
  }
}
if (failed.length) console.log(`SCHLIESSEN FEHLGESCHLAGEN: ${failed.join(', ')}`);
await page.waitForTimeout(1400);
const after = await page.evaluate(() => ({
  windows: document.querySelectorAll('.agent-window').length,
  lines: document.querySelectorAll('.agent-line').length,
  pulses: document.querySelectorAll('.agent-pulse').length,
}));
await page.screenshot({ path: `${OUT}-closed.png` });
console.log(`nach dem Schließen → Fenster ${after.windows}, Linien ${after.lines}, Impulse ${after.pulses}`);
if (problems.length) console.log('MELDUNGEN:\n  ' + problems.join('\n  '));
await browser.close();
