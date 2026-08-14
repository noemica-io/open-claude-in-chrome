// Shared runtime for open-claude-in-chrome tools.
//
// Owns the TCP port and the native-host connection, transparently runs in
// primary or client mode (so multiple processes can share one extension),
// and exposes a single `callTool(name, args)` entry point.
//
// This used to live inline in mcp-server.js; it's extracted so that other
// in-process consumers (the codemode + hybrid servers) can call tools
// without going through a child mcp-server.js + stdio MCP roundtrip.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18765;

function getPort() {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "open-claude-in-chrome",
    "config.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();

let mode = "primary"; // or "client"
let started = false;

let nativeHostSocket = null;
const pendingRequests = new Map(); // id -> { resolve, reject, timer, tool, args, resent }
let requestIdCounter = 0;

// Unsolicited upstream events from the extension (not tool responses): the
// imitation-learning recorder posts { type: "recording_complete", ... } when
// a recording finishes. Subscribers (the channel-enabled MCP server) get
// notified so they can inject a channel event into the Claude Code session.
const recordingEventSubscribers = new Set();
export function onRecordingEvent(cb) {
  recordingEventSubscribers.add(cb);
  return () => recordingEventSubscribers.delete(cb);
}
function emitRecordingEvent(msg) {
  for (const cb of recordingEventSubscribers) {
    try {
      cb(msg);
    } catch {}
  }
}
// The channel-enabled server may be running as a CLIENT (another OCIC MCP
// server owns the port as primary). The native host only talks to the primary,
// so the primary must forward recording events to every client too — otherwise
// the process that actually holds the Claude channel never sees them.
function broadcastRecordingEventToClients(msg) {
  const line = JSON.stringify(msg) + "\n";
  for (const socket of clientSockets.values()) {
    try {
      if (socket && !socket.destroyed) socket.write(line);
    } catch {}
  }
}

// Waiters resolved when a fresh native host socket is assigned. Used by the
// disconnect path to recover as soon as the extension reconnects instead of
// blocking on a fixed delay.
const nativeHostWaiters = new Set();

function notifyNativeHostConnected() {
  if (!nativeHostWaiters.size) return;
  const waiters = Array.from(nativeHostWaiters);
  nativeHostWaiters.clear();
  for (const w of waiters) w(true);
}

function waitForNativeHost(maxMs) {
  if (nativeHostSocket && !nativeHostSocket.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      nativeHostWaiters.delete(resolveOnce);
      resolve(false);
    }, maxMs);
    function resolveOnce(ok) {
      clearTimeout(timer);
      resolve(ok);
    }
    nativeHostWaiters.add(resolveOnce);
  });
}

// Primary mode: client (other MCP server process) connections multiplexed
// to the single native host.
const clientSockets = new Map();
let clientIdCounter = 0;
const clientRequestMap = new Map();

// Client mode: TCP connection to whichever process owns the port.
let primarySocket = null;
let clientBuffer = Buffer.alloc(0);

const pidfilePath = path.join(
  os.tmpdir(),
  `open-claude-in-chrome-mcp-${TCP_PORT}.pid`
);

function writePidfile() {
  try {
    fs.writeFileSync(pidfilePath, String(process.pid));
  } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(pidfilePath, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidfilePath);
  } catch {}
}

const tcpServer = net.createServer((socket) => {
  let classified = false;
  let earlyBuffer = Buffer.alloc(0);

  const classifyTimeout = setTimeout(() => {
    if (!classified) {
      classified = true;
      setupNativeHostConnection(socket, earlyBuffer);
    }
  }, 500);

  socket.on("data", function onEarlyData(chunk) {
    if (classified) return;
    earlyBuffer = Buffer.concat([earlyBuffer, chunk]);
    const newlineIdx = earlyBuffer.indexOf(10);
    if (newlineIdx === -1) return;

    const firstLine = earlyBuffer
      .subarray(0, newlineIdx)
      .toString("utf-8")
      .trim();
    try {
      const firstMsg = JSON.parse(firstLine);
      if (firstMsg.type === "client_hello") {
        classified = true;
        clearTimeout(classifyTimeout);
        socket.removeListener("data", onEarlyData);
        setupClientConnection(socket, earlyBuffer.subarray(newlineIdx + 1));
        return;
      }
    } catch {}

    classified = true;
    clearTimeout(classifyTimeout);
    socket.removeListener("data", onEarlyData);
    setupNativeHostConnection(socket, earlyBuffer);
  });
});

