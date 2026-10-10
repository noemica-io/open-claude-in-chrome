import { createSession, planClick, planHover, planDrag, planType, planKey, planWheel, wheelAim, sampleInBox } from "../extension/humanize/index.js";
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

console.log("== INVARIANT: click always lands exactly on target ==");
let landedAll = true, uniquePts = new Set(), pathLens = new Set();
for (let i = 0; i < 300; i++) {
  const s = createSession(i);
  const from = { x: 50 + i, y: 60 }, to = { x: 700, y: 420 };
  const plan = planClick(s, from, to);
  const downs = plan.filter(p => p.k === "down"), ups = plan.filter(p => p.k === "up");
  const moves = plan.filter(p => p.k === "move");
  if (downs[0].x !== to.x || downs[0].y !== to.y) landedAll = false;
  if (ups[0].x !== to.x || ups[0].y !== to.y) landedAll = false;
  if (moves.length) uniquePts.add(moves[Math.floor(moves.length/2)].x + ":" + moves[Math.floor(moves.length/2)].y);
  pathLens.add(moves.length);
}
ok(landedAll, "300 clicks all press+release exactly on the target point");
ok(uniquePts.size > 250, `paths are highly varied (${uniquePts.size}/300 distinct midpoints)`);
ok(pathLens.size > 8, `path length varies (${pathLens.size} distinct point counts)`);

console.log("== movement precedes every click ==");
{ const s = createSession(7); const plan = planClick(s, {x:10,y:10}, {x:400,y:300});
  const firstDown = plan.findIndex(p=>p.k==="down"); const movesBefore = plan.slice(0,firstDown).filter(p=>p.k==="move").length;
  ok(movesBefore >= 5, `${movesBefore} move events dispatched before the press`); }

console.log("== double_click = 2 distinct press/release cycles ==");
{ const s = createSession(3); const plan = planClick(s, {x:0,y:0}, {x:100,y:100}, {clickCount:2});
  ok(plan.filter(p=>p.k==="down").length===2 && plan.filter(p=>p.k==="up").length===2, "two down + two up (not one flagged event)"); }

console.log("== INVARIANT: typed text is EXACTLY the input, once ==");
{ let allExact = true; const samples = ["hello world","OCIC-TEST-DO-NOT-SUBMIT","a@b.co, x!","Ünïcødé 😀 中文"];
  for (const t of samples) for (let i=0;i<40;i++){ const s=createSession(i);
    const out = planType(s,t).filter(p=>p.k==="text").map(p=>p.text).join("");
    if (out !== t) { allExact=false; console.log("   mismatch:", JSON.stringify(out)); } }
  ok(allExact, "text reassembles byte-identical across 160 runs incl. unicode/emoji"); }

console.log("== typing: key events paired, no autoRepeat, dwell under threshold ==");
{ const s = createSession(11); const plan = planType(s, "hello");
  const kd = plan.filter(p=>p.k==="kdown"), ku = plan.filter(p=>p.k==="kup");
  ok(kd.length===ku.length && kd.length===5, `5 keydown + 5 keyup for 5 chars (got ${kd.length}/${ku.length})`);
  ok(!kd.some(p=>p.autoRepeat), "no autoRepeat during normal typing");
  // dwell = sleep between kdown and its kup
  let maxDwell=0; for(let i=0;i<plan.length;i++){ if(plan[i].k==="kdown"){ for(let j=i+1;j<plan.length;j++){ if(plan[j].k==="sleep") maxDwell=Math.max(maxDwell,plan[j].ms); if(plan[j].k==="kup") break; } } }
  ok(maxDwell < s.tm.initialDelayMs, `max key hold ${Math.round(maxDwell)}ms < typematic initial delay ${Math.round(s.tm.initialDelayMs)}ms (so no repeat is FAITHFUL)`);
  ok(kd.every(p=>p.code && p.code.length), "every keydown carries a real code"); }

console.log("== unmappable chars fall back to insertText only ==");
{ const s=createSession(5); const plan=planType(s,"😀中"); ok(plan.filter(p=>p.k==="kdown").length===0 && plan.filter(p=>p.k==="text").length===2, "emoji/CJK: no fabricated keystrokes, text still inserted"); }

console.log("== deliberate long hold renders OS auto-repeat ==");
{ const s=createSession(9); const plan=planKey(s,{key:"Backspace",code:"Backspace",keyCode:8,holdMs:1200});
  const reps=plan.filter(p=>p.k==="kdown"&&p.autoRepeat).length;
  ok(reps>10, `${reps} autoRepeat keydowns emitted for a 1.2s hold`);
  ok(plan.filter(p=>p.k==="kup").length===1, "exactly one keyup closes the hold"); }
{ const s=createSession(9); const plan=planKey(s,{key:"Enter",code:"Enter",keyCode:13});
  ok(plan.filter(p=>p.k==="kdown").length===1 && !plan.some(p=>p.autoRepeat), "a normal press does NOT repeat"); }

