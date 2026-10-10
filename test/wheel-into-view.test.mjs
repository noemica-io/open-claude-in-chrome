// Wheeling an off-screen ref into view (humanize on), run through the SHIPPED
// wheelRefIntoView / settleRef / dispatchPlan and the SHIPPED computer handler,
// against a simulated page. The page side (refWheelPlan in content.js) needs a
// real layout engine, so it is reduced here to one root scroller with the same
// message contract; what is under test is the loop around it — rounds, notch
// calibration, giving up, and the handler's fallback to the instant jump.
import fs from "node:fs";
import * as humanize from "../extension/humanize/index.js";
import { extractFunction, extractMethod, compile, BACKGROUND } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const bg = fs.readFileSync(BACKGROUND, "utf8");
const constant = (name) => Number(bg.match(new RegExp(`const ${name} = (\\d+);`))[1]);
const WHEEL_MAX_ROUNDS = constant("WHEEL_MAX_ROUNDS");
const WHEEL_MAX_NOTCHES = constant("WHEEL_MAX_NOTCHES");

// --- the simulated page ------------------------------------------------------
let page;
const msgs = [], wheels = [], moves = [], logs = [];
const cursorByTab = new Map();
function load(o = {}) {
  page = { vw: 1200, vh: 754, docH: 6000, scrollY: 0, elTop: 300, elH: 30, elX: 600, px: 100, ...o };
  msgs.length = wheels.length = moves.length = logs.length = 0;
  cursorByTab.clear();
  if (o.cursor) cursorByTab.set(1, o.cursor);
}
const elCentre = () => [page.elX, Math.round(page.elTop - page.scrollY + page.elH / 2)];

// refWheelPlan's contract, for a page whose only scroller is the root.
function refWheelPlan(msg) {
  const top = page.elTop - page.scrollY, bottom = top + page.elH, centre = elCentre();
  if (page.why) return { inView: false, centre, point: null, why: page.why };
  if (top >= 0 && bottom <= page.vh) return { inView: true, centre };
  const want = (top + bottom) / 2 - msg.aim * page.vh;
  const dir = want > 0 ? 1 : -1;
  const room = dir > 0 ? page.docH - page.vh - page.scrollY : page.scrollY;
  const needed = Math.round(Math.min(Math.abs(want), room) / msg.perNotch);
  const point = msg.cursor || { x: Math.round(msg.spots[0][0] * page.vw), y: Math.round(msg.spots[0][1] * page.vh) };
  const notches = page.clear ? Math.max(1, Math.min(needed, Math.floor(page.clear / msg.perNotch))) : needed;
  return { inView: false, centre, dir, needed, notches, point, scroller: "page" };
}

const deps = {
  humanize,
  cursorByTab,
  WHEEL_MAX_ROUNDS,
  WHEEL_MAX_NOTCHES,
  effectiveConfig: () => ({ humanize: true, humanize_speed: "fast", humanize_seed: 7 }),
  human: (speed, seed) => humanize.createSession(seed, speed),
  sleep: async () => {},
  ensureAttached: async () => {},
  dbg: (kind, detail) => logs.push(detail),
  cdp: async () => {},
  dispatchMouse: async (tabId, type, x, y) => moves.push({ type, x, y }),
  sendMouseEvent: async (tabId, p) => {
    if (p.type !== "mouseWheel") return;
    wheels.push({ x: p.x, y: p.y, dy: p.deltaY, round: msgs.length });
    if (!page.stuck) {
      page.scrollY = Math.min(page.docH - page.vh, Math.max(0, page.scrollY + (p.deltaY / 100) * page.px));
    }
  },
  sendContentMessage: async (tabId, msg) => {
    if (page.throws) throw new Error("Could not establish connection");
    msgs.push(msg);
    return { result: refWheelPlan(msg) };
  },
  resolveRefToCoordinates: async () => {
    const [x, y] = elCentre();
    return { x, y, reachable: y >= 0 && y < page.vh };
  }
};
const { wheelRefIntoView } = compile(
  [extractFunction("dispatchPlan"), extractFunction("settleRef"), extractFunction("wheelRefIntoView")].join("\n\n"),
  deps,
  "{ wheelRefIntoView }"
);
const onScreen = () => { const t = page.elTop - page.scrollY; return t >= 0 && t + page.elH <= page.vh; };