function setupNativeHostConnection(socket, initialBuffer) {
  if (nativeHostSocket && !nativeHostSocket.destroyed) {
    socket.end(
      JSON.stringify({
        type: "error",
        error: "Another browser profile is already connected."
      }) + "\n"
    );
    socket.destroy();
    return;
  }

  nativeHostSocket = socket;
  notifyNativeHostConnected();
  let buffer = initialBuffer;

  let idx;
  while ((idx = buffer.indexOf(10)) !== -1) {
    processLine(buffer.subarray(0, idx).toString("utf-8").trim());
    buffer = buffer.subarray(idx + 1);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf(10)) !== -1) {
      processLine(buffer.subarray(0, newlineIdx).toString("utf-8").trim());
      buffer = buffer.subarray(newlineIdx + 1);
    }
  });

  socket.on("error", () => {
    nativeHostSocket = null;
  });

  socket.on("close", () => {
    if (nativeHostSocket === socket) nativeHostSocket = null;
    if (pendingRequests.size === 0) return;
    // Wait for a fresh native host to connect, then resend pending requests
    // through it. Resolves as soon as the new socket appears (typically
    // 50-300ms when the extension's keep-alive alarm reconnects); falls
    // back to failing pending requests after maxMs.
    waitForNativeHost(2000).then((ok) => {
      if (ok && nativeHostSocket && !nativeHostSocket.destroyed) {
        for (const [id, entry] of pendingRequests) {
          if (entry.resent) continue;
          entry.resent = true;
          nativeHostSocket.write(
            JSON.stringify({
              id,
              type: "tool_request",
              tool: entry.tool,
              args: entry.args
            }) + "\n"
          );
        }
      } else {
        for (const [, { reject, timer }] of pendingRequests) {
          clearTimeout(timer);
          reject(new Error("Native host disconnected"));
        }
        pendingRequests.clear();
      }
    });
  });
}

function setupClientConnection(socket, initialBuffer) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, socket);
  process.stderr.write(`Client MCP server connected (client ${clientId})\n`);

  socket.write(JSON.stringify({ type: "client_ack", clientId }) + "\n");

  let buffer = initialBuffer;

  function processClientData() {
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "tool_request" && msg.id) {
          const prefixedId = `c${clientId}_${msg.id}`;
          clientRequestMap.set(prefixedId, { clientId, originalId: msg.id });

          if (!nativeHostSocket || nativeHostSocket.destroyed) {
            socket.write(
              JSON.stringify({
                id: msg.id,
                type: "tool_error",
                error: "Browser extension is not connected."
              }) + "\n"
            );
            clientRequestMap.delete(prefixedId);
          } else {
            nativeHostSocket.write(
              JSON.stringify({ ...msg, id: prefixedId }) + "\n"
            );
          }
        }
      } catch {}
    }
  }

  processClientData();

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processClientData();
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    clientSockets.delete(clientId);
    for (const [prefixedId, info] of clientRequestMap) {
      if (info.clientId === clientId) clientRequestMap.delete(prefixedId);
    }
    process.stderr.write(`Client MCP server disconnected (client ${clientId})\n`);
  });
}

function processLine(line) {
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === "heartbeat") return;
    if (msg.type === "recording_complete") {
      emitRecordingEvent(msg); // this process, if it holds the channel
      broadcastRecordingEventToClients(msg); // any client process that holds it
      return;
    }
    handleResponse(msg);
  } catch {}
}

function handleResponse(msg) {
  if (msg.id && clientRequestMap.has(msg.id)) {
    const { clientId, originalId } = clientRequestMap.get(msg.id);
    clientRequestMap.delete(msg.id);
    const clientSocket = clientSockets.get(clientId);
    if (clientSocket && !clientSocket.destroyed) {
      const fwd = JSON.stringify({ ...msg, id: originalId }) + "\n";
      clientSocket.write(fwd);
    }
    return;
  }

  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function sendToExtension(tool, args) {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Tool request timed out after 60s"));
    }, 60_000);
    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
      tool,
      args,
      resent: false
    });

    if (mode === "primary") {
      if (!nativeHostSocket || nativeHostSocket.destroyed) {
        // Cold-start grace: a freshly-bound primary has a 1.5-2s window
        // before the native host's reconnect loop attaches (hosts retry at
        // 1.5s, plus the 500ms classification timeout). Ephemeral primaries
        // (spawned per claude session) used to fail their FIRST tool call
        // inside that window; wait for the attach instead of rejecting.
        waitForNativeHost(5000).then((ok) => {
          if (pendingRequests.get(id)?.resent) return;
          if (ok && nativeHostSocket && !nativeHostSocket.destroyed) {
            const entry = pendingRequests.get(id);
            if (entry) entry.resent = true;
            nativeHostSocket.write(
              JSON.stringify({ id, type: "tool_request", tool, args }) + "\n"
            );
          } else {
            clearTimeout(timer);
            pendingRequests.delete(id);
            reject(
              new Error(
                "Browser extension is not connected. Make sure a supported Chromium browser is running with the Open Claude in Chrome extension installed and enabled."
              )
            );
          }
        });
        return;
      }
      nativeHostSocket.write(
        JSON.stringify({ id, type: "tool_request", tool, args }) + "\n"
      );
    } else {
      if (!primarySocket || primarySocket.destroyed) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error("Lost connection to primary MCP server."));
        return;
      }
      primarySocket.write(
        JSON.stringify({ id, type: "tool_request", tool, args }) + "\n"
      );
    }
  });
}

