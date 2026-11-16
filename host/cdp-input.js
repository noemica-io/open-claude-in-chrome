// CDP Input.* -> WebDriver BiDi input.performActions.
//
// The two protocols model input differently, and the differences are what this
// file exists to absorb:
//
//  - Modifiers. CDP stamps a bitmask on every event; BiDi has real modifier
//    keys that stay pressed until released. We press/release them to match the
//    bitmask, and release them after the event that ends a gesture (mouse
//    release, key up, wheel) so none is left held.
//
//  - Click count. CDP says "this press is click N"; BiDi has no such field.
//    Firefox counts clicks itself, but only within ONE input.performActions
//    call: it resets the count for every new action chain, deliberately ("We
//    shouldn't be able to simulate a double click with multiple action
//    chains", remote/shared/webdriver/Actions.sys.mjs). So a press with
//    clickCount N is sent as all N clicks in a single chain, final release
//    included, and the CDP release that follows has nothing left to do.
//    Humanized plans, which send their clicks as separate presses with pauses
//    between, go through translatePlan as one chain for the same reason.
//
//  - Text. In CDP, rawKeyDown produces no text and insertText supplies it. In
//    BiDi a keyDown inserts its character, so insertText right after a
//    rawKeyDown for the same character is dropped (it would type it twice).
//    insertText on its own (emoji, CJK, newline) is typed as key presses.
//
// Everything here is pure: it takes per-tab state and a CDP call and returns
// the BiDi steps to run, so it can be tested without a browser.

// WebDriver key values for named keys (https://w3c.github.io/webdriver/#keyboard-actions).
const NAMED_KEYS = {
  Cancel: "\uE001", Help: "\uE002", Backspace: "\uE003", Tab: "\uE004", Clear: "\uE005",
  Enter: "\uE007", Shift: "\uE008", Control: "\uE009", Alt: "\uE00A", Pause: "\uE00B",
  Escape: "\uE00C", Space: " ", PageUp: "\uE00E", PageDown: "\uE00F", End: "\uE010",
  Home: "\uE011", ArrowLeft: "\uE012", ArrowUp: "\uE013", ArrowRight: "\uE014",
  ArrowDown: "\uE015", Insert: "\uE016", Delete: "\uE017", Meta: "\uE03D",
  F1: "\uE031", F2: "\uE032", F3: "\uE033", F4: "\uE034", F5: "\uE035", F6: "\uE036",
  F7: "\uE037", F8: "\uE038", F9: "\uE039", F10: "\uE03A", F11: "\uE03B", F12: "\uE03C",
};
const NAMED_KEYS_CI = new Map(Object.entries(NAMED_KEYS).map(([k, v]) => [k.toLowerCase(), v]));

// CDP modifier bits -> the key that produces them.
const MODIFIERS = [
  [1, NAMED_KEYS.Alt],
  [2, NAMED_KEYS.Control],
  [4, NAMED_KEYS.Meta],
  [8, NAMED_KEYS.Shift],
];
const MODIFIER_VALUES = new Set(MODIFIERS.map(([, v]) => v));

const BUTTONS = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };

const segmenter = new Intl.Segmenter();
const graphemes = (s) => Array.from(segmenter.segment(s), (g) => g.segment);

export function newInputState() {
  return {
    mods: 0, // modifier bits currently held
    pos: null, // last pointer position {x, y}
    released: null, // button a multi-click already released
    typed: null, // character a rawKeyDown already inserted
  };
}

// A CDP `key` -> a BiDi key value.
export function keyValue(key) {
  if (typeof key !== "string" || key === "") throw new Error("key event without a key");
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (graphemes(key).length === 1) return key;
  const named = NAMED_KEYS_CI.get(key.toLowerCase());
  if (named) return named;
  throw new Error(`Key "${key}" is not supported on Firefox`);
}

// Key actions that take the held modifiers from state.mods to `want`. The key
// being pressed is skipped, so "Shift" with the Shift bit set is not pressed twice.
function modifierActions(state, want, except) {
  const actions = [];
  for (const [bit, value] of MODIFIERS) {
    if (value === except) continue;
    const held = (state.mods & bit) !== 0;
    const wanted = (want & bit) !== 0;
    if (wanted && !held) actions.push({ type: "keyDown", value });
    if (!wanted && held) actions.push({ type: "keyUp", value });
  }
  state.mods = want;
  return actions;
}

const keys = (actions) => ({ type: "key", id: "ocic-keyboard", actions });
const pointer = (actions) => ({
  type: "pointer",
  id: "ocic-mouse",
  parameters: { pointerType: "mouse" },
  actions,
});

