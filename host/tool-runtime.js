// Shared runtime for open-claude-in-chrome tools.
//
// Joins the browser bridge as a client and exposes a single
// `callTool(name, args)` entry point. The bridge is owned by the native host,
// which Chrome starts and stops with the extension, so this process never has
// to own anything, elect anything, or care who else is attached.
//
// It used to be far more than this: every consumer raced to bind a TCP port,
// and the winner multiplexed all the others through itself. That made an
// ordinary Claude Code session load-bearing for the whole machine. All of it —
// the election, the yield protocol, the peer-classification sniff, the
// self-promotion path, the pidfile — existed to manage a role nobody should
// have had, and went away with it.
//
// This used to live inline in mcp-server.js; it's extracted so that other
// in-process consumers (the codemode + hybrid servers) can call tools
// without going through a child mcp-server.js + stdio MCP roundtrip.

import net from "node:net";

import { getPipePath } from "./endpoint.js";
import { noteActivity } from "./parent-watch.js";
import { startFirefoxWithAutomation } from "./firefox-launch.js";
import { createWorkflows } from "./workflows.js";
import { WORKFLOWS_ENABLED } from "./tool-definitions.js";

const PIPE_PATH = getPipePath();

const REQUEST_TIMEOUT_MS = 60_000;
// The host dies and respawns whenever Chrome recycles the service worker, and
// background.js reconnects 250ms later. A call landing in that window should
// wait for the bridge to come back rather than fail.
const LINK_GRACE_MS = 5_000;
const RECONNECT_MS = 500;

let started = false;
let socket = null;
let readBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let shuttingDown = false;
let requestIdCounter = 0;

const pendingRequests = new Map(); // id -> { resolve, reject, timer, sent }

// Returned when the bridge drops with a request still in flight. Deliberately
// does NOT claim the action failed: the request may have reached the browser
// and run, with only the response lost. The wording has to leave the agent able
// to act — verify, then decide — rather than blindly retry.
const HOST_DROPPED_ERROR =
  "Browser connection dropped after the request was sent, so its result is unknown. " +
  "The action may have ALREADY taken effect in the browser. Do not blindly retry: " +
  "check the current page state first (e.g. take a screenshot or read the page), " +
  "then repeat the action only if it did not happen.";

const NO_BRIDGE_ERROR =
  "Browser extension is not connected. Make sure a supported browser (Chrome, Brave, " +
  "Edge or another Chromium browser, or Firefox) is running with the Open Claude in " +
  "Chrome extension installed and enabled.";

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

const linkIsUp = () => socket && !socket.destroyed && socket.readyState === "open";

// Wait for the bridge to come back, for callers that arrived while the host was
// being respawned.
function waitForLink(maxMs) {
  if (linkIsUp()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (linkIsUp()) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt >= maxMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
}

function handleMessage(msg) {
  if (msg.type === "client_ack") return;
  if (msg.type === "recording_complete") {
    emitRecordingEvent(msg);
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

function connect() {
  if (shuttingDown) return;
  reconnectTimer = null;

  const sock = net.createConnection(PIPE_PATH);
  socket = sock;
  readBuffer = Buffer.alloc(0);
  let established = false;

  sock.on("connect", () => {
    established = true;
    sock.write(JSON.stringify({ type: "client_hello" }) + "\n");
    process.stderr.write(`Joined the browser bridge at ${PIPE_PATH}\n`);
  });

  sock.on("data", (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    let idx;
    while ((idx = readBuffer.indexOf(10)) !== -1) {
      const line = readBuffer.subarray(0, idx).toString("utf-8").trim();
      readBuffer = readBuffer.subarray(idx + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  });

  // Nothing to report for a connect that simply found no host: that is the
  // ordinary state when the browser is not running, and the close handler
  // schedules the retry.
  sock.on("error", (err) => {
    if (established) process.stderr.write(`Bridge error: ${err.message}\n`);
  });

  sock.on("close", () => {
    if (socket === sock) socket = null;
    failPending();
    if (!shuttingDown && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }
  });
}

// Settle everything in flight when the link drops.
//
// A request that was actually written may have reached the browser and run,
// with only its response lost — replaying it would silently double-execute the
// action (a click clicks twice) while the agent sees one successful call. There
// is no way to tell "never ran" from "ran, response lost" at this layer, so
// those fail loudly and let the agent decide with page context. A request still
// waiting for the link never went anywhere, so it can say so plainly.
function failPending() {
  if (pendingRequests.size === 0) return;
  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timer);
    entry.reject(new Error(entry.sent ? HOST_DROPPED_ERROR : NO_BRIDGE_ERROR));
  }
  pendingRequests.clear();
}

function sendToExtension(tool, args, type = "tool_request") {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Tool request timed out after 60s"));
    }, REQUEST_TIMEOUT_MS);
    const entry = { resolve, reject, timer, sent: false };
    pendingRequests.set(id, entry);

    const line = JSON.stringify({ id, type, tool, args }) + "\n";

    if (linkIsUp()) {
      entry.sent = true;
      socket.write(line);
      return;
    }

    waitForLink(LINK_GRACE_MS).then((ok) => {
      // Only dispatch if still pending: the entry is gone once the promise has
      // settled some other way, and sending then would run an action nobody is
      // waiting on.
      if (!pendingRequests.has(id)) return;
      if (ok && linkIsUp()) {
        entry.sent = true;
        socket.write(line);
        return;
      }
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error(NO_BRIDGE_ERROR));
    });
  });
}