function startClientMode() {
  mode = "client";
  process.stderr.write(
    `Port ${TCP_PORT} in use. Connecting as client to primary MCP server...\n`
  );

  function connect() {
    primarySocket = net.createConnection(TCP_PORT, "127.0.0.1", () => {
      process.stderr.write(
        `Connected to primary MCP server on :${TCP_PORT}\n`
      );
      primarySocket.write(JSON.stringify({ type: "client_hello" }) + "\n");
    });

    primarySocket.on("data", (chunk) => {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      let idx;
      while ((idx = clientBuffer.indexOf(10)) !== -1) {
        const line = clientBuffer.subarray(0, idx).toString("utf-8").trim();
        clientBuffer = clientBuffer.subarray(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "client_ack") continue;
          if (msg.type === "error") {
            process.stderr.write(`Primary server error: ${msg.error}\n`);
            continue;
          }
          if (msg.type === "recording_complete") {
            // Forwarded by the primary — fire local subscribers (this client
            // may be the process holding the Claude channel).
            emitRecordingEvent(msg);
            continue;
          }
          if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);
            if (msg.type === "tool_error") {
              reject(new Error(msg.error || "Tool execution failed"));
            } else {
              resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    primarySocket.on("error", (err) => {
      process.stderr.write(`Client connection error: ${err.message}\n`);
    });

    primarySocket.on("close", () => {
      primarySocket = null;
      for (const [, { reject, timer }] of pendingRequests) {
        clearTimeout(timer);
        reject(new Error("Primary MCP server disconnected"));
      }
      pendingRequests.clear();
      // The primary is gone. Reconnecting forever to a port nobody is
      // listening on strands this process permanently (every tool call
      // then fails with "Lost connection to primary MCP server"), so try
      // to take the port ourselves; only fall back to reconnecting if
      // another process wins the election first.
      setTimeout(() => {
        if (mode !== "client" || primarySocket) return;
        const onPromoteError = (err) => {
          if (err.code === "EADDRINUSE") {
            connect(); // another process became primary; join it
          } else {
            process.stderr.write(`Self-promotion failed: ${err.message}\n`);
            setTimeout(connect, 2000);
          }
        };
        tcpServer.once("error", onPromoteError);
        tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
          tcpServer.removeListener("error", onPromoteError);
          mode = "primary";
          writePidfile();
          process.stderr.write(
            `Primary disconnected — promoted self to primary on :${TCP_PORT}\n`
          );
        });
      }, 2000);
    });
  }

  connect();
}

// --- Public API ---

/**
 * Connect to (or become) the shared tool runtime. Safe to call from
 * multiple processes — first to bind the port is primary, others
 * become clients of the primary.
 */
export async function init() {
  if (started) return;
  started = true;

  const pidfiles = [
    pidfilePath,
    path.join(os.tmpdir(), `unblocked-chrome-mcp-${TCP_PORT}.pid`)
  ];
  for (const pf of pidfiles) {
    try {
      const oldPid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
        } catch {
          try {
            fs.unlinkSync(pf);
          } catch {}
        }
      }
    } catch {}
  }

  return new Promise((resolve) => {
    tcpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        startClientMode();
        resolve();
      } else {
        process.stderr.write(`TCP server error: ${err.message}\n`);
        process.exit(1);
      }
    });

    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      mode = "primary";
      writePidfile();
      process.stderr.write(`Primary MCP server listening on :${TCP_PORT}\n`);
      resolve();
    });
  });
}

/**
 * Coerce stringified params that some MCP clients send as strings into
 * the types the extension expects (numbers, arrays). Mutates and
 * returns args.
 */
export function coerceArgs(args) {
  if (!args || typeof args !== "object") return args;
  if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
  if (typeof args.coordinate === "string") {
    try {
      args.coordinate = JSON.parse(args.coordinate);
    } catch {}
  }
  if (typeof args.start_coordinate === "string") {
    try {
      args.start_coordinate = JSON.parse(args.start_coordinate);
    } catch {}
  }
  if (typeof args.region === "string") {
    try {
      args.region = JSON.parse(args.region);
    } catch {}
  }
  return args;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * Call a tool on the extension. Returns an MCP CallToolResult envelope
 * (with text/image/etc. content blocks).
 *
 * Args are coerced (string→number/array) before the call so this is
 * safe to invoke directly with values straight off the MCP wire.
 */
export async function callTool(toolName, args) {
  try {
    const coerced = coerceArgs(args ?? {});
    const result = await sendToExtension(toolName, coerced);
    if (typeof result === "string") return textResult(result);
    if (result && result.content) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

/**
 * Tear down sockets, pidfile, and pending requests. Idempotent.
 * The caller (process owner) handles process.exit().
 */
export function shutdown() {
  if (mode === "primary") cleanupPidfile();
  if (nativeHostSocket && !nativeHostSocket.destroyed) nativeHostSocket.destroy();
  if (primarySocket && !primarySocket.destroyed) primarySocket.destroy();
  for (const [, sock] of clientSockets) {
    if (!sock.destroyed) sock.destroy();
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (mode === "primary") {
    try {
      tcpServer.close();
    } catch {}
  }
}