// Steps are run in order, each as its own input.performActions (Firefox keeps
// held keys and buttons between calls), except `wheel`, which the bridge runs
// itself because of the hidden-tab scroll fallback.
function act(source) {
  return { kind: "actions", actions: [source] };
}

function moveIfNeeded(state, x, y, out) {
  if (state.pos && state.pos.x === x && state.pos.y === y) return;
  out.push({ type: "pointerMove", x, y, duration: 0 });
  state.pos = { x, y };
}

function translateMouse(state, p) {
  const steps = [];
  const mods = modifierActions(state, p.modifiers || 0);
  if (mods.length) steps.push(act(keys(mods)));
  const x = Math.round(p.x);
  const y = Math.round(p.y);

  if (p.type === "mouseWheel") {
    steps.push({ kind: "wheel", x, y, deltaX: p.deltaX || 0, deltaY: p.deltaY || 0 });
  } else {
    const moves = [];
    moveIfNeeded(state, x, y, moves);
    const button = BUTTONS[p.button] ?? 0;
    if (p.type === "mousePressed") {
      const count = Math.max(1, p.clickCount || 1);
      if (count === 1) {
        moves.push({ type: "pointerDown", button });
        state.released = null;
      } else {
        for (let i = 0; i < count; i++) {
          moves.push({ type: "pointerDown", button }, { type: "pointerUp", button });
        }
        state.released = button;
      }
    } else if (p.type === "mouseReleased") {
      if (state.released !== button) moves.push({ type: "pointerUp", button });
      state.released = null;
    } else if (p.type !== "mouseMoved") {
      throw new Error(`Mouse event type "${p.type}" is not supported on Firefox`);
    }
    if (moves.length) steps.push(act(pointer(moves)));
  }

  // These end a gesture; nothing should stay held after them.
  if (p.type === "mouseReleased" || p.type === "mouseWheel") {
    const release = modifierActions(state, 0);
    if (release.length) steps.push(act(keys(release)));
  }
  return steps;
}

function translateKey(state, p) {
  const steps = [];
  if (p.type === "char") return steps; // text arrives via insertText
  const value = keyValue(p.key);
  const mods = modifierActions(state, p.modifiers || 0, value);
  if (mods.length) steps.push(act(keys(mods)));

  if (p.type === "keyDown" || p.type === "rawKeyDown") {
    steps.push(act(keys([{ type: "keyDown", value }])));
    state.typed = p.type === "rawKeyDown" && !MODIFIER_VALUES.has(value) ? p.key : null;
  } else if (p.type === "keyUp") {
    state.typed = null;
    steps.push(act(keys([{ type: "keyUp", value }])));
    const release = modifierActions(state, 0, value);
    if (release.length) steps.push(act(keys(release)));
  } else {
    throw new Error(`Key event type "${p.type}" is not supported on Firefox`);
  }
  return steps;
}

function translateInsertText(state, p) {
  const text = String(p.text ?? "");
  const already = state.typed;
  state.typed = null;
  if (text === "" || text === already) return [];
  const actions = [];
  for (const g of graphemes(text)) {
    const value = g === "\n" || g === "\r" || g === "\r\n" ? NAMED_KEYS.Enter : g === "\t" ? NAMED_KEYS.Tab : g;
    actions.push({ type: "keyDown", value }, { type: "keyUp", value });
  }
  return [act(keys(actions))];
}

/**
 * @param {ReturnType<typeof newInputState>} state  per-tab, mutated
 * @param {string} method  CDP method
 * @param {object} params  CDP params
 * @returns {Array<{kind:"actions", actions:object[]} | {kind:"wheel", x, y, deltaX, deltaY}>}
 */
export function translateInput(state, method, params) {
  // A rawKeyDown's text is consumed only by the insertText directly after it.
  if (method !== "Input.insertText" && method !== "Input.dispatchKeyEvent") state.typed = null;
  switch (method) {
    case "Input.dispatchMouseEvent":
      return translateMouse(state, params);
    case "Input.dispatchKeyEvent":
      return translateKey(state, params);
    case "Input.insertText":
      return translateInsertText(state, params);
    default:
      throw new Error(`${method} is not supported on Firefox`);
  }
}

