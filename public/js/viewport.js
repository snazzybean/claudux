// How the page holds its ground on a phone: the height it gets when the
// on-screen keyboard is up, the gesture that would otherwise drag the whole
// app out of view, and the measurement overlay that made both debuggable.
//
// Nothing here reads or writes app state - it works on the visual viewport
// and on document-level touch events, which is why it can sit apart from
// app.js at all. The logic is unchanged from where it grew; two plausible
// "fixes" have already made the iOS behaviour worse, so it moves verbatim.

// ---------- Height with the on-screen keyboard open ----------
//
// On the phone the keyboard lays itself OVER the page instead of taking up
// space: `100vh` stays unchanged, and everything at the bottom edge - the
// end of the terminal and the keybar - disappears underneath it.
//
// `window.visualViewport` reports the actually visible area and changes
// when the keyboard shows or hides. The value lands as a CSS variable on
// the root element, which the app's height hangs off of (see .app in
// styles.css). The terminal shrinks along with it, and xterm's fit addon
// recalculates the rows itself via its ResizeObserver.
//
// Without this interface (older browsers) it falls back to the CSS
// fallback of 100dvh - there the adjustment is only as good as the
// browser provides on its own.
// ---------- Offset of the visible area ----------
//
// The height alone leaves the app off the screen: on focus iOS pans the
// visible area down over the layout viewport, which keeps its full height,
// while the app stays anchored at its top. What is left on screen is the few
// pixels the pan happens to spare. `interactive-widget=resizes-content` in
// index.html would take away the reason to pan; iOS Safari ignores it.
//
// A top margin, and three things make it the right one. It does not collapse
// through `body` - `overflow: hidden` there establishes a block formatting
// context, without which it would move nothing at all. It cannot overflow:
// `offsetTop + height` is at most the layout viewport's height by definition,
// so the app never reaches past the bottom edge at any point in the
// keyboard's animation. And not a transform: `.agent-window` is
// `position: fixed` and placed from measured window coordinates, which a
// transformed ancestor would silently reinterpret.
function followVisibleArea() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
  document.documentElement.style.setProperty('--app-offset', `${vv.offsetTop}px`);
}

// ---------- Dragging the app off the screen ----------
//
// With the keyboard open, a finger on the keybar could push the whole app
// out of view: the browser pans the visible area around the layout
// viewport, which keeps its full height. Not document scrolling, so
// `overflow: hidden` doesn't reach it - only the gesture can be refused.
//
// The finger's target is measured at `touchstart` and holds for the whole
// gesture: iOS claims a gesture on the FIRST touchmove, and a
// preventDefault after that is ignored. Per axis, not per element - the
// keybar row scrolls horizontally, and exactly there a vertical drag would
// otherwise still take the app with it. What scrolls is read off the
// computed style rather than a list of class names, which would fall behind
// the next container.
const FREE = { x: true, y: true };

function scrollableAxesAt(target) {
  const axes = { x: false, y: false };
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) axes.y = true;
    if (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth) axes.x = true;
    if (axes.x && axes.y) break;
  }
  return axes;
}

let gestureAxes = FREE;
let gestureOrigin = null;

// ---------- Measurement display for the gap above the keyboard ----------
//
// Diagnostic overlay for the gap that sometimes remains between the keybar
// and the on-screen keyboard: it shows whether `--app-height` lags
// `visualViewport` or whether the browser reports the geometry wrongly.
// Enabled with `?debug=viewport`. A deviation of 0 is not proof on its own
// - a late `resize` may already have corrected the value; the counter and
// the last reported heights are what turn the snapshot into evidence.
const DEBUG_TICK_MS = 250;
const DEBUG_HISTORY_LENGTH = 3;

