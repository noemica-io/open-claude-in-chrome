// Humanization planners.
//
// PURE: nothing in this directory touches chrome.*, CDP, or the DOM. Each
// plan*() takes the current state and returns an ordered list of primitive
// steps; extension/background.js has a small executor that dispatches them.
// That split is deliberate — it keeps a few hundred lines of behavioural
// modelling out of the main codebase, and makes all of it testable in Node.
//
// Step kinds the executor understands:
//   { k:"move",  x, y }                          Input.dispatchMouseEvent mouseMoved
//   { k:"down",  x, y, button, clickCount }      ... mousePressed
//   { k:"up",    x, y, button, clickCount }      ... mouseReleased
//   { k:"wheel", x, y, dx, dy }                  ... mouseWheel
//   { k:"kdown", key, code, keyCode, mods, autoRepeat }  Input.dispatchKeyEvent rawKeyDown
//   { k:"kup",   key, code, keyCode, mods }      ... keyUp
//   { k:"text",  text }                          Input.insertText  (the ONLY text source)
//   { k:"sleep", ms }                            delay
//
// THE INVARIANT: randomisation may change WHERE inside a target we land, HOW
// we get there, and WHEN — never WHAT happens. Same element, same text, same
// scroll destination, every time.

import { makeRng, makePersona, randomSeed, clamp } from "./rng.js";
import { planPath, sampleInBox, distance } from "./cursor.js";
import { typematic, keyHoldMs, interKeyMs, keyDescriptor } from "./keyboard.js";

// Re-exported for the NON-humanized type path in background.js, which emits the
// same real key events (matching Claude in Chrome) with flat timing.
export { keyDescriptor as keyDescriptorFor };

export { sampleInBox };

/**
 * Speed tiers — the time affordance for humanization.
 *
 * Realism costs wall-clock, so this is a real tradeoff and the numbers decide
 * it. Measured in-browser (page-recorded event timestamps, so no model or MCP
 * overhead in the span), typing 15 characters:
 *
 *   humanize off  211ms   (~14ms/key — the floor: CDP dispatch itself)
 *   fast         1161ms   (~77ms/key)
 *   natural      2033ms   (~136ms/key — genuine human typing cadence)
 *
 * The ceiling is deliberate: an earlier tier measured ~280ms/key (4.2s for the
 * same 15 characters) and was removed. A tier nobody would willingly pick is
 * not an option, it is a trap — the point of a speed setting is to make
 * humanization affordable. `relaxed` is the slowest tier now, and is tuned to
 * stay under that line while still reading as unhurried.
 *
 *   time   scales every delay (approach, dwell, inter-key, scroll ticks)
 *   points scales how many samples a cursor path is drawn with
 *
 * `fast` is the default, because turning humanization on should not cost a
 * multiple of what it saves. It keeps everything that matters — movement
 * before the click, a landing point inside the target, real key events,
 * identical outcomes — with fewer samples and shorter pauses, never none.
 */
export const TEMPOS = {
  //          time  = cursor/scroll/dwell delays   (cost is per ACTION)
  //          keys  = inter-keystroke delays       (cost is per CHARACTER)
  //          (sample count is DERIVED: duration / device cadence)
  fastest: { time: 0.14, keys: 0.2 },
  fast: { time: 0.38, keys: 0.42 },
  natural: { time: 1, keys: 1 },
  relaxed: { time: 1.5, keys: 1.12 }
};
export const DEFAULT_TEMPO = "fast";

/**
 * One "hand" per session: a seeded rng plus a persona (tempo, steadiness,
 * overshoot propensity). Held by the executor and reused, so a session is
 * internally consistent instead of re-rolling its character every action.
 */
export function createSession(seed, speed = DEFAULT_TEMPO) {
  const rng = makeRng(seed ?? randomSeed());
  const persona = makePersona(rng);
  return { rng, persona, tm: typematic(rng), tempo: TEMPOS[speed] || TEMPOS[DEFAULT_TEMPO] };
}

/** Change the speed tier on a live session without losing its persona. */
export function setSpeed(s, speed) {
  s.tempo = TEMPOS[speed] || TEMPOS[DEFAULT_TEMPO];
  return s;
}

/** Every non-typing delay in a plan goes through here. */
function t(s, ms) {
  return Math.max(1, Math.round(ms * (s.tempo ? s.tempo.time : 1)));
}

/**
 * Inter-keystroke delay, scaled SEPARATELY from the rest.
 *
 * A click pays its tier once; typing pays per character, so the same
 * multiplier that adds 200ms to a click adds seconds to a form field. Measured
 * on a 15-character string, a uniform 1.5x tier produced 4.9s of typing —
 * slower than the ~4.2s tier that was removed for being unusable, arriving by
 * the back door.
 *
 * Slower tiers are also the least defensible place to slow typing down: an
 * unhurried person still types at roughly their own speed, they do not
 * hunt-and-peck. So the slow end is damped hard while the fast end scales
 * freely (a quick typist is perfectly plausible).
 */
