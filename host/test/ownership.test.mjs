#!/usr/bin/env node
//
// Ownership tests for the browser bridge.
//
// These run the REAL native-host.js and the REAL tool-runtime.js against a fake
// extension and fake MCP clients, on a scratch pipe, so the whole ownership
// story can be exercised without Chrome and without disturbing a live install.
//
// The fake extension speaks Chrome's native messaging framing (4-byte LE length
// + JSON) over the host's stdio, which is the only contract the real extension
// has with the host — so a pass here means background.js would be equally
// happy, and no extension reload is involved.
//
// Run: node host/test/ownership.test.mjs

import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, "..", "native-host.js");
const SESSION = path.join(HERE, "runtime-client.mjs");

let seq = 0;
let PIPE = "";

const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-test-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-test-${process.pid}-${n}.sock`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fake extension: drives native-host.js exactly as Chrome would ---

function fakeExtension(pipe = PIPE) {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const handlers = [];
  const stderr = [];
  let buf = Buffer.alloc(0);

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      buf = buf.subarray(4 + len);
      for (const h of handlers) h(msg);
    }
  });
  proc.stderr.on("data", (c) => stderr.push(c.toString()));

  return {
    proc,
    stderrText: () => stderr.join(""),
    onMessage: (cb) => handlers.push(cb),
    send(msg) {
      const body = Buffer.from(JSON.stringify(msg), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    // Answer every tool_request with a result derived from the request, so a
    // client can prove it got back its OWN response and not someone else's.
    autoRespond(transform = (m) => ({ echo: m.tool, args: m.args })) {
      handlers.push((msg) => {
        if (msg.type === "tool_request") {
          this.send({ id: msg.id, result: transform(msg) });
        }
      });
    },
    kill: () => proc.kill(),
    // Close stdin the way Chrome does when the extension disconnects.
    disconnect: () => proc.stdin.end()
  };
}

// --- Fake MCP client: the wire role tool-runtime.js plays ---

function fakeClient(pipe, name) {
  const socket = net.createConnection(pipe);
  const pending = new Map();
  const received = [];
  let idc = 0;
  let buf = Buffer.alloc(0);
  let closed = false;

  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf-8").trim();
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      received.push(msg);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const ready = new Promise((resolve) => {
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "client_hello" }) + "\n");
      resolve();
    });
  });

  return {
    name,
    ready,
    isClosed: () => closed,
    received,
    call(tool, args = {}, timeoutMs = 3000) {
      const id = String(++idc);
      socket.write(
        JSON.stringify({ id, type: "tool_request", tool, args }) + "\n"
      );
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${name}: ${tool} timed out`));
          }
        }, timeoutMs);
      });
    },
    // Vanish without a FIN, the way a force-killed session's socket does.
    hardKill: () => socket.destroy(),
    close: () => socket.end()
  };
}