// --- Humanized plans ---
// A humanize plan (extension/humanize/index.js) is the whole gesture: moves,
// presses, key events and the sleeps between them. On Firefox it runs as ONE
// action chain, sleeps becoming pause actions, so Firefox counts the plan's
// clicks (see the click-count note above) and the timing happens inside the
// browser rather than across IPC round trips.
//
// Within a chain, each tick runs one action from every source at once, so to
// keep the plan's order every step gets a tick of its own and the other
// sources pause (duration 0) for it.

function planStepCalls(step, modifiers) {
  const at = { x: step.x, y: step.y, modifiers };
  switch (step.k) {
    case "move":
      return [["Input.dispatchMouseEvent", { type: "mouseMoved", ...at }]];
    case "down": // clickCount is Firefox's to count within the chain
      return [["Input.dispatchMouseEvent", { type: "mousePressed", button: step.button, clickCount: 1, ...at }]];
    case "up":
      return [["Input.dispatchMouseEvent", { type: "mouseReleased", button: step.button, clickCount: 1, ...at }]];
    case "wheel":
      return [["Input.dispatchMouseEvent", { type: "mouseWheel", deltaX: step.dx, deltaY: step.dy, ...at }]];
    case "kdown":
      return [["Input.dispatchKeyEvent", { type: "rawKeyDown", key: step.key, modifiers: step.mods || 0 }]];
    case "kup":
      return [["Input.dispatchKeyEvent", { type: "keyUp", key: step.key, modifiers: step.mods || 0 }]];
    case "text":
      return [["Input.insertText", { text: step.text }]];
    default:
      throw new Error(`Unknown plan step "${step.k}"`);
  }
}

/**
 * @returns {object[]} the `actions` (input sources) for one input.performActions
 */
export function translatePlan(state, plan, modifiers = 0) {
  const ticks = []; // [{ source: "pointer"|"key"|"wheel", action }]
  for (const step of plan) {
    if (step.k === "sleep") {
      ticks.push({ source: "pointer", action: { type: "pause", duration: Math.max(0, Math.round(step.ms)) } });
      continue;
    }
    for (const [method, params] of planStepCalls(step, modifiers)) {
      for (const out of translateInput(state, method, params)) {
        if (out.kind === "wheel") {
          const { x, y, deltaX, deltaY } = out;
          ticks.push({ source: "wheel", action: { type: "scroll", x, y, deltaX, deltaY, duration: 0 } });
          continue;
        }
        for (const src of out.actions) {
          for (const action of src.actions) ticks.push({ source: src.type, action });
        }
      }
    }
  }
  const make = {
    pointer: (a) => pointer(a),
    key: (a) => keys(a),
    wheel: (a) => ({ type: "wheel", id: "ocic-wheel", actions: a }),
  };
  const used = [...new Set(ticks.map((t) => t.source))];
  return used.map((source) =>
    make[source](ticks.map((t) => (t.source === source ? t.action : { type: "pause", duration: 0 })))
  );
}

// --- Hidden-tab scrolling ---
// Firefox delivers a synthesized wheel event to a tab that is not visible but
// skips the scroll that would normally follow (verified: the page sees a
// trusted wheel with deltaY 300, scrollY stays 0; the same tab, selected,
// scrolls exactly 300). So in a hidden tab we watch the event and, unless the
// page cancelled it, perform the scroll the browser skipped. Both scripts run
// in a sandbox so nothing is added to the page's own globals.

export const WHEEL_WATCH = `(() => {
  if (document.visibilityState === "visible") return "visible";
  globalThis.__ocicWheel = null;
  addEventListener("wheel", (e) => { globalThis.__ocicWheel = e; }, { capture: true, once: true, passive: true });
  return "hidden";
})()`;

export function wheelFollowUp(x, y, dx, dy) {
  return `((x, y, dx, dy) => {
  const e = globalThis.__ocicWheel;
  globalThis.__ocicWheel = null;
  if (!e) return "no wheel event";
  if (e.defaultPrevented) return "cancelled by page";
  const can = (n) => {
    const s = getComputedStyle(n);
    const y = dy && /(auto|scroll|overlay)/.test(s.overflowY) &&
      (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0);
    const x = dx && /(auto|scroll|overlay)/.test(s.overflowX) &&
      (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0);
    return y || x;
  };
  let n = document.elementFromPoint(x, y);
  for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (can(n)) { n.scrollBy({ left: dx, top: dy, behavior: "instant" }); return "scrolled element"; }
  }
  (document.scrollingElement || document.documentElement).scrollBy({ left: dx, top: dy, behavior: "instant" });
  return "scrolled document";
})(${x}, ${y}, ${dx}, ${dy})`;
}
