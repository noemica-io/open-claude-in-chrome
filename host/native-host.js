#!/usr/bin/env node

// Native Messaging Host for Open Claude in Chrome extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

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

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const TCP_PORT = getPort();

// When the primary rejects us because ANOTHER browser's host already holds
// the native slot, retry slowly (15s) instead of hammering every 1.5s: with
// two browsers running OCIC, the loser otherwise reconnect-spams the primary
// and makes browser selection flap across primary restarts.
let rejectedByPrimary = false;
const RETRY_MS = 1500;
const REJECTED_RETRY_MS = 15000;

function connectTcp() {
  if (tcpSocket) return;

  tcpSocket = new net.Socket();

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  });

  tcpSocket.on("data", (chunk) => {
    // newline-delimited JSON from MCP server
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "error" && /another browser profile/i.test(msg.error || "")) {
          // The primary already has a browser attached; we are the loser of
          // the slot. Back off hard instead of hammering every 1.5s.
          rejectedByPrimary = true;
        }
        // Forward to extension via native messaging
        writeNativeMessage(msg);
      } catch {
        // skip malformed
      }
    }
  });

  tcpSocket.on("error", () => {
    tcpSocket = null;
  });

  tcpSocket.on("close", () => {
    tcpSocket = null;
    if (!reconnectTimer) {
      // Keep retrying indefinitely — do NOT exit when the MCP server is gone.
      // The native host also writes recording bundles to disk (save_recording),
      // which must work with no Claude session connected. Lifetime is tied to
      // the extension (stdin), which ends on browser/extension shutdown below.
      // Rejected-by-primary (another browser holds the slot): slow lane, and
      // re-probe occasionally in case the winner's browser goes away.
      const interval = rejectedByPrimary ? REJECTED_RETRY_MS : RETRY_MS;
      rejectedByPrimary = false;
      reconnectTimer = setInterval(() => {
        if (!tcpSocket) connectTcp();
      }, interval);
    }
  });
}

// --- Recording bundle write ---
// The recorder saves the trace to disk here, in the native host, instead of
// via chrome.downloads — the browser download path shows an OS save dialog on
// some setups, and this also lets us write to a stable location the coding
// agent can open. Returns the absolute directory so the extension can notify
// Claude Code with a real path.
function handleSaveRecording(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "open-claude-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown")
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "trace.json"),
      JSON.stringify(msg.trace ?? {}, null, 2)
    );
    // Ship the schema descriptor alongside so the agent knows how to read it.
    if (typeof msg.schema_md === "string" && msg.schema_md) {
      fs.writeFileSync(path.join(dir, `SCHEMA_${msg.schema || "v0"}.md`), msg.schema_md);
    }
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      path: dir,
      ok: true
    });
  } catch (e) {
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      ok: false,
      error: String(e && e.message)
    });
  }
}

// Overwrite trace.json for a recording (used to persist a re-run transcription
// from the retranscribe path). Same containment as the other handlers.
function handleWriteTrace(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "open-claude-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown")
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "trace.json"),
      JSON.stringify(msg.trace ?? {}, null, 2)
    );
    writeNativeMessage({
      type: "trace_written",
      recording_id: msg.recording_id,
      ok: true
    });
  } catch (e) {
    writeNativeMessage({
      type: "trace_written",
      recording_id: msg.recording_id,
      ok: false,
      error: String(e && e.message)
    });
  }
}

// Write one slice of a recording's audio into audio/NNN.webm. Arrives in
// ~768KB slices (base64 over native messaging) with append=false on the first
// slice of each segment. This is the artifact that makes a failed transcript
// recoverable, so it is written before transcription is even attempted.
function handleSaveAudio(msg) {
  try {
    const rel = String(msg.name || "").replace(/\\/g, "/");
    // Contain the write to the bundle: no absolute paths, no traversal.
    if (rel.startsWith("/") || rel.split("/").includes("..")) return;
    const base = path.join(
      os.homedir(),
      ".config",
      "open-claude-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown")
    );
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.from(String(msg.b64 || ""), "base64");
    if (msg.append) fs.appendFileSync(file, buf);
    else fs.writeFileSync(file, buf);
  } catch {
    // best-effort: the trace is already on disk
  }
}

// Write one 240p frame into the recording's images/ dir. Fire-and-forget:
// the reference is already in the trace, so a dropped frame just means the
// agent finds no file at that ref.
function handleSaveScreenshot(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "open-claude-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown"),
      "images"
    );
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(msg.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    if (b64) fs.writeFileSync(path.join(dir, String(msg.name)), Buffer.from(b64, "base64"));
  } catch {
    // best-effort
  }
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Handle recording saves locally (write to disk + reply); don't forward.
    if (msg && msg.type === "save_recording") {
      handleSaveRecording(msg);
      continue;
    }
    if (msg && msg.type === "save_screenshot") {
      handleSaveScreenshot(msg);
      continue;
    }
    if (msg && msg.type === "save_audio") {
      handleSaveAudio(msg);
      continue;
    }
    if (msg && msg.type === "write_trace") {
      handleWriteTrace(msg);
      continue;
    }
    // Forward everything else to the MCP server via TCP.
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start TCP connection
connectTcp();
