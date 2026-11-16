#!/usr/bin/env node
//
// The CDP -> WebDriver BiDi input translation used on Firefox.
//
// Each rule here, if wrong, does not fail loudly: it types a character twice,
// turns a double-click into a triple-click, or leaves Control held so the next
// click opens a link in a new tab. So the rules are pinned with the exact call
// sequences the extension sends (background.js mouseClick, the `type` and
// `key` actions, and humanize plans).
//
// Run: node host/test/cdp-input.test.mjs

import { newInputState, translateInput, translatePlan, keyValue } from "../cdp-input.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ENTER = "\uE007";
const CONTROL = "\uE009";
const SHIFT = "\uE008";

// Run a sequence of CDP calls and flatten what reaches Firefox into one list of
// "source:action" strings, e.g. "key:keyDown:a", "pointer:pointerDown:0".
function run(calls, { state = newInputState() } = {}) {
  const out = [];
  calls.forEach(([method, params]) => {
    for (const step of translateInput(state, method, params)) {
      if (step.kind === "wheel") {
        out.push(`wheel:${step.x},${step.y}:${step.deltaX},${step.deltaY}`);
        continue;
      }
      for (const src of step.actions) {
        for (const a of src.actions) {
          const detail = a.value ?? a.button ?? (a.type === "pointerMove" ? `${a.x},${a.y}` : "");
          out.push(`${src.type}:${a.type}:${detail}`);
        }
      }
    }
  });
  return { out, state };
}
const mouse = (type, x, y, extra = {}) => ["Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra }];
const key = (type, k, modifiers = 0) => ["Input.dispatchKeyEvent", { type, key: k, modifiers }];
const text = (t) => ["Input.insertText", { text: t }];
const count = (out, s) => out.filter((x) => x === s).length;

check("plain click: one move, one press, one release", () => {
  const { out } = run([mouse("mouseMoved", 10, 20), mouse("mousePressed", 10, 20), mouse("mouseReleased", 10, 20)]);
  assert(
    JSON.stringify(out) ===
      JSON.stringify(["pointer:pointerMove:10,20", "pointer:pointerDown:0", "pointer:pointerUp:0"]),
    JSON.stringify(out)
  );
});

check("double_click: all clicks in ONE chain, and the CDP release adds nothing", () => {
  const state = newInputState();
  const press = translateInput(state, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 2 });
  const chains = press.filter((s) => s.kind === "actions");
  assert(chains.length === 1, `press became ${chains.length} chains (Firefox only counts clicks within one)`);
  const kinds = chains[0].actions[0].actions.map((a) => a.type);
  assert(
    JSON.stringify(kinds) === JSON.stringify(["pointerMove", "pointerDown", "pointerUp", "pointerDown", "pointerUp"]),
    JSON.stringify(kinds)
  );
  const release = translateInput(state, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 2 });
  assert(release.length === 0, `release produced ${JSON.stringify(release)}`);
});

check("triple_click becomes three clicks", () => {
  const { out } = run([mouse("mousePressed", 10, 20, { clickCount: 3 }), mouse("mouseReleased", 10, 20, { clickCount: 3 })]);
  assert(count(out, "pointer:pointerDown:0") === 3 && count(out, "pointer:pointerUp:0") === 3, JSON.stringify(out));
});

check("after a multi-click, the next single click still releases", () => {
  const { out } = run([
    mouse("mousePressed", 10, 20, { clickCount: 2 }),
    mouse("mouseReleased", 10, 20, { clickCount: 2 }),
    mouse("mousePressed", 10, 20),
    mouse("mouseReleased", 10, 20),
  ]);
  assert(count(out, "pointer:pointerDown:0") === 3 && count(out, "pointer:pointerUp:0") === 3, JSON.stringify(out));
});

check("ctrl+click holds Control through the click and releases it after", () => {
  const { out, state } = run([
    mouse("mouseMoved", 10, 20, { modifiers: 2 }),
    mouse("mousePressed", 10, 20, { modifiers: 2 }),
    mouse("mouseReleased", 10, 20, { modifiers: 2 }),
  ]);
  assert(out[0] === `key:keyDown:${CONTROL}`, `first: ${out[0]}`);
  assert(count(out, `key:keyDown:${CONTROL}`) === 1, "Control pressed more than once");
  assert(out.at(-1) === `key:keyUp:${CONTROL}`, `last: ${out.at(-1)}`);
  assert(state.mods === 0, "modifier state left set");
});

check("right button maps to button 2", () => {
  const { out } = run([mouse("mousePressed", 1, 1, { button: "right" })]);
  assert(out.includes("pointer:pointerDown:2"), JSON.stringify(out));
});

check("type path: rawKeyDown + insertText + keyUp types the character once", () => {
  const { out } = run([key("rawKeyDown", "a"), text("a"), key("keyUp", "a")]);
  assert(JSON.stringify(out) === JSON.stringify(["key:keyDown:a", "key:keyUp:a"]), JSON.stringify(out));
});

check("type path: shifted character presses Shift once and releases it", () => {
  const { out, state } = run([key("rawKeyDown", "A", 8), text("A"), key("keyUp", "A", 8)]);
  assert(
    JSON.stringify(out) ===
      JSON.stringify([`key:keyDown:${SHIFT}`, "key:keyDown:A", "key:keyUp:A", `key:keyUp:${SHIFT}`]),
    JSON.stringify(out)
  );
  assert(state.mods === 0, "Shift left held");
});