function tKey(s, ms) {
  return Math.max(1, Math.round(ms * (s.tempo ? s.tempo.keys : 1)));
}

/** A short pause before acting — the "think time" a human spends orienting. */
export function thinkDelay(s, weight = 1) {
  return t(s, clamp(s.rng.logNormal(190 * weight * s.persona.speed, 1.5), 60, 900));
}

function moveSteps(s, from, to, targetSize) {
  const out = [];
  for (const p of planPath(from, to, s.rng, s.persona, { targetSize, tempo: s.tempo })) {
    // NOT scaled by t(): planPath already applied the tier to the movement's
    // duration, and the per-sample interval must stay at device cadence.
    out.push({ k: "sleep", ms: p.ms }, { k: "move", x: p.x, y: p.y });
  }
  return out;
}

/**
 * Move to a point and click it. `clickCount` > 1 produces that many DISTINCT
 * press/release cycles rather than one flagged event, because that is what a
 * real double/triple click is at the OS level.
 */
export function planClick(s, from, to, opts = {}) {
  const { button = "left", clickCount = 1, targetSize = 24 } = opts;
  const plan = moveSteps(s, from, to, targetSize);
  // A beat between arriving and pressing — nobody clicks the instant they land.
  plan.push({ k: "sleep", ms: t(s, s.rng.delay(75, 1.4, 25, 320)) });
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) {
      // Between clicks of a burst: a real gap, plus the 1-2px drift a hand
      // has while double-clicking.
      plan.push({ k: "sleep", ms: t(s, s.rng.delay(105, 1.25, 60, 190)) });
      if (s.rng.chance(0.55)) {
        plan.push({
          k: "move",
          x: to.x + s.rng.int(-1, 1),
          y: to.y + s.rng.int(-1, 1)
        });
      }
    }
    plan.push({ k: "down", x: to.x, y: to.y, button, clickCount: i });
    // Press-to-release dwell: the physical time the button is held.
    plan.push({ k: "sleep", ms: t(s, s.rng.delay(78, 1.35, 38, 190)) });
    plan.push({ k: "up", x: to.x, y: to.y, button, clickCount: i });
  }
  return plan;
}

/**
 * Move to a point and stop. No tremor while parked: a hover exists to hold a
 * state (tooltip, menu), and jitter near an element edge can cross the
 * boundary, fire mouseleave and dismiss the very thing being hovered. The
 * approach is humanized; the hold is still.
 */
export function planHover(s, from, to, opts = {}) {
  const plan = moveSteps(s, from, to, opts.targetSize || 24);
  plan.push({ k: "sleep", ms: t(s, s.rng.delay(210, 1.4, 90, 700)) });
  return plan;
}

/** Press, travel along a curve, release. */
export function planDrag(s, from, start, end, opts = {}) {
  const plan = moveSteps(s, from, start, opts.targetSize || 24);
  plan.push({ k: "sleep", ms: t(s, s.rng.delay(120, 1.3, 50, 320)) });
  plan.push({ k: "down", x: start.x, y: start.y, button: "left", clickCount: 1 });
  plan.push({ k: "sleep", ms: t(s, s.rng.delay(90, 1.3, 40, 240)) });
  for (const p of planPath(start, end, s.rng, s.persona, { targetSize: opts.targetSize || 24, tempo: s.tempo })) {
    plan.push({ k: "sleep", ms: p.ms }, { k: "move", x: p.x, y: p.y });
  }
  // Settle before letting go — dropping mid-motion is a machine thing to do.
  plan.push({ k: "sleep", ms: t(s, s.rng.delay(130, 1.3, 60, 380)) });
  plan.push({ k: "up", x: end.x, y: end.y, button: "left", clickCount: 1 });
  return plan;
}

// NOTE: the `scroll` ACTION deliberately has no planner here.
//
// Humanizing it was tried twice and abandoned both times, because each attempt
// changed the OUTCOME, which humanization must never do:
//   - splitting the scroll into wheel ticks spread over time let the page move
//     a nested scrollable under the stationary cursor, which then ate the rest
//     (the page moved 89-109px instead of 400px);
//   - Input.synthesizeScrollGesture fixed that but measures in literal pixels
//     while a wheel event's deltaY goes through the browser's own scaling, so
//     the same request travelled 600px humanized against 400px plain.
// A `scroll` asks for a DISTANCE, and nothing re-checks it afterwards, so it
// still issues the identical single wheel event either way and humanizes only
// the cursor's approach.
//
// planWheel below is for a different job — bringing a ref into view — whose
// outcome is a CONDITION (the element is on screen), not a distance. The
// background page checks that condition after every flick and re-plans from
// what actually happened, and it picks a wheel point whose path is clear of
// nested scrollers before it starts, so neither failure above can change where
// things end up: at worst it gives up and falls back to the instant jump.

