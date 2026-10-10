// Executor-level test: feeds real humanize plans through the SHIPPED
// dispatchPlan and records the exact CDP calls it would make. Validates the
// seam between the pure planners and the browser — the part unit tests of the
// planners alone cannot cover.
import * as humanize from "../extension/humanize/index.js";
import { extractFunction, compile } from "./_extract.mjs";

const calls = [];
const cursorByTab = new Map();
// Stubs mirroring background.js's real helpers.
const ensureAttached = async () => {};
const sleep = async (ms) => { calls.push({ fn: "sleep", ms }); };
const dispatchMouse = async (tabId, type, x, y, opts = {}) => calls.push({ fn: "mouse", type, x, y, ...opts });
const sendMouseEvent = async (tabId, params) => calls.push({ fn: "mouse", type: params.type, x: params.x, y: params.y, deltaX: params.deltaX, deltaY: params.deltaY });
const cdp = async (tabId, method, params) => calls.push({ fn: "cdp", method, ...params });

const dispatchPlan = compile(
  "",
  { ensureAttached, sleep, dispatchMouse, sendMouseEvent, cdp, cursorByTab },
  `(${extractFunction("dispatchPlan")})`
);

let fail = 0;
const ok = (c,m) => { console.log((c?"  PASS ":"  FAIL ")+m); if(!c) fail++; };
const reset = () => { calls.length = 0; };

const s = humanize.createSession(42);

console.log("== click plan -> CDP calls ==");
reset();
await dispatchPlan(1, humanize.planClick(s, {x:10,y:10}, {x:400,y:300}), 0);
const mouse = calls.filter(c=>c.fn==="mouse");
const moves = mouse.filter(c=>c.type==="mouseMoved");
const press = mouse.filter(c=>c.type==="mousePressed");
const rel   = mouse.filter(c=>c.type==="mouseReleased");
ok(moves.length > 5, `${moves.length} mouseMoved dispatched before/through the click`);
ok(press.length===1 && rel.length===1, "exactly one mousePressed + one mouseReleased");
ok(press[0].x===400 && press[0].y===300, "press dispatched at the exact target");
ok(calls.filter(c=>c.fn==="sleep").length > 5, "delays interleaved (timing actually applied)");
ok(cursorByTab.get(1).x===400 && cursorByTab.get(1).y===300, "per-tab cursor updated to the landing point");

console.log("== cursor continuity across two actions in the same tab ==");
reset();
const start = cursorByTab.get(1);
await dispatchPlan(1, humanize.planClick(s, start, {x:120,y:90}), 0);
const firstMove = calls.filter(c=>c.fn==="mouse" && c.type==="mouseMoved")[0];
ok(Math.hypot(firstMove.x-400, firstMove.y-300) < 90, `second action starts near where the first ended (${firstMove.x},${firstMove.y}) — continuous hand, not a teleport`);

console.log("== per-tab isolation ==");
reset();
await dispatchPlan(2, humanize.planClick(s, {x:5,y:5}, {x:60,y:60}), 0);
ok(cursorByTab.get(1).x===120 && cursorByTab.get(2).x===60, "tab 1 and tab 2 keep separate cursors");

console.log("== type plan -> rawKeyDown + insertText + keyUp ==");
reset();
await dispatchPlan(1, humanize.planType(s, "Hi!"), 0);
const cdps = calls.filter(c=>c.fn==="cdp");
const rawDowns = cdps.filter(c=>c.method==="Input.dispatchKeyEvent" && c.type==="rawKeyDown");
const keyUps   = cdps.filter(c=>c.method==="Input.dispatchKeyEvent" && c.type==="keyUp");
const inserts  = cdps.filter(c=>c.method==="Input.insertText");
ok(rawDowns.length===3 && keyUps.length===3, `3 rawKeyDown + 3 keyUp for "Hi!" (got ${rawDowns.length}/${keyUps.length})`);
ok(rawDowns.every(c=>c.type==="rawKeyDown"), "keydowns use rawKeyDown (non-text-producing) — cannot double-insert");
ok(inserts.map(c=>c.text).join("")==="Hi!", `insertText reassembles exactly "Hi!" (got "${inserts.map(c=>c.text).join("")}")`);
ok(inserts.length===3, "exactly one insertText per character — no duplicate insertion");
ok(rawDowns.every(c=>!c.autoRepeat), "no autoRepeat flag during normal typing");
ok(rawDowns.some(c=>c.modifiers===8), "shift modifier carried for capital/!" );
ok(rawDowns.every(c=>typeof c.windowsVirtualKeyCode==="number"), "every keydown carries a numeric keyCode");

console.log("== ordering: keydown BEFORE its insertText, keyup AFTER ==");
{ const seq = calls.filter(c=>c.fn==="cdp").map(c=>c.method==="Input.insertText"?"T":(c.type==="rawKeyDown"?"D":"U")).join("");
  ok(/^(DTU)+$/.test(seq), `event order is strictly keydown->text->keyup per char (${seq})`); }

console.log("== long hold renders OS auto-repeat through the executor ==");
reset();
await dispatchPlan(1, humanize.planKey(s, {key:"Backspace",code:"Backspace",keyCode:8,holdMs:1000}), 0);
const rep = calls.filter(c=>c.fn==="cdp" && c.autoRepeat===true);
ok(rep.length>8, `${rep.length} autoRepeat keydowns dispatched for a 1s hold`);
ok(calls.filter(c=>c.fn==="cdp" && c.method==="Input.dispatchKeyEvent" && c.type==="keyUp").length===1, "exactly one keyUp");
ok(calls.filter(c=>c.fn==="cdp" && c.method==="Input.insertText").length===0, "a key press inserts no text of its own");

console.log("== drag plan ==");
reset();
await dispatchPlan(1, humanize.planDrag(s, {x:0,y:0}, {x:50,y:50}, {x:300,y:200}), 0);
const dm = calls.filter(c=>c.fn==="mouse");
ok(dm.filter(c=>c.type==="mousePressed").length===1, "one press");
ok(dm.filter(c=>c.type==="mouseReleased")[0].x===300, "release at the exact end point");

console.log("== wheel plan -> one mouseWheel per notch, cursor untouched ==");
reset();
cursorByTab.set(4, { x: 500, y: 380 });
await dispatchPlan(4, humanize.planWheel(s, { x: 500, y: 380 }, 7, -1), 0);
const wh = calls.filter(c=>c.fn==="mouse");
ok(wh.length===7 && wh.every(c=>c.type==="mouseWheel"), "7 notches -> exactly 7 mouseWheel events, nothing else");
ok(wh.every(c=>c.x===500 && c.y===380 && c.deltaX===0 && c.deltaY===-100), "each at the planned point, deltaY -100, no horizontal delta");
ok(calls.filter(c=>c.fn==="sleep").length===6, "a gap between every pair of notches");
ok(cursorByTab.get(4).x===500 && cursorByTab.get(4).y===380, "the per-tab cursor stays where the wheel was turned");

console.log(fail===0 ? "\nALL EXECUTOR TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail?1:0);
