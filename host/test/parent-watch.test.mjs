#!/usr/bin/env node
//
// Does the reaper leave a healthy server alone?
//
// This is the test that was missing. Every other check in this repo is a
// sub-second round trip, and the reaper's first tick is at 30s with its second
// check at 5 minutes — so nothing that finished quickly could ever reach the
// code that kills. The timings are env-tunable precisely so this can run the
// same paths in seconds.
//
// The asymmetry that matters: reaping late costs a leaked process, reaping a
// live session costs the user their browser mid-task. So the cases below are
// weighted accordingly — most of them assert that nothing happens.
//
// Run: node host/test/parent-watch.test.mjs

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "watched-child.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}  (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A child running the real watchParent, with fast timings.
function spawnWatched({ checkMs = 200, identityEvery = 2 } = {}) {
  const proc = spawn(process.execPath, [CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OCIC_PARENT_CHECK_MS: String(checkMs),
      OCIC_IDENTITY_EVERY: String(identityEvery)
    }
  });
  const err = [];
  proc.stderr.on("data", (c) => err.push(c.toString()));
  let exited = null;
  proc.on("exit", (code) => {
    exited = code ?? 0;
  });
  return {
    proc,
    stderrText: () => err.join(""),
    get exited() {
      return exited;
    }
  };
}

console.log("\nParent watch\n");

await test("leaves a child alone while its parent is alive and healthy", async () => {
  // 200ms ticks with identity every 2 ticks: 6 seconds is 30 liveness checks
  // and 15 identity checks — the equivalent of ~75 minutes in production.
  const w = spawnWatched();
  await sleep(6000);
  assert(
    w.exited === null,
    `child exited (code ${w.exited}) with a healthy parent. stderr: ${w.stderrText().slice(0, 300)}`
  );
  assert(
    !/Parent process is gone/.test(w.stderrText()),
    `reaper fired against a live parent: ${w.stderrText().slice(0, 300)}`
  );
  w.proc.kill();
});

await test("survives many identity re-checks without drift", async () => {
  // The identity check compares the parent's creation time against our own
  // start. A sign error, a timezone slip, or a bad FILETIME conversion all
  // show up here as a child that dies on the first identity tick.
  const w = spawnWatched({ checkMs: 150, identityEvery: 1 }); // identity EVERY tick
  await sleep(5000); // ~33 identity checks
  assert(
    w.exited === null,
    `child died during identity checks (code ${w.exited}): ${w.stderrText().slice(0, 300)}`
  );
  w.proc.kill();
});

await test("still exits when the parent really is gone", async () => {
  // The reaper has to keep working — a test suite that only proves it never
  // fires would pass with the whole thing deleted.
  const runner = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require("node:child_process");
       const c=spawn(process.execPath,[${JSON.stringify(CHILD)}],{stdio:["pipe","pipe","pipe"],detached:true,
         env:{...process.env,OCIC_PARENT_CHECK_MS:"200",OCIC_IDENTITY_EVERY:"2"}});
       console.log(c.pid);
       setInterval(()=>{},1<<30);`
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  const grandchildPid = await new Promise((resolve) =>
    runner.stdout.once("data", (d) => resolve(Number(d.toString().trim())))
  );
  await sleep(500);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert(alive(grandchildPid), "grandchild never started");

  // Kill the parent WITHOUT touching the child (no /T), so only the reaper can
  // end it.
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(runner.pid), "/F"], { stdio: "ignore" });
  } else {
    process.kill(runner.pid, "SIGKILL");
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && alive(grandchildPid)) await sleep(250);
  assert(!alive(grandchildPid), "orphan outlived its parent — the reaper did not fire");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length
      ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}`
      : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
