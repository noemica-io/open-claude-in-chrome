#!/usr/bin/env node
//
// Stress the bridge under real conditions. Manual, not part of `npm test`:
// it needs a running browser and it launches real `claude -p` sessions, which
// cost tokens.
//
//   node host/test/stress.mjs [minutes] [maxChurnSessions]
//
// The automated suite spawns servers from a Node parent. Real machines don't
// look like that: Claude Code spawns them from claude.exe, and sessions churn
// constantly, each dragging a wrangler tree up and down. Under the old design
// that churn is what produced stranding — the browser link belonged to whichever
// session had booted first, so an unrelated session exiting took it away.
//
// So this holds one long-lived "victim" server that must survive, makes real
// browser calls through it, and churns real sessions around it. What it asserts
// is the property the ownership change was for: an incumbent is not disturbed by
// other sessions arriving and leaving.
//
// Failure looks like: victim exits, calls start failing, the pipe drops, or the
// native host restarts. All four are sampled every 5s and printed.

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const SERVER = path.join(HERE, "..", "codemode", "server-hybrid.js");

const MINUTES = Number(process.argv[2]) || 5;
const MAX_CHURN = Number(process.argv[3]) || 14;
const TICKS = Math.round((MINUTES * 60) / 5);

const t0 = Date.now();
const log = (m) =>
  console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`);

function snapshot() {
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
      return out.split("\n").filter((l) => /native-host|server-hybrid|mcp-server/.test(l))
        .map((l) => {
          const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) return null;
          const kind = /native-host/.test(m[3]) ? "host" : /server-hybrid/.test(m[3]) ? "hybrid" : "mcp";
          return { pid: Number(m[1]), kind };
        }).filter(Boolean);
    } catch { return []; }
  }
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'native-host|server-hybrid|mcp-server' }) | ForEach-Object { "{0}|{1}" -f $_.ProcessId, $(if($_.CommandLine -match 'native-host'){'host'}elseif($_.CommandLine -match 'server-hybrid'){'hybrid'}else{'mcp'}) }`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 20000
    }).trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [pid, kind] = l.split("|");
      return { pid: Number(pid), kind };
    });
  } catch { return []; }
}

// --- the victim: must survive the whole run ---
const victim = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
let victimDied = null;
victim.on("exit", (code, sig) => {
  victimDied = `code=${code} sig=${sig}`;
  log(`*** VICTIM DIED ${victimDied} ***`);
});
victim.stderr.on("data", (c) => {
  const s = c.toString().trim();
  if (/Joined the browser bridge|Error|error/.test(s)) log(`victim: ${s.slice(0, 150)}`);
});
victim.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stress", version: "1" } }
}) + "\n");
victim.stdout.once("data", () =>
  victim.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
);

const calls = { ok: 0, fail: 0 };
let buf = "";
victim.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id >= 100) {
        const txt = m.result?.content?.[0]?.text ?? "";
        if (txt.includes("availableTabs")) calls.ok++;
        else { calls.fail++; log(`CALL FAILED: ${txt.slice(0, 120)}`); }
      }
    } catch {}
  }
});

let launched = 0;
function churn() {
  if (launched >= MAX_CHURN) return;
  launched++;
  const p = spawn("claude", ["-p", "Reply with exactly: OK"], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"], shell: true
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
}

const hostPids = new Set();
let ticks = 0;
const iv = setInterval(() => {
  ticks++;
  const rows = snapshot();
  const hosts = rows.filter((r) => r.kind === "host");
  hosts.forEach((h) => hostPids.add(h.pid));
  log(`t=${ticks * 5}s hosts=${hosts.length} hybrids=${rows.filter((r) => r.kind === "hybrid").length} victim=${victimDied ? "DEAD" : "alive"} calls ok=${calls.ok} fail=${calls.fail}`);

  if (ticks % 3 === 0) {
    try {
      victim.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 100 + ticks, method: "tools/call",
        params: { name: "tabs_context_mcp", arguments: {} }
      }) + "\n");
    } catch (e) { log(`victim write failed: ${e.message}`); }
  }
  if (ticks % 4 === 1) { churn(); churn(); }

  if (ticks >= TICKS) {
    clearInterval(iv);
    const ok = !victimDied && calls.fail === 0 && hostPids.size <= 1;
    log(`=== ${ok ? "PASS" : "FAIL"}: victim ${victimDied ? "DIED (" + victimDied + ")" : "survived"}, ` +
        `calls ok=${calls.ok} fail=${calls.fail}, host restarts=${Math.max(0, hostPids.size - 1)}, ` +
        `churned ${launched} sessions ===`);
    try { victim.kill(); } catch {}
    process.exit(ok ? 0 : 1);
  }
}, 5000);
