// javascript_tool against a REAL V8 inspector: the shipped handler body runs with
// its cdp() pointed at node:inspector, so every Runtime.evaluate parameter
// (replMode, awaitPromise, returnByValue) is interpreted by the same inspector
// code Chrome uses — no hand-written CDP responses to drift from reality.
import inspector from "node:inspector";
import { extractMethod, compile } from "./_extract.mjs";
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS ":"  FAIL ")+m); if(!c)fail++;};

const session = new inspector.Session();
session.connect();
const cdp = (_tabId, method, params = {}) => new Promise((resolve, reject) =>
  session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));

const H = compile(`const H = { ${extractMethod("javascript_tool")} };`, {
  isInGroup: async () => true,
  ensureAttached: async () => {},
  recordTiming: () => {},
  cdp
}, "H");

const run = async (text) => (await H.javascript_tool({ text, tabId: 1 })).content[0].text;

console.log("== top-level await (REPL semantics) ==");
ok(await run("const v = await Promise.resolve(42); v") === "42",
  "awaited value of the last expression is returned");

console.log("== top-level return falls back to an async function body ==");
ok(await run("const v = await Promise.resolve(7); return v + 1") === "8",
  "a body with `return` runs once as an async function and returns its value");

console.log("== plain expression ==");
ok(await run("({ a: 1, b: [2, 3] })") === '{"a":1,"b":[2,3]}', "object literal serialized by value");

console.log("== declarations do not leak between calls ==");
await run("const leaked = 1; leaked");
ok(await run("typeof leaked") === '"undefined"', "a const from one call is not visible to the next");

console.log("== a SyntaxError thrown at RUNTIME is not retried ==");
// eval throws the very message the fallback keys on, but only after the code
// before it has run; retrying would run that code a second time.
globalThis.__runs = 0;
const out = await run('globalThis.__runs++; eval("return 1")');
ok(globalThis.__runs === 1, `code with side effects ran exactly once (ran ${globalThis.__runs}x)`);
ok(out.startsWith("Error:") && out.includes("SyntaxError"), `reports the SyntaxError: ${out.split("\n")[0]}`);

console.log("== thrown errors carry their message ==");
const boom = await run('throw new Error("boom")');
ok(boom.startsWith("Error:") && boom.includes("boom"), `message surfaces: ${boom.split("\n")[0]}`);

session.disconnect();
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");