// (No invariant for the `scroll` action: humanizing it was removed after two
// attempts changed where the page landed, so it issues the same single wheel
// event with or without humanization and equivalence holds by construction.
// planWheel below serves wheeling a ref into view, which checks its outcome.)

console.log("== INVARIANT: planWheel delivers exactly notches x 100, at one point ==");
{ let exact = true, onePoint = true, noMoves = true;
  for (let i = 0; i < 200; i++) {
    const s = createSession(i), at = { x: 300 + i, y: 400 }, n = 1 + (i % 40), dir = i % 2 ? 1 : -1;
    const plan = planWheel(s, at, n, dir);
    const w = plan.filter(p => p.k === "wheel");
    if (w.length !== n || w.reduce((a, p) => a + p.dy, 0) !== n * 100 * dir || w.some(p => p.dx !== 0)) exact = false;
    if (w.some(p => p.x !== at.x || p.y !== at.y)) onePoint = false;
    if (plan.some(p => p.k === "move" || p.k === "down" || p.k === "up")) noMoves = false;
  }
  ok(exact, "200 plans: one 100-unit event per notch, sum = notches x 100 x dir, no horizontal delta");
  ok(onePoint, "every wheel event of a plan is at the same point (the cursor never drifts mid-scroll)");
  ok(noMoves, "no pointer moves or presses inside a wheel plan");
  ok(planWheel(createSession(1), { x: 1, y: 1 }, 0, 1).length === 0, "zero notches is an empty plan");
}

console.log("== planWheel timing: quick detents, paused flicks, tier-scaled ==");
{ const sleeps = (tier) => planWheel(createSession(21, tier), { x: 10, y: 10 }, 60, 1).filter(p => p.k === "sleep").map(p => p.ms);
  const nat = sleeps("natural"), fst = sleeps("fastest");
  ok(nat.length === 59, `one gap between each pair of notches (${nat.length} for 60)`);
  ok(nat.every(ms => ms >= 25 && ms <= 450), `natural: every gap within 25-450ms (${Math.min(...nat)}-${Math.max(...nat)})`);
  // Flicks are at most 5 detents, each followed by a pause drawn from >= 90ms
  // at natural, so 60 notches carry at least 11 of them. (Detent gaps can
  // reach 140ms too, so this is a floor, not an exact count.)
  const pauses = nat.filter(ms => ms >= 90).length;
  ok(pauses >= 11 && pauses < 59, `notches come in flicks: ${pauses} pauses >= 90ms among 59 gaps`);
  ok(fst.every(ms => ms >= 12), `fastest: no gap below the 12ms device floor (min ${Math.min(...fst)}ms)`);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  ok(sum(fst) < sum(nat) / 2, `the fastest tier compresses the same 60 notches (${sum(fst)}ms vs ${sum(nat)}ms natural)`);
}

console.log("== wheelAim: a target line mid-window and spots inside it ==");
{ let aimOk = true, spotsOk = true;
  for (let i = 0; i < 200; i++) { const { aim, spots } = wheelAim(createSession(i));
    if (aim < 0.35 || aim > 0.6) aimOk = false;
    if (spots.length !== 16 || spots.some(([fx, fy]) => fx < 0.12 || fx > 0.88 || fy < 0.15 || fy > 0.85)) spotsOk = false; }
  ok(aimOk, "aim always within 35-60% of the window height");
  ok(spotsOk, "16 candidate spots, all clear of the window edges");
  ok(JSON.stringify(wheelAim(createSession(5))) === JSON.stringify(wheelAim(createSession(5))), "seeded: same hand, same intent");
}

console.log("== sampleInBox stays inside the element ==");
{ let inside=true; const s=createSession(2); const rect={x:100,y:200,width:60,height:24};
  const pts=new Set();
  for(let i=0;i<500;i++){ const p=sampleInBox(rect,s.rng,s.persona); pts.add(p.x+":"+p.y);
    if(p.x<rect.x||p.x>rect.x+rect.width||p.y<rect.y||p.y>rect.y+rect.height) inside=false; }
  ok(inside, "500 samples all inside the box (never misses the target)");
  ok(pts.size>40, `landing point varies (${pts.size} distinct points, not dead-centre every time)`); }

