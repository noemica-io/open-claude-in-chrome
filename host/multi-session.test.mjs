// Multi-session self-healing tests for mcp-server.js.
//
// Simulates several Claude Code sessions sharing one browser (one native host),
// plus a mock native host, and asserts that killing the primary session does not
// strand the survivors. Each server is spawned with an isolated HOME whose
// config.json pins a private test port, so these tests never touch a real
// instance running on the default port.
//
// Run: npm test   (from host/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "mcp-server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isolatedEnv(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-test-"));
  const cfgDir = path.join(home, ".config", "open-claude-in-chrome");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port }));
  const token = `test-token-${port}`;
  fs.writeFileSync(path.join(cfgDir, "token"), token, { mode: 0o600 });
  return { env: { ...process.env, HOME: home }, home, token };
}

// A stand-in for the browser's native host: a silent TCP client (so the primary
// classifies it as a native host, not a client MCP server) that answers every
// tool_request with MOCK_OK and reconnects if its primary dies.
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

async function startSession(env) {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function toolText(client, timeoutMs = 8000) {
  const res = await Promise.race([
    client.callTool({ name: "tabs_context_mcp", arguments: {} }),
    sleep(timeoutMs).then(() => ({ __timeout: true })),
  ]);
  if (res.__timeout) return "__TIMEOUT__";
  return res.content?.map((c) => c.text).join(" ") ?? JSON.stringify(res);
}

test("a surviving client promotes to primary when the primary dies", async (t) => {
  const PORT = 18831;
  const { env, home, token } = isolatedEnv(PORT);
  const nh = startMockNativeHost(PORT, token);
  t.after(() => { nh.stop(); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

  const a = await startSession(env);        // becomes primary
  t.after(() => a.transport.close().catch(() => {}));
  await sleep(2000);                          // let the native host attach + classify
  const b = await startSession(env);        // becomes client of A
  t.after(() => b.transport.close().catch(() => {}));
  await sleep(1200);

  // Baseline: the client reaches the browser by multiplexing through the primary.
  assert.match(await toolText(b.client), /MOCK_OK/, "client should reach the browser via the primary");

  // Kill the primary session.
  await a.transport.close();
  await sleep(4000); // survivor should re-bind the port and the native host reconnect

  // Without self-healing this returns "Error: Lost connection to primary MCP server".
  assert.match(await toolText(b.client), /MOCK_OK/, "surviving client should self-heal after primary death");
});

test("with two survivors, exactly one takes over and both keep working", async (t) => {
  const PORT = 18832;
  const { env, home, token } = isolatedEnv(PORT);
  const nh = startMockNativeHost(PORT, token);
  t.after(() => { nh.stop(); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

  const a = await startSession(env);
  t.after(() => a.transport.close().catch(() => {}));
  await sleep(2000);
  const b = await startSession(env);
  t.after(() => b.transport.close().catch(() => {}));
  const c = await startSession(env);
  t.after(() => c.transport.close().catch(() => {}));
  await sleep(1500);

  assert.match(await toolText(b.client), /MOCK_OK/);
  assert.match(await toolText(c.client), /MOCK_OK/);

  await a.transport.close();
  await sleep(5000); // one of B/C promotes; the other reconnects to it

  assert.match(await toolText(b.client), /MOCK_OK/, "survivor B should keep working");
  assert.match(await toolText(c.client), /MOCK_OK/, "survivor C should keep working");
});
