// Where a humanized click or hover by `ref` lands: runs the SHIPPED
// refLandingPoint against stubbed config and content-script replies. The
// planners always finish exactly on the point they are given, so this is the
// one place that decides whether that point is the element's centre or a
// sampled spot inside it — and it must never pick a point the element doesn't own.
import * as humanize from "../extension/humanize/index.js";
import { extractFunction, compile } from "./_extract.mjs";

let humanizeEnabled = true;
let ownsPoint = () => true;
const sent = [];
const session = humanize.createSession(42);

const refLandingPoint = compile(
  "",
  {
    humanize,
    humanizeOn: async () => humanizeEnabled,
    effectiveConfig: () => ({ humanize_speed: "fast", humanize_seed: 42 }),
    human: () => session,
    sendContentMessage: async (tabId, msg) => { sent.push(msg); return { result: ownsPoint(msg) }; },
    dbg: () => {}
  },
  `(${extractFunction("refLandingPoint")})`
);

let fail = 0;
const ok = (c,m) => { console.log((c?"  PASS ":"  FAIL ")+m); if(!c) fail++; };

// A 200×40 button whose centre is (200, 120).
const rect = { x: 100, y: 100, width: 200, height: 40 };
const res = { x: 200, y: 120, rect, covering: null };
const isCentre = (r) => r.coordinate[0] === 200 && r.coordinate[1] === 120;

console.log("== humanize off: exactly the centre, as before ==");
humanizeEnabled = false;
sent.length = 0;
let r = await refLandingPoint(1, "ref_1", "left_click", res);
ok(isCentre(r), "lands on the centre");
ok(r.targetSize === undefined, "no targetSize — the plain path doesn't plan a movement");
ok(sent.length === 0, "nothing sent to the page");
humanizeEnabled = true;

console.log("== humanize on: sampled inside the element ==");
const pts = new Set();
let inside = true, sizes = true;
for (let i = 0; i < 300; i++) {
  r = await refLandingPoint(1, "ref_1", "left_click", res);
  const [x, y] = r.coordinate;
  if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) inside = false;
  if (r.targetSize !== 40) sizes = false;
  pts.add(`${x},${y}`);
}
ok(inside, "every one of 300 landings is inside the element's box");
ok(pts.size > 40, `landing varies (${pts.size} distinct points, not the centre every time)`);
ok(sizes, "targetSize is the element's smaller side (40), for the Fitts-law duration");
ok(sent.every((m) => m.type === "refOwnsPoint" && m.ref === "ref_1"), "each sampled point is re-tested against the ref");

console.log("== every pointer action is humanized, nothing else ==");
for (const action of ["right_click", "double_click", "triple_click", "hover"]) {
  sent.length = 0;
  await refLandingPoint(1, "ref_1", action, res);
  ok(sent.length === 1, `${action} samples a point`);
}
for (const action of ["scroll", "scroll_to", "left_click_drag"]) {
  sent.length = 0;
  r = await refLandingPoint(1, "ref_1", action, res);
  ok(isCentre(r) && sent.length === 0, `${action} keeps the centre`);
}

console.log("== the sampled point belongs to something else: back to the centre ==");
ownsPoint = () => false;
r = await refLandingPoint(1, "ref_1", "left_click", res);
ok(isCentre(r), "lands on the centre");
ok(r.targetSize === 40, "still a humanized movement (targetSize kept)");
ownsPoint = () => { throw new Error("content script gone"); };
r = await refLandingPoint(1, "ref_1", "left_click", res);
ok(isCentre(r), "re-test message fails → centre, not a failed click");
ownsPoint = () => true;

console.log("== centre is covered: keep it, so the interception report stays true ==");
sent.length = 0;
r = await refLandingPoint(1, "ref_1", "left_click", { ...res, covering: "div.modal-backdrop" });
ok(isCentre(r), "lands on the centre");
ok(sent.length === 0, "no sampling attempted");

console.log("== no rect (older content script) or a zero-size box: the centre ==");
r = await refLandingPoint(1, "ref_1", "left_click", { x: 200, y: 120 });
ok(isCentre(r), "missing rect → centre");
r = await refLandingPoint(1, "ref_1", "left_click", { x: 200, y: 120, rect: { x: 200, y: 120, width: 0, height: 0 } });
ok(isCentre(r), "zero-size rect → centre");

console.log(fail === 0 ? "\nALL REF LANDING TESTS PASSED" : `\n${fail} TEST(S) FAILED`);
process.exit(fail ? 1 : 0);