console.log("== tiny target still safe ==");
{ let inside=true; const s=createSession(4); const rect={x:10,y:10,width:8,height:8};
  for(let i=0;i<300;i++){ const p=sampleInBox(rect,s.rng,s.persona);
    if(p.x<rect.x||p.x>rect.x+rect.width||p.y<rect.y||p.y>rect.y+rect.height) inside=false; }
  ok(inside, "8x8px target: 300 samples all inside"); }

console.log("== drag: press at start, release at end, curve between ==");
{ const s=createSession(6); const plan=planDrag(s,{x:0,y:0},{x:100,y:100},{x:400,y:250});
  const d=plan.find(p=>p.k==="down"), u=plan.find(p=>p.k==="up");
  ok(d.x===100&&d.y===100, "press exactly at start");
  ok(u.x===400&&u.y===250, "release exactly at end");
  const movesBetween = plan.slice(plan.indexOf(d), plan.indexOf(u)).filter(p=>p.k==="move").length;
  ok(movesBetween>5, `${movesBetween} intermediate moves (not a straight 10-step line)`); }

console.log("== sessions differ from one another (persona) ==");
{ const a=createSession(), b=createSession();
  ok(a.persona.speed!==b.persona.speed || a.persona.typeTempo!==b.persona.typeTempo, "two sessions get different personas"); }



// ---- speed tiers -----------------------------------------------------------
{
  const { createSession: mk, TEMPOS } = await import("../extension/humanize/index.js");
  console.log("== speed tiers trade time for detail, never correctness ==");
  const dur = (plan) => plan.filter(p => p.k === "sleep").reduce((a, p) => a + p.ms, 0);
  const moves = (plan) => plan.filter(p => p.k === "move").length;
  const from = { x: 20, y: 20 }, to = { x: 640, y: 400 };
  const rows = ["fastest", "fast", "natural", "relaxed"].map((tier) => {
    const s = mk(7, tier);
    const p = planClick(s, from, to);
    const d = p.filter(x => x.k === "down"), u = p.filter(x => x.k === "up");
    return { tier, ms: dur(p), moves: moves(p), landsOn: d[0].x === to.x && d[0].y === to.y && u[0].x === to.x };
  });
  for (const r of rows) console.log(`     ${r.tier.padEnd(11)} ${String(r.ms).padStart(5)}ms  ${String(r.moves).padStart(3)} moves`);
  const monotonic = rows.every((r, i) => i === 0 || rows[i - 1].ms < r.ms);
  ok(monotonic, "duration increases strictly across the four tiers, fastest -> relaxed");
  const movesMonotonic = rows.every((r, i) => i === 0 || rows[i - 1].moves <= r.moves);
  ok(movesMonotonic, "path sample count is non-decreasing across the tiers");
  ok(rows.every(r => r.moves >= 3), `even the fastest tier MOVES before clicking (min ${Math.min(...rows.map(r=>r.moves))} samples, not zero)`);
  ok(rows.every(r => r.landsOn), "every tier still lands exactly on the target");

  // typing text must stay byte-identical at every tier
  const txt = "user@example.com";
  ok(["fastest","fast","natural","relaxed"].every(tier =>
      planType(mk(3, tier), txt).filter(p=>p.k==="text").map(p=>p.text).join("") === txt),
     "typed text is byte-identical at every speed tier");
  // and key hold must stay under the typematic threshold even when slowed down
  const sd = mk(3, "relaxed");
  const planD = planType(sd, "ab");
  let maxHold = 0;
  for (let i=0;i<planD.length;i++) if (planD[i].k==="kdown")
    for (let j=i+1;j<planD.length;j++){ if(planD[j].k==="sleep") maxHold=Math.max(maxHold,planD[j].ms); if(planD[j].k==="kup") break; }
  ok(maxHold < sd.tm.initialDelayMs, `slowest tier still holds keys under the typematic delay (${Math.round(maxHold)}ms < ${Math.round(sd.tm.initialDelayMs)}ms) — no accidental auto-repeat`);
  ok(Object.keys(TEMPOS).length === 4, "four tiers exposed");

  // Typing cost is per CHARACTER, so a tier multiplier that is harmless on a
  // click compounds into seconds on a form field. Measured: a uniform 1.5x
  // tier typed 15 characters in 4.9s — slower than a tier already removed for
  // being unusable. The slow end of `keys` is therefore damped relative to
  // `time`, and this asserts that damping stays in place.
  const typeMs = (tier) => planType(mk(5, tier), "Hello World 123")
    .filter(p => p.k === "sleep").reduce((a, p) => a + p.ms, 0);
  const clickMs = (tier) => planClick(mk(5, tier), { x: 20, y: 20 }, { x: 640, y: 400 })
    .filter(p => p.k === "sleep").reduce((a, p) => a + p.ms, 0);
  const slowTypeRatio = typeMs("relaxed") / typeMs("natural");
  const slowClickRatio = clickMs("relaxed") / clickMs("natural");
  ok(slowClickRatio > slowTypeRatio,
     `the slowest tier slows MOTION more than TYPING (click x${slowClickRatio.toFixed(2)} vs type x${slowTypeRatio.toFixed(2)})`);
  ok(typeMs("relaxed") < 3600,
     `slowest tier types 15 chars in ${typeMs("relaxed")}ms planned — stays under the ~4s line that got a tier cut`);
  ok(typeMs("fastest") < typeMs("fast") && typeMs("fast") < typeMs("natural"),
     "typing still gets monotonically slower across the tiers");
  // A default that costs a lot is a default nobody keeps.
  const { DEFAULT_TEMPO } = await import("../extension/humanize/index.js");
  ok(DEFAULT_TEMPO === "fast", "the cheaper tier is the default");
}