check("insertText on its own (emoji, newline) is typed as key presses", () => {
  const { out } = run([text("😀"), text("\n")]);
  assert(
    JSON.stringify(out) === JSON.stringify(["key:keyDown:😀", "key:keyUp:😀", `key:keyDown:${ENTER}`, `key:keyUp:${ENTER}`]),
    JSON.stringify(out)
  );
});

check("a rawKeyDown's text is only consumed by the insertText right after it", () => {
  // rawKeyDown a, keyUp a, then an unrelated insertText "a" must still type.
  const { out } = run([key("rawKeyDown", "a"), key("keyUp", "a"), text("a")]);
  assert(count(out, "key:keyDown:a") === 2, JSON.stringify(out));
});

check("key action ctrl+a: Control down, a down/up, Control up", () => {
  const { out } = run([key("keyDown", "a", 2), key("keyUp", "a", 2)]);
  assert(
    JSON.stringify(out) ===
      JSON.stringify([`key:keyDown:${CONTROL}`, "key:keyDown:a", "key:keyUp:a", `key:keyUp:${CONTROL}`]),
    JSON.stringify(out)
  );
});

check("named keys map to WebDriver values, case-insensitively; unknown names fail", () => {
  assert(keyValue("Enter") === ENTER && keyValue("enter") === ENTER, "Enter");
  assert(keyValue("Space") === " ", "Space");
  let threw = false;
  try {
    keyValue("capslock");
  } catch {
    threw = true;
  }
  assert(threw, "unknown key name did not throw");
});

check("wheel becomes a wheel step with rounded coordinates", () => {
  const { out } = run([["Input.dispatchMouseEvent", { type: "mouseWheel", x: 10.6, y: 20.2, deltaX: 0, deltaY: 300 }]]);
  assert(JSON.stringify(out) === JSON.stringify(["wheel:11,20:0,300"]), JSON.stringify(out));
});

// --- Humanized plans: one chain, every step its own tick ---

// The chain's ticks as "source:action" strings, skipping zero-length pauses
// (the fillers that keep the other sources idle on someone else's tick).
function ticks(sources) {
  const n = Math.max(...sources.map((s) => s.actions.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    const live = sources
      .map((s) => [s.type, s.actions[i]])
      .filter(([, a]) => a && !(a.type === "pause" && !a.duration));
    assert(live.length <= 1, `tick ${i} runs ${live.length} actions at once`);
    if (!live.length) continue;
    const [type, a] = live[0];
    const detail = a.type === "pointerMove" ? `${a.x},${a.y}` : a.value ?? a.button ?? a.duration ?? "";
    out.push(`${type}:${a.type}:${detail}`);
  }
  return out;
}

check("humanized double-click plan: both clicks in one chain, sleeps as pauses", () => {
  const plan = [
    { k: "move", x: 5, y: 5 },
    { k: "sleep", ms: 40 },
    { k: "move", x: 10, y: 20 },
    { k: "down", x: 10, y: 20, button: "left", clickCount: 1 },
    { k: "sleep", ms: 90 },
    { k: "up", x: 10, y: 20, button: "left", clickCount: 1 },
    { k: "sleep", ms: 120 },
    { k: "down", x: 10, y: 20, button: "left", clickCount: 2 },
    { k: "sleep", ms: 90 },
    { k: "up", x: 10, y: 20, button: "left", clickCount: 2 },
  ];
  const t = ticks(translatePlan(newInputState(), plan));
  assert(
    JSON.stringify(t) ===
      JSON.stringify([
        "pointer:pointerMove:5,5", "pointer:pause:40", "pointer:pointerMove:10,20",
        "pointer:pointerDown:0", "pointer:pause:90", "pointer:pointerUp:0", "pointer:pause:120",
        "pointer:pointerDown:0", "pointer:pause:90", "pointer:pointerUp:0",
      ]),
    JSON.stringify(t)
  );
});

check("humanized typing plan: one keyDown per character, Shift around capitals", () => {
  const plan = [
    { k: "kdown", key: "H", code: "KeyH", mods: 8 }, { k: "text", text: "H" }, { k: "kup", key: "H", code: "KeyH", mods: 8 },
    { k: "sleep", ms: 80 },
    { k: "kdown", key: "i", code: "KeyI", mods: 0 }, { k: "text", text: "i" }, { k: "kup", key: "i", code: "KeyI", mods: 0 },
    { k: "text", text: "😀" },
  ];
  const t = ticks(translatePlan(newInputState(), plan));
  assert(
    JSON.stringify(t) ===
      JSON.stringify([
        `key:keyDown:${SHIFT}`, "key:keyDown:H", "key:keyUp:H", `key:keyUp:${SHIFT}`,
        "pointer:pause:80",
        "key:keyDown:i", "key:keyUp:i",
        "key:keyDown:😀", "key:keyUp:😀",
      ]),
    JSON.stringify(t)
  );
});

check("plan modifiers hold through the plan's click and are released", () => {
  const state = newInputState();
  const t = ticks(
    translatePlan(state, [
      { k: "move", x: 1, y: 1 },
      { k: "down", x: 1, y: 1, button: "left", clickCount: 1 },
      { k: "up", x: 1, y: 1, button: "left", clickCount: 1 },
    ], 2)
  );
  assert(t[0] === `key:keyDown:${CONTROL}` && t.at(-1) === `key:keyUp:${CONTROL}`, JSON.stringify(t));
  assert(state.mods === 0, "Control left held");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