/**
 * Turn a wheel `notches` times at one point: flicks of a few detents in quick
 * succession with a short pause between flicks, the way a finger rolls a
 * wheel. `dir` is +1 (content moves up, i.e. scroll down) or -1. Every notch
 * is one 100-unit wheel event — the size of a real detent and of one tick of
 * the `scroll` action — at exactly `at`, so the total delta is always
 * notches × 100 and the cursor never drifts onto something else mid-scroll.
 */
export function planWheel(s, at, notches, dir) {
  const plan = [];
  const dy = dir < 0 ? -100 : 100;
  let left = Math.max(0, Math.round(notches));
  while (left > 0) {
    if (plan.length) plan.push({ k: "sleep", ms: t(s, s.rng.delay(170 * s.persona.speed, 1.4, 90, 450)) });
    const flick = Math.min(left, s.rng.int(2, 5));
    for (let i = 0; i < flick; i++) {
      // Within a flick the detents come at the finger's pace. Kept above a
      // floor after tier scaling: a wheel spun flat out still clicks no
      // faster than ~12ms a detent, so the fastest tier must not invent a
      // device that does.
      if (i > 0) plan.push({ k: "sleep", ms: Math.max(12, t(s, s.rng.delay(55, 1.35, 25, 140))) });
      plan.push({ k: "wheel", x: at.x, y: at.y, dx: 0, dy });
    }
    left -= flick;
  }
  return plan;
}

/**
 * Where a person aims when wheeling something into view: the line in the
 * scroller's visible window they want it to land on (`aim`, a fraction of the
 * window's height), and candidate spots to rest the cursor on while wheeling
 * (fractions of the window, biased to its middle). The page decides which
 * spots actually reach the right scroller; this only supplies the intent.
 */
export function wheelAim(s, n = 16) {
  const spots = [];
  for (let i = 0; i < n; i++) {
    spots.push([clamp(s.rng.gauss(0.5, 0.16), 0.12, 0.88), clamp(s.rng.gauss(0.5, 0.18), 0.15, 0.85)]);
  }
  return { aim: s.rng.uniform(0.35, 0.6), spots };
}

/**
 * Type text with real key events AND exactly-once insertion.
 *
 * Per character: rawKeyDown -> insertText -> keyUp. `rawKeyDown` is the
 * non-text-producing variant, so the ONLY thing that inserts is insertText —
 * identical to the non-humanized path. The key events give a page the
 * keydown/keyup signal it would see from an OS keyboard without ever being
 * able to add or drop a character. Hold dwell is sampled below the typematic
 * initial delay, so "no auto-repeat" is faithful rather than anomalous.
 *
 * Characters we cannot map to a real key identity (emoji, CJK, anything off a
 * US layout) fall back to insertText alone — the current behaviour — instead
 * of a fabricated keystroke.
 */
export function planType(s, text) {
  const plan = [];
  let prev = null;
  for (const ch of String(text)) {
    if (prev !== null) plan.push({ k: "sleep", ms: tKey(s, interKeyMs(s.rng, prev, s.persona)) });
    const d = keyDescriptor(ch);
    if (!d) {
      plan.push({ k: "text", text: ch });
      prev = ch;
      continue;
    }
    const mods = d.shift ? 8 : 0;
    plan.push({ k: "kdown", key: ch, code: d.code, keyCode: d.keyCode, mods });
    plan.push({ k: "text", text: ch });
    plan.push({ k: "sleep", ms: Math.min(tKey(s, keyHoldMs(s.rng, s.tm, s.persona)), Math.round(s.tm.initialDelayMs * 0.45)) });
    plan.push({ k: "kup", key: ch, code: d.code, keyCode: d.keyCode, mods });
    prev = ch;
  }
  return plan;
}

/**
 * A single key/chord press with a human hold. `holdMs` opts in to a genuine
 * long hold, in which case the OS typematic sequence is rendered faithfully:
 * initial keydown, the initial delay, then autoRepeat keydowns at the repeat
 * rate. Without it, the hold stays under the threshold and does not repeat.
 */
export function planKey(s, { key, code, keyCode, mods = 0, holdMs = 0 }) {
  const plan = [{ k: "kdown", key, code, keyCode, mods }];
  if (holdMs > s.tm.initialDelayMs) {
    plan.push({ k: "sleep", ms: Math.round(s.tm.initialDelayMs) });
    let elapsed = s.tm.initialDelayMs;
    while (elapsed < holdMs) {
      plan.push({ k: "kdown", key, code, keyCode, mods, autoRepeat: true });
      const step = s.tm.repeatMs * s.rng.uniform(0.85, 1.15);
      plan.push({ k: "sleep", ms: Math.round(step) });
      elapsed += step;
    }
  } else {
    plan.push({ k: "sleep", ms: Math.min(tKey(s, keyHoldMs(s.rng, s.tm, s.persona)), Math.round(s.tm.initialDelayMs * 0.45)) });
  }
  plan.push({ k: "kup", key, code, keyCode, mods });
  return plan;
}

export { distance };
