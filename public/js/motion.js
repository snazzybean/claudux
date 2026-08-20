// public/js/motion.js
//
// The three motion techniques that separate "it moves" from "it was built":
// a spring instead of an ease, a stagger across a set, and FLIP for anything
// that changes position. All three are native - a spring is expressible as
// CSS's own `linear()` easing, and FLIP is two measurements and a transform -
// so none of this needs an animation library. Kept apart from what it
// animates, because none of it knows anything about agents.

// A damped spring, sampled into the easing function CSS understands. An
// ease-out curve arrives and stops; a spring overshoots a little and settles,
// which is what reads as a thing having been thrown rather than moved.
export function springEasing({ stiffness = 180, damping = 16, mass = 1, steps = 22 } = {}) {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const damped = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // Underdamped only: zeta >= 1 has no oscillation and the formula below
    // divides by a damped frequency of zero.
    const value = zeta < 1
      ? 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t))
      : 1 - Math.exp(-omega * t) * (1 + omega * t);
    points.push(Number(value.toFixed(4)));
  }
  // The last sample has to be exactly 1, or the animation ends off its mark.
  points[points.length - 1] = 1;
  return `linear(${points.join(', ')})`;
}

// Per-item delay across a set. Opening several things in the same frame reads
// as one block appearing; a few dozen milliseconds apart reads as a sequence,
// which is most of what makes a set of windows feel handled rather than
// dumped.
export function staggerDelay(index, stepMs = 70, maxMs = 400) {
  return Math.min(index * stepMs, maxMs);
}

export function boxOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

// FLIP: measure where it was, let it be moved, then animate from the
// difference back to nothing. The element is already in its new place the
// whole time, so nothing has to be undone if the animation is interrupted -
// which is the reason to do it this way rather than animating left/top.
export function flipFrom(element, before, { durationMs = 320, easing = springEasing() } = {}) {
  const after = boxOf(element);
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  // Sub-pixel moves are not worth an animation frame.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(before.height - after.height) < 1) return null;
  const scaleY = after.height > 0 ? before.height / after.height : 1;
  return element.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scaleY(${scaleY.toFixed(4)})` },
      { transform: 'none' },
    ],
    { duration: durationMs, easing },
  );
}
