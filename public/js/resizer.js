// Draggable edges: the sidebar against the terminal, and the file list against
// the file view. One function for both, because the two differ only in what a
// pixel value is written to - a grid column there, a flex-basis here.
//
// Pointer events rather than mouse events: mouse, trackpad and stylus take the
// same path, and setPointerCapture keeps the drag alive when the pointer leaves
// the 6px handle - without it the edge would stop following at the first fast
// movement.
const STORAGE_PREFIX = 'claudux-width-';

// Below this the panels aren't side by side, so there is no edge to drag.
const WIDE_QUERY = '(min-width: 721px)';

// Same reasoning as in appearance.js: in Safari's private mode localStorage
// throws, and a width that isn't remembered is no reason for the drag itself
// to fail.
function readStored(key) {
  try {
    const value = Number(localStorage.getItem(STORAGE_PREFIX + key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(STORAGE_PREFIX + key);
    else localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(value)));
  } catch {
    // Then the width just doesn't survive a reload.
  }
}

// `measure` gives the width the drag starts from, `limits` the range it may
// end up in - a function, because the upper bound of the file list is a share
// of a panel that changes size itself.
export function makeResizable(handle, { key, apply, measure, limits, fallback }) {
  const stored = readStored(key);
  if (stored !== null) apply(clamp(stored, limits()));

  handle.addEventListener('pointerdown', (event) => {
    if (!window.matchMedia(WIDE_QUERY).matches) return;
    event.preventDefault(); // no text selection while dragging
    const startX = event.clientX;
    const startWidth = measure();
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = 'true';
    // The grid column carries a transition (see .shell in styles.css). Left on,
    // the column would lag behind the pointer for the length of the animation.
    document.documentElement.dataset.resizing = 'true';

    const onMove = (moveEvent) => {
      apply(clamp(startWidth + (moveEvent.clientX - startX), limits()));
    };
    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      delete handle.dataset.dragging;
      delete document.documentElement.dataset.resizing;
      writeStored(key, measure());
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  // A width dragged to something unusable is otherwise only fixable by
  // dragging it back, and on a narrow panel that can be a fiddly few pixels.
  handle.addEventListener('dblclick', () => {
    apply(fallback);
    writeStored(key, null);
  });
}

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max);
}