// ---- a pinned seed makes the hand reproducible ------------------------------
{
  const { createSession: mk4 } = await import("../extension/humanize/index.js");
  console.log("== humanize_seed pins the persona, so a comparison can be controlled ==");
  const hand = (s) => JSON.stringify(s.persona);
  ok(hand(mk4(12345, "natural")) === hand(mk4(12345, "natural")),
     "same seed rebuilds an identical hand");
  ok(hand(mk4(12345, "natural")) !== hand(mk4(999, "natural")),
     "a different seed gives a different hand");
  // The hand must not depend on the tier, or a study varying only the speed
  // would silently be varying the operator too.
  ok(hand(mk4(12345, "fastest")) === hand(mk4(12345, "relaxed")),
     "the SAME seed gives the same hand at every speed tier — so tier is the only variable");
  // And the same plan must reproduce exactly, not merely the persona.
  const planOf = (t) => JSON.stringify(planClick(mk4(777, t), { x: 5, y: 5 }, { x: 500, y: 300 }));
  ok(planOf("natural") === planOf("natural"), "a pinned seed reproduces the whole trajectory, not just the persona");
  ok(hand(mk4(undefined, "natural")) !== hand(mk4(undefined, "natural")),
     "with no seed, each session still draws its own hand (no shared signature)");
}

// ---- device-like sampling cadence ------------------------------------------
{
  const { createSession: mk2 } = await import("../extension/humanize/index.js");
  console.log("== cursor samples arrive on a steady clock, like a polling device ==");
  const gapsFor = (tier) => {
    const s = mk2(9, tier);
    const plan = planClick(s, { x: 20, y: 20 }, { x: 640, y: 420 });
    const g = [];
    for (let i = 0; i < plan.length; i++)
      if (plan[i].k === "sleep" && plan[i + 1] && plan[i + 1].k === "move") g.push(plan[i].ms);
    return g;
  };
  const stat = (g) => {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    return { mean: m, sd: Math.sqrt(g.reduce((a, b) => a + (b - m) ** 2, 0) / g.length), n: g.length };
  };
  for (const tier of ["fastest", "fast", "natural", "relaxed"]) {
    const st = stat(gapsFor(tier));
    // A real mouse polls on a fixed clock; velocity lives in the SPACING of the
    // samples, not in varying the gaps. Irregular within-gesture timing is a
    // behavioural tell, so the interval must stay tight.
    ok(st.sd / st.mean < 0.25,
       `${tier}: sample interval is regular (mean ${st.mean.toFixed(1)}ms, sd ${st.sd.toFixed(2)}ms — ratio ${(st.sd/st.mean).toFixed(2)})`);
  }
  const a = stat(gapsFor("fastest")), b = stat(gapsFor("fast")), c = stat(gapsFor("natural"));
  const d = stat(gapsFor("relaxed"));
  // Regression guard: a sample-count ceiling used to widen the interval on the
  // slowest tier (~12ms vs 8ms), making the tier change the apparent poll rate.
  ok(Math.abs(d.mean - c.mean) < 2,
     `the SLOWEST tier still reports at device cadence (${d.mean.toFixed(1)}ms vs ${c.mean.toFixed(1)}ms) — no widening from a sample cap`);
  ok(Math.abs(a.mean - c.mean) < 2,
     `cadence does NOT change with the speed tier (${a.mean.toFixed(1)}ms vs ${c.mean.toFixed(1)}ms) — a device's poll rate is fixed`);
  ok(a.n < b.n && b.n < c.n,
     `the tier changes the SAMPLE COUNT instead (${a.n} < ${b.n} < ${c.n}), which is how a real device encodes a longer movement`);
}

console.log(fail===0 ? "\nALL HUMANIZE UNIT TESTS PASSED" : `\n${fail} TEST(S) FAILED`);
process.exit(fail?1:0);