// Is anyone serving the bridge? Only a live listener accepts, so this cannot be
// fooled by a leftover socket path.
function bridgeIsHeld(pipe) {
  return new Promise((resolve) => {
    const probe = net.createConnection(pipe);
    const done = (v) => {
      probe.destroy();
      resolve(v);
    };
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

async function waitFor(fn, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

// --- Test registry ---

const results = [];
async function test(name, fn) {
  PIPE = pipeFor(++seq); // every test gets its own address
  const started = Date.now();
  try {
    await fn(PIPE);
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}  (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------

console.log("\nBrowser-bridge ownership\n");

await test("host claims a free bridge and reports itself as owner", async (pipe) => {
  const ext = fakeExtension();
  await waitFor(
    async () => /owns the bridge at/.test(ext.stderrText()),
    5000,
    "host announces ownership"
  );
  assert(await bridgeIsHeld(pipe), "bridge should be served by the host");
  ext.kill();
});

await test("a client's request reaches the extension and the reply comes back", async (pipe) => {
  const ext = fakeExtension();
  ext.autoRespond();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const c = fakeClient(pipe, "c1");
  await c.ready;
  const reply = await c.call("navigate", { url: "https://example.com" });
  assert(reply.result?.echo === "navigate", `unexpected reply ${JSON.stringify(reply)}`);
  assert(reply.id === "1", `id should be de-prefixed back to the client's own, got ${reply.id}`);
  c.close();
  ext.kill();
});

await test("concurrent clients each get only their own responses", async (pipe) => {
  const ext = fakeExtension();
  // Echo the tool name back so a crossed wire is detectable.
  ext.autoRespond((m) => ({ forTool: m.tool }));
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(fakeClient(pipe, `c${i}`));
  await Promise.all(clients.map((c) => c.ready));

  const replies = await Promise.all(
    clients.map((c, i) => c.call(`tool_${i}`, { n: i }))
  );
  replies.forEach((r, i) => {
    assert(
      r.result?.forTool === `tool_${i}`,
      `client ${i} got a response meant for ${r.result?.forTool}`
    );
  });
  clients.forEach((c) => c.close());
  ext.kill();
});

await test("a client that vanishes mid-request does not take the host down", async (pipe) => {
  const ext = fakeExtension();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const survivor = fakeClient(pipe, "survivor");
  await survivor.ready;

  // 20 clients that connect and are destroyed without a clean close — the
  // exact shape that killed the old primary with an unhandled ECONNRESET.
  for (let i = 0; i < 20; i++) {
    const doomed = fakeClient(pipe, `doomed${i}`);
    doomed.call("computer", {}).catch(() => {});
    doomed.hardKill();
  }
  // Also connect-and-die without ever saying hello, inside the classify window.
  for (let i = 0; i < 20; i++) {
    const silent = net.createConnection(pipe);
    silent.on("error", () => {});
    silent.on("connect", () => silent.destroy());
  }

  await sleep(400);
  assert(ext.proc.exitCode === null, "host process died");
  assert(!survivor.isClosed(), "survivor lost its connection");

  ext.autoRespond();
  const reply = await survivor.call("still_alive");
  assert(reply.result?.echo === "still_alive", "host stopped serving after the churn");
  survivor.close();
  ext.kill();
});

await test("the host forgets clients that go away", async (pipe) => {
  // A live host was found holding 28 client entries, far more than the number
  // of sessions that had ever existed. If entries survive their sockets the
  // table grows for the life of the browser, and every recording broadcast
  // walks a list mostly made of corpses.
  const ext = fakeExtension();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const clients = [];
  for (let i = 0; i < 12; i++) clients.push(fakeClient(pipe, `c${i}`));
  await Promise.all(clients.map((c) => c.ready));
  await waitFor(
    async () => /attached \(12 total\)/.test(ext.stderrText()),
    5000,
    "host counts 12 attached"
  );

  // Half leave politely, half vanish without a FIN.
  clients.slice(0, 6).forEach((c) => c.close());
  clients.slice(6).forEach((c) => c.hardKill());

  await waitFor(
    async () => /detached \(0 left\)/.test(ext.stderrText()),
    5000,
    "host drops back to 0 clients — entries did not leak"
  );
  ext.kill();
});

await test("stale clients cannot block a fresh host from owning the bridge", async (pipe) => {
  // The #41 scenario: sessions died long ago but their MCP processes live on.
  // Under host-owned ownership they are only clients, so they hold nothing.
  const ext = fakeExtension();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");
  const stale = [];
  for (let i = 0; i < 30; i++) stale.push(fakeClient(pipe, `stale${i}`));
  await Promise.all(stale.map((o) => o.ready));

  // Browser restarts: old host goes away, a new one starts with the stale
  // clients still attached and still holding their sockets open.
  ext.disconnect();
  await waitFor(async () => !(await bridgeIsHeld(pipe)), 5000, "old host releases");

  const ext2 = fakeExtension();
  ext2.autoRespond();
  await waitFor(
    async () => /owns the bridge at/.test(ext2.stderrText()),
    5000,
    "new host claims the bridge despite 30 stale clients"
  );

  const fresh = fakeClient(pipe, "fresh");
  await fresh.ready;
  const reply = await fresh.call("navigate");
  assert(reply.result?.echo === "navigate", "new host not serving");
  fresh.close();
  ext2.kill();
});

await test("host releases the bridge the moment the extension disconnects", async (pipe) => {
  const ext = fakeExtension();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");
  ext.disconnect();
  await waitFor(async () => !(await bridgeIsHeld(pipe)), 5000, "bridge freed on disconnect");
});

await test("recording_complete fans out to every attached client", async (pipe) => {
  const ext = fakeExtension();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");
  const clients = [fakeClient(pipe, "a"), fakeClient(pipe, "b"), fakeClient(pipe, "c")];
  await Promise.all(clients.map((c) => c.ready));
  await sleep(100);

  ext.send({ type: "recording_complete", recording_id: "r1", path: "/tmp/r1" });
  await sleep(300);
  for (const c of clients) {
    assert(
      c.received.some((m) => m.type === "recording_complete" && m.recording_id === "r1"),
      `${c.name} never saw the recording event`
    );
  }
  clients.forEach((c) => c.close());
  ext.kill();
});

await test("a real session joins the host instead of owning anything", async (pipe) => {
  const ext = fakeExtension();
  ext.autoRespond();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const session = spawn(process.execPath, [SESSION], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const err = [];
  session.stderr.on("data", (c) => err.push(c.toString()));
  await waitFor(
    async () => /Joined the browser bridge/.test(err.join("")),
    8000,
    "session joins the bridge"
  );
  session.kill();
  ext.kill();
});

await test("a session survives the host being respawned under it", async (pipe) => {
  // Chrome recycles the service worker routinely, which takes the host with it.
  // A session must reconnect on its own rather than needing a restart.
  const ext = fakeExtension();
  ext.autoRespond();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host serving");

  const c = fakeClient(pipe, "before");
  await c.ready;
  assert((await c.call("navigate")).result?.echo === "navigate", "not serving before");

  ext.disconnect();
  await waitFor(async () => !(await bridgeIsHeld(pipe)), 5000, "host gone");

  const ext2 = fakeExtension();
  ext2.autoRespond();
  await waitFor(async () => await bridgeIsHeld(pipe), 5000, "host back");

  const c2 = fakeClient(pipe, "after");
  await c2.ready;
  assert((await c2.call("navigate")).result?.echo === "navigate", "not serving after respawn");
  c2.close();
  ext2.kill();
});

await test("a session started before the browser reconnects when it appears", async (pipe) => {
  // The real sequence that broke a session today: the MCP server came up while
  // no browser was running, so it sat in its reconnect loop for five minutes —
  // hundreds of failed connects — before a host finally appeared. Every other
  // test here hands the session a host that already exists, so this path, the
  // one an ordinary user hits every time they open their editor before their
  // browser, had never been exercised at all.
  const session = spawn(process.execPath, [SESSION], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const err = [];
  session.stderr.on("data", (c) => err.push(c.toString()));

  // Long enough for many retry cycles against nothing.
  await sleep(6000);
  assert(session.exitCode === null, `session died while waiting: ${err.join("").slice(0, 300)}`);
  assert(
    !/Joined the browser bridge/.test(err.join("")),
    "session claims it joined a bridge that does not exist"
  );

  const ext = fakeExtension();
  ext.autoRespond();
  await waitFor(
    async () => /Joined the browser bridge/.test(err.join("")),
    8000,
    "session reconnects once the host appears"
  );

  // And it must actually work, not just report a connection.
  const c = fakeClient(pipe, "alongside");
  await c.ready;
  assert((await c.call("navigate")).result?.echo === "navigate", "bridge not serving");
  c.close();
  session.kill();
  ext.kill();
});

await test("a waiting host takes over promptly when the owner releases", async (pipe) => {
  // This is the switch_browser hand-off. background.js drops the outgoing
  // browser's host and suspends reconnect for SWITCH_RELEASE_MS (15s); the
  // incoming browser only gets the bridge if it probes inside that window. A
  // host that backed off to a 15s retry on its first EADDRINUSE would land
  // there by luck, so the reclaim has to be well inside the window.
  const owner = fakeExtension();
  await waitFor(
    async () => /owns the bridge at/.test(owner.stderrText()),
    5000,
    "first host owns the bridge"
  );

  const waiting = fakeExtension();
  await sleep(2500); // long enough that a 15s backoff would still be sleeping
  assert(
    !/owns the bridge at/.test(waiting.stderrText()),
    "second host claimed a bridge that was still held"
  );

  const releasedAt = Date.now();
  owner.disconnect();
  await waitFor(
    async () => /owns the bridge at/.test(waiting.stderrText()),
    8000,
    "waiting host takes over"
  );
  const took = Date.now() - releasedAt;
  assert(took < 5000, `took ${took}ms to reclaim — outside the 15s switch window`);

  waiting.autoRespond();
  const c = fakeClient(pipe, "after-switch");
  await c.ready;
  const reply = await c.call("navigate");
  assert(reply.result?.echo === "navigate", "new owner not serving after hand-off");
  c.close();
  waiting.kill();
});

// ---------------------------------------------------------------------------

// On POSIX a unix socket outlives its process, so a run would otherwise leave
// one file per test behind in the temp dir.
if (process.platform !== "win32") {
  const { unlinkSync } = await import("node:fs");
  for (let i = 1; i <= seq; i++) {
    try {
      unlinkSync(pipeFor(i));
    } catch {}
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