// --- Public API ---

/**
 * Join the browser bridge. Returns as soon as the first connection attempt has
 * been made — deliberately not once it succeeds, because the MCP server has to
 * come up and advertise its tools whether or not a browser is running. Calls
 * made before the bridge is up get the grace period in sendToExtension.
 */
export async function init() {
  if (started) return;
  started = true;
  connect();
}

// Start Firefox with its automation port, or restart it that way. With no
// browser connected there is nothing to lose, so it just launches one. With one
// connected, the host tells us which process it is and we replace it; the
// caller is expected to have asked the user first (see the tool description).
async function restartBrowser() {
  let pid;
  if (linkIsUp()) {
    ({ pid } = await sendToExtension("browser_info", {}, "browser_info"));
  }
  const started = await startFirefoxWithAutomation({ pid });
  // The new Firefox starts a new native host, which owns a new bridge; we
  // reconnect on our own, so just wait for it to be usable.
  const back = await waitForLink(30_000);
  return started + (back
    ? " The extension has reconnected; tools are ready."
    : " The extension has not reconnected yet; retry in a few seconds.");
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
// One call to the extension, as an MCP result envelope. Not journaled: this is
// also what workflow replay and its in-page probes go through.
async function dispatch(toolName, args) {
  try {
    const result = await sendToExtension(toolName, coerceArgs(args ?? {}));
    if (typeof result === "string") return textResult(result);
    if (result && result.content) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

const workflows = WORKFLOWS_ENABLED ? createWorkflows(dispatch) : null;

export async function callTool(toolName, args) {
  noteActivity();
  try {
    // Handled here, not by the extension: it restarts the browser the
    // extension lives in.
    if (toolName === "restart_browser") return textResult(await restartBrowser());
    if (workflows && toolName === "workflow_save") return textResult(workflows.save(coerceArgs(args ?? {})));
    if (workflows && toolName === "workflow_run") return await workflows.run(coerceArgs(args ?? {}));
    const coerced = coerceArgs(args ?? {});
    const pre = workflows ? await workflows.before(toolName, coerced) : null;
    const result = await dispatch(toolName, coerced);
    if (workflows) {
      workflows.after(toolName, coerced, result, pre);
      if (toolName === "tabs_context_mcp" || toolName === "tabs_create_mcp") {
        const note = workflows.listing();
        if (note && result.content?.[0]?.type === "text") result.content[0].text += "\n\n" + note;
      }
    }
    return result;
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

/**
 * Tear down the connection and pending requests. Idempotent.
 * The caller (process owner) handles process.exit().
 */
export function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (socket && !socket.destroyed) socket.destroy();
  socket = null;
}