console.log("== already on screen: nothing moves ==");
{ load({ elTop: 300 });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(r.ok && r.notches === 0, `ok with 0 notches (${JSON.stringify(r)})`);
  ok(wheels.length === 0 && moves.length === 0, "no wheel events, no cursor movement"); }

console.log("== 3000px below the fold ==");
{ load({ elTop: 3375 });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(r.ok && onScreen(), `in view after ${r.notches} notches in ${r.rounds} round(s)`);
  ok(wheels.length === r.notches && wheels.every((w) => w.dy === 100), "every notch is one +100 wheel event");
  ok(page.scrollY === wheels.length * 100, `page travelled exactly notches x 100 (${page.scrollY}px)`);
  ok(moves.length > 0, `with no known cursor, it moved there first (${moves.length} mouseMoved)`);
  const byRound = new Map();
  for (const w of wheels) byRound.set(w.round, [...(byRound.get(w.round) || []), `${w.x},${w.y}`]);
  ok([...byRound.values()].every((pts) => new Set(pts).size === 1), "within a round every notch is at one point");
  ok(r.notches > 0 && r.notches <= WHEEL_MAX_NOTCHES && r.rounds <= 3, "converges in a few rounds, within the notch budget");
  ok(logs.some((l) => /wheel round 1: down \d+ on page/.test(l)), "each round is logged with direction, notches and scroller"); }

console.log("== the cursor is used where it already is ==");
{ load({ elTop: 2500, cursor: { x: 640, y: 400 } });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(r.ok && onScreen(), "in view");
  ok(moves.length === 0, "no cursor movement at all: the wheel turned where the pointer rested");
  ok(wheels.every((w) => w.x === 640 && w.y === 400), "every notch at the resting point"); }

console.log("== notch size is measured, not assumed ==");
{ load({ elTop: 3375, px: 150, docH: 9000 });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(r.ok && onScreen(), `a 150px notch still lands it in view (${r.notches} notches, ${r.rounds} rounds)`);
  ok(msgs.length > 1 && Math.abs(msgs[1].perNotch - 150) < 1, `round 2 is planned in measured units (perNotch ${msgs[1] && msgs[1].perNotch})`); }

console.log("== element above: wheels up ==");
{ load({ elTop: 500, scrollY: 4000 });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(r.ok && onScreen() && wheels.length && wheels.every((w) => w.dy === -100), `up ${wheels.length} notches, in view`); }

console.log("== a round never wheels past its clearance ==");
{ load({ elTop: 3375, clear: 1000 });
  const r = await wheelRefIntoView(1, "ref_1");
  const perRound = [...new Set(wheels.map((w) => w.round))].map((k) => wheels.filter((w) => w.round === k).length);
  ok(r.ok && onScreen(), `in view over ${r.rounds} rounds`);
  ok(perRound.every((n) => n <= 10), `no round exceeded 1000px of clearance (${perRound.join(", ")} notches)`); }

console.log("== giving up, so the caller can fall back ==");
{ load({ elTop: 3375, stuck: true });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(!r.ok && r.why === "page did not scroll" && r.rounds === 1, `page that doesn't move: gives up after one round (${r.why})`); }
{ load({ elTop: 20000, docH: 30000 });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(!r.ok && /too far/.test(r.why) && wheels.length === 0 && moves.length === 0,
     `beyond ${WHEEL_MAX_NOTCHES} notches: declines before touching anything (${r.why})`); }
{ load({ elTop: 3375, why: "off-screen horizontally" });
  const r = await wheelRefIntoView(1, "ref_1");
  ok(!r.ok && r.why === "off-screen horizontally" && wheels.length === 0, "the page side's reason is passed through"); }

