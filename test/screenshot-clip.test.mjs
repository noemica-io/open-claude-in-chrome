// The screenshot clip: runs the SHIPPED takeScreenshot against a mock CDP layer
// whose Runtime.evaluate executes the shipped page expression against a fake
// window, and asserts the clip passed to Page.captureScreenshot.
//
// The bug this guards: the clip's x/y are page coordinates (Chrome draws the
// document from there for the capture, adding the scroll offset back in), and
// they were hardcoded to 0,0. Scrolled down by S, every screenshot came back
// shifted down by S, blank past one viewport, and the window flashed to that
// frame on every scroll. The clip must start where the viewport is.
import vm from "node:vm";
import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

let page = null;          // the fake window the expression runs against
let evaluateThrows = false;
let bigFirstShot = false;
const shots = [];

const cdp = async (tabId, method, params) => {
  if (method === "Runtime.evaluate") {
    if (evaluateThrows) throw new Error("Execution context was destroyed");
    const ctx = vm.createContext({ ...page });
    ctx.window = ctx;
    return { result: { value: vm.runInContext(params.expression, ctx) } };
  }
  if (method === "Page.captureScreenshot") {
    shots.push(params);
    return { data: bigFirstShot && shots.length === 1 ? "A".repeat(400000) : "AAAA" };
  }
  throw new Error("unexpected CDP call " + method);
};

const takeScreenshot = compile(
  "",
  { ensureAttached: async () => {}, cdp, dbg: () => {}, screenshotStore: new Map() },
  `(${extractFunction("takeScreenshot")})`
);

const viewportAt = (pageLeft, pageTop, extra = {}) => ({
  innerWidth: 2320, innerHeight: 1253, devicePixelRatio: 1,
  scrollX: pageLeft, scrollY: pageTop,
  visualViewport: { pageLeft, pageTop },
  ...extra,
});

const clipFor = async (p) => {
  page = p; shots.length = 0;
  await takeScreenshot(1);
  return shots[0].clip;
};

console.log("== the clip starts where the viewport is ==");
for (const y of [0, 250, 500, 1300, 6000]) {
  const clip = await clipFor(viewportAt(0, y));
  ok(clip.x === 0 && clip.y === y,
    `scrolled to ${y}: clip at page (${clip.x},${clip.y})` +
    (clip.y !== y ? ` — capture would be drawn ${y - clip.y}px too low` : ""));
}

console.log("== size and scale are unchanged by the offset ==");
{
  const clip = await clipFor(viewportAt(0, 1300));
  ok(clip.width === 2320 && clip.height === 1253, "clip is the CSS viewport size");
  ok(clip.scale === 1, "dpr 1 -> scale 1");
  const hi = await clipFor(viewportAt(0, 900, { innerWidth: 1008, innerHeight: 632, devicePixelRatio: 1.5 }));
  ok(hi.y === 900 && hi.width === 1008 && hi.height === 632, "1.5x display: CSS-pixel clip at the scroll offset");
  ok(Math.abs(hi.scale - 1 / 1.5) < 1e-12, "1.5x display: scale 1/1.5, so the image's pixels are CSS pixels");
}

console.log("== horizontal and fractional offsets ==");
{
  const clip = await clipFor(viewportAt(340, 1234.5));
  ok(clip.x === 340 && clip.y === 1234.5, `both axes, fractional kept: (${clip.x},${clip.y})`);
}

console.log("== the visual viewport wins over the layout scroll ==");
{
  // Pinch-zoomed: the visual viewport sits inside the layout viewport, and
  // Blink adds both offsets, which is exactly what pageLeft/pageTop report.
  const clip = await clipFor({ ...viewportAt(0, 0), scrollX: 0, scrollY: 1000, visualViewport: { pageLeft: 30, pageTop: 1120 } });
  ok(clip.x === 30 && clip.y === 1120, `clip at the visual viewport's page offset (${clip.x},${clip.y})`);
}

console.log("== fallbacks ==");
{
  const p = viewportAt(0, 777); delete p.visualViewport;
  const clip = await clipFor(p);
  ok(clip.y === 777, "no visualViewport: falls back to scrollX/scrollY");

  evaluateThrows = true;
  page = viewportAt(0, 500); shots.length = 0;
  const r = await takeScreenshot(1);
  evaluateThrows = false;
  ok(shots.length === 1 && shots[0].clip === undefined && r.base64 === "AAAA",
    "page unreadable: still captures, unclipped, rather than failing the screenshot");
}

console.log("== the quality retry keeps the same clip ==");
{
  bigFirstShot = true;
  page = viewportAt(0, 1300); shots.length = 0;
  await takeScreenshot(1);
  bigFirstShot = false;
  ok(shots.length === 2 && shots[1].quality < shots[0].quality, "oversized first capture is retried at lower quality");
  ok(shots[1].clip.y === 1300 && shots[1].clip === shots[0].clip, "the retry uses the same scroll-offset clip");
}

console.log(fail === 0 ? "\nALL SCREENSHOT CLIP TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