function showViewportMeasurement() {
  const box = document.createElement('div');
  box.className = 'debug-overlay debug-overlay-top';
  document.body.appendChild(box);
  const keybar = document.getElementById('keybar');

  let resizeCounter = 0;
  let lastResize = Date.now();
  const history = [];
  window.visualViewport?.addEventListener('resize', () => {
    resizeCounter += 1;
    lastResize = Date.now();
    history.push(window.visualViewport.height.toFixed(1));
    if (history.length > DEBUG_HISTORY_LENGTH) history.shift();
  });

  // Peak-hold, because the overlay cannot be read while the fault is
  // happening: an offset visible viewport takes this box off the screen along
  // with the rest of the app. The worst value stays up until the page is
  // reloaded, so it can be read once the keyboard is down again.
  const peak = { offsetTop: 0, scale: 1, height: null, at: null, scrollY: 0, docTop: 0 };

  setInterval(() => {
    const vv = window.visualViewport;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-height');
    const set = raw ? parseFloat(raw) : null;
    const now = vv ? vv.height : null;
    const deviation = now !== null && set !== null ? Math.round(now - set) : null;
    if (vv && (vv.offsetTop > peak.offsetTop || vv.scale > peak.scale)) {
      peak.offsetTop = Math.max(peak.offsetTop, vv.offsetTop);
      peak.scale = Math.max(peak.scale, vv.scale);
      peak.height = vv.height;
      peak.at = document.activeElement?.className || document.activeElement?.tagName || '?';
      peak.scrollY = window.scrollY;
      peak.docTop = document.scrollingElement?.scrollTop ?? -1;
    }
    box.textContent = [
      `vv.height     ${now !== null ? now.toFixed(1) : 'no interface'}`,
      `--app-height  ${set !== null ? set.toFixed(1) : 'never set'}`,
      `deviation     ${deviation === null ? '-' : `${deviation > 0 ? '+' : ''}${deviation} ${deviation === 0 ? '(matches)' : '(stale)'}`}`,
      `resize        ${resizeCounter}x, last ${((Date.now() - lastResize) / 1000).toFixed(1)}s ago`,
      `last reported ${history.join(' → ') || '-'}`,
      `innerHeight   ${window.innerHeight}`,
      // Pan and zoom look the same to the eye - the app slides off the
      // screen either way - and the fix for one is not the fix for the other.
      `vv.offsetTop  ${vv ? vv.offsetTop.toFixed(1) : '-'}`,
      `vv.scale      ${vv ? vv.scale.toFixed(3) : '-'}`,
      `vv.width      ${vv ? vv.width.toFixed(1) : '-'}`,
      `scrollY       ${window.scrollY.toFixed(1)}`,
      `keybar.bottom ${keybar ? keybar.getBoundingClientRect().bottom.toFixed(1) : '-'}`,
      `PEAK offset   ${peak.offsetTop.toFixed(1)}  scale ${peak.scale.toFixed(3)}`,
      `PEAK vv.h     ${peak.height === null ? '-' : peak.height.toFixed(1)}`,
      `PEAK focus    ${peak.at ?? '-'}`,
      `PEAK scrollY  ${peak.scrollY.toFixed(1)}  docTop ${peak.docTop.toFixed(1)}`,
      `app.top       ${document.getElementById('app')?.getBoundingClientRect().top.toFixed(1) ?? '-'}`,
    ].join('\n');
  }, DEBUG_TICK_MS);
}

export function initViewport() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', followVisibleArea);
    // When scrolling with the keyboard open, iOS shifts the visible area
    // without changing its height - the call is then a no-op, but keeps the
    // value correct when both happen together.
    window.visualViewport.addEventListener('scroll', followVisibleArea);
    followVisibleArea();
  }

  document.addEventListener(
    'touchstart',
    (event) => {
      const free =
        event.touches.length > 1 || // pinch zoom stays
        Boolean(event.target.closest?.('input, textarea')); // text cursor and magnifier
      gestureAxes = free ? FREE : scrollableAxesAt(event.target);
      gestureOrigin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (event) => {
      if ((gestureAxes.x && gestureAxes.y) || !gestureOrigin) return;
      const touch = event.touches[0];
      if (!touch) return;
      const horizontal =
        Math.abs(touch.clientX - gestureOrigin.x) > Math.abs(touch.clientY - gestureOrigin.y);
      if (!gestureAxes[horizontal ? 'x' : 'y']) event.preventDefault();
    },
    { passive: false },
  );

  if (new URLSearchParams(location.search).get('debug') === 'viewport') showViewportMeasurement();
}