// --- the computer handler around it -------------------------------------------
const calls = [];
let humanizeFlag = false, wheelResult = null;
const H = compile(`const H = { ${extractMethod("computer")} };`, {
  isInGroup: async () => true,
  humanizeOn: async () => humanizeFlag,
  wheelRefIntoView: async (tabId, ref) => {
    calls.push({ fn: "wheel", ref });
    if (wheelResult instanceof Error) throw wheelResult;
    return wheelResult;
  },
  resolveRefToCoordinates: async (tabId, ref, opts = {}) => {
    calls.push({ fn: "resolve", ref, scrollIntoView: opts.scrollIntoView !== false });
    return { x: 600, y: 377, reachable: true, covering: null, scrolledFrom: opts.scrollIntoView === false ? null : [600, 3390] };
  },
  dbg: (kind, detail) => logs.push(detail),
  parseModifierString: () => 0,
  cdp: async (tabId, method, params) => calls.push({ fn: "cdp", method, expression: params.expression }),
  sleep: async () => {},
  isBrave: async () => false,
  probeHit: async () => ({}),
  hitNote_: () => "",
  formatHit: () => ""
}, "H");
const run = async (args) => { calls.length = 0; logs.length = 0; return (await H.computer({ tabId: 1, ...args })).content[0].text; };

console.log("== scroll_to by ref ==");
{ humanizeFlag = false;
  const text = await run({ action: "scroll_to", ref: "ref_1" });
  ok(!calls.some((c) => c.fn === "wheel"), "humanize off: no wheeling");
  ok(calls.filter((c) => c.fn === "resolve").length === 1 && calls.find((c) => c.fn === "resolve").scrollIntoView,
     "humanize off: brought into view by the instant scroll, as before");
  ok(!calls.some((c) => c.fn === "cdp"), "the ref's viewport position is NOT fed to window.scrollTo (the old bug)");
  ok(text === "Scrolled ref_1 into view", `reports what happened ("${text}")`); }
{ const text = await run({ action: "scroll_to", coordinate: [0, 1200] });
  ok(calls.length === 1 && calls[0].expression === "window.scrollTo(0, 1200)", "by coordinate: unchanged, window.scrollTo");
  ok(text === "Scrolled to target", "and its reply is unchanged"); }

console.log("== humanize on: wheel first, jump only as the fallback ==");
{ humanizeFlag = true; wheelResult = { ok: true, notches: 27, rounds: 2 };
  await run({ action: "scroll_to", ref: "ref_1" });
  ok(calls[0].fn === "wheel" && calls[1].fn === "resolve" && calls[1].scrollIntoView === false,
     "wheeled, then resolved WITHOUT the instant scroll");
  ok(logs.some((l) => /ref_1 wheeled into view: 27 notches in 2 rounds/.test(l)), "logged as wheeled"); }
{ wheelResult = { ok: true, notches: 0, rounds: 0 };
  await run({ action: "left_click", ref: "ref_1", coordinate: undefined }).catch(() => {});
  ok(calls[1] && calls[1].scrollIntoView === false && !logs.some((l) => /wheeled into view/.test(l)),
     "already on screen: no scroll of either kind, and nothing claimed"); }
{ wheelResult = { ok: false, notches: 3, rounds: 1, why: "page did not scroll" };
  await run({ action: "scroll_to", ref: "ref_1" });
  ok(calls[1].fn === "resolve" && calls[1].scrollIntoView === true, "gave up: falls back to the instant scroll");
  ok(logs.some((l) => /not wheeled into view \(page did not scroll\) after 3 notches — jumping instead/.test(l)), "and says so in the log"); }
{ wheelResult = new Error("Could not establish connection");
  const text = await run({ action: "scroll_to", ref: "ref_1" });
  ok(calls[1].fn === "resolve" && calls[1].scrollIntoView === true && text === "Scrolled ref_1 into view",
     "wheeling threw: still falls back, the action still succeeds"); }

console.log(fail === 0 ? "\nALL WHEEL-INTO-VIEW TESTS PASSED" : `\n${fail} TEST(S) FAILED`);
process.exit(fail ? 1 : 0);
