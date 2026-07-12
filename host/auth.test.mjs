// Authentication tests for the local TCP control channel.
//
// Spawns a real primary mcp-server.js plus a mock native host on an isolated
// port (temp HOME with its own config.json + token file, so a real instance is
// never touched) and drives the TCP handshake with raw sockets to prove that a
// peer without the shared token cannot reach the browser.
//
// Run: npm test   (from host/)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "mcp-server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isolatedEnv(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-auth-"));
  const cfgDir = path.join(home, ".config", "open-claude-in-chrome");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port }));
  const token = `test-token-${port}`;
  fs.writeFileSync(path.join(cfgDir, "token"), token, { mode: 0o600 });
  return { env: { ...process.env, HOME: home }, home, token };
}

function startMockNativeHost(port, token) {
  let sock;
  let alive = true;
  function connect() {
    sock = net.createConnection(port, "127.0.0.1", () => {
      sock.write(JSON.stringify({ type: "native_hello", token }) + "\n");
    });
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, i).toString("utf-8").trim();
        buf = buf.subarray(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "tool_request") {
          sock.write(JSON.stringify({
            id: msg.id, type: "tool_response",
            result: { content: [{ type: "text", text: "MOCK_OK" }] },
          }) + "\n");
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (alive) setTimeout(connect, 300); });
  }
  connect();
  return { stop() { alive = false; try { sock.destroy(); } catch {} } };
}

// A raw TCP peer that records what the primary sends back.
function rawPeer(port) {
  const sock = net.createConnection(port, "127.0.0.1");
  const ev = { acked: false, closed: false, errors: [], responses: [] };
  let buf = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, i).toString("utf-8").trim();
      buf = buf.subarray(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "client_ack") ev.acked = true;
      else if (m.type === "error") ev.errors.push(m.error);
      else if (m.type === "tool_response") ev.responses.push(m);
    }
  });
  sock.on("close", () => { ev.closed = true; });
  sock.on("error", () => {});
  return { ev, send: (o) => sock.write(JSON.stringify(o) + "\n"), end: () => sock.destroy() };
}

describe("control-channel authentication", () => {
  const PORT = 18841;
  const { env, home, token } = isolatedEnv(PORT);
  let nh, primary;

  before(async () => {
    nh = startMockNativeHost(PORT, token);
    primary = spawn("node", [SERVER], { env, stdio: ["pipe", "ignore", "ignore"] });
    await sleep(2500); // primary binds the port and the native host authenticates
  });

  after(() => {
    try { primary.kill(); } catch {}
    nh.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("rejects a client that presents the wrong token", async () => {
    const peer = rawPeer(PORT);
    peer.send({ type: "client_hello", token: "not-the-token" });
    await sleep(800);
    assert.equal(peer.ev.acked, false, "must not acknowledge a wrong-token client");
    assert.equal(peer.ev.closed, true, "must close a wrong-token connection");

    // Even if it tries anyway, a rejected peer must not reach the browser.
    peer.send({ type: "tool_request", id: "x", tool: "tabs_context_mcp", args: {} });
    await sleep(500);
    assert.equal(peer.ev.responses.length, 0, "a rejected peer must not reach the browser");
  });

  it("rejects a peer that never authenticates", async () => {
    const peer = rawPeer(PORT); // connects but sends no hello
    await sleep(2600); // past the 2s hello timeout
    assert.equal(peer.ev.closed, true, "a silent peer must be dropped");

    // And the silent peer must not have stolen the native host slot: a valid
    // client can still drive the browser.
    const good = rawPeer(PORT);
    good.send({ type: "client_hello", token });
    await sleep(400);
    good.send({ type: "tool_request", id: "1", tool: "tabs_context_mcp", args: {} });
    await sleep(1000);
    assert.ok(
      good.ev.responses.some((r) => JSON.stringify(r).includes("MOCK_OK")),
      "a valid client should still reach the browser after a silent peer connected"
    );
    good.end();
  });

  it("accepts a client with the correct token and routes tool calls", async () => {
    const peer = rawPeer(PORT);
    peer.send({ type: "client_hello", token });
    await sleep(400);
    assert.equal(peer.ev.acked, true, "a valid client should be acknowledged");

    peer.send({ type: "tool_request", id: "42", tool: "tabs_context_mcp", args: {} });
    await sleep(1000);
    assert.ok(
      peer.ev.responses.some((r) => JSON.stringify(r).includes("MOCK_OK")),
      "a valid client should reach the browser"
    );
    peer.end();
  });
});
