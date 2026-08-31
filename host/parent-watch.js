// Exit when the session that started us is gone.
//
// An MCP server is only ever useful to the process that spawned it. When that
// process dies, this one should follow — and normally it does, because closing
// the last handle to our stdin gives us EOF. On this machine that failed often
// enough to leave 156 of these processes alive at once, holding ~9GB between
// them, some parented to PIDs Windows had already recycled onto unrelated
// programs.
//
// EOF is still the fast path and still fires on an abrupt parent kill (measured
// here at ~1s). What defeats it is a duplicated handle: if any other live
// process holds a copy of our stdin write end, the pipe never reaches EOF no
// matter what happened to our parent. Nothing we do on this side can close
// someone else's handle, so we need a signal that does not run through the pipe
// at all — hence watching the parent directly.
//
// The catch is that a PID is not an identity. Windows recycles them, and
// process.ppid is a snapshot taken at creation, so "is my parent still alive?"
// can be answered yes by a program that has nothing to do with us. The way out
// is that a recycled PID always belongs to a process created AFTER us: a real
// parent must be older than its child. So liveness is checked often and cheaply
// (a signal-0 probe), and identity is re-confirmed occasionally against that
// rule, which costs one query and cannot be fooled by reuse.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An MCP server's stderr is captured by its client, and a process.exit() can
// truncate the last write before it is flushed — so "the reaper printed no
// message" is not evidence the reaper stayed quiet. Leave a breadcrumb on disk
// instead, the way the native host does, so the question is answerable.
function recordExit(reason) {
  try {
    const file = path.join(
      os.homedir(),
      ".config",
      "open-claude-in-chrome",
      "server-exits.log"
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${reason}\n`;
    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf-8");
    } catch {}
    fs.writeFileSync(file, (prev + line).split("\n").slice(-200).join("\n"));
  } catch {}
}

// Tunable so this is testable in seconds. A watchdog that only acts after 30s,
// and whose second check only fires at 5 minutes, cannot be covered by any test
// that finishes quickly — which is exactly how a bug here reaches a user: every
// check passes, because every check is too fast to reach the code that kills.
const LIVENESS_MS = Number(process.env.OCIC_PARENT_CHECK_MS) || 30_000;
// Identity is the expensive check and the slow-moving risk: a recycled PID can
// only keep us alive until the next one.
const IDENTITY_EVERY = Number(process.env.OCIC_IDENTITY_EVERY) || 10; // ~5 min

// Creation time of `pid`, in ms since epoch, or null if it cannot be read.
//
// Windows only, and only needed there. POSIX reparents an orphan to init, so
// "my parent died" is answered by ppid alone and can never be confused with a
// recycled pid — there is nothing for an identity check to add.
function birthTime(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try{(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -EA Stop).CreationDate.ToFileTimeUtc()}catch{""}`
      ],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const filetime = Number(String(stdout).trim());
        if (!Number.isFinite(filetime) || filetime <= 0) return resolve(null);
        // FILETIME is 100ns ticks since 1601; shift to the Unix epoch.
        resolve(filetime / 1e4 - 11644473600000);
      }
    );
  });
}

function parentIsAlive(ppid) {
  try {
    process.kill(ppid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err.code === "EPERM";
  }
}

// The other way these pile up, and the one parent-watching cannot see: a
// long-lived client that spawns a server, stops using it, and never closes its
// stdin. The parent is alive and healthy, so nothing about it is a signal — the
// process is simply abandoned. Only idleness gives it away.
//
// Off by default, and it has to be: an interactive session can sit idle for
// hours while someone thinks, and exiting under it would produce exactly the
// dropped connection this whole change exists to prevent. Programs that spawn
// servers in a loop can opt in with OCIC_IDLE_EXIT_MS.
let lastActivity = Date.now();
export function noteActivity() {
  lastActivity = Date.now();
}

/**
 * Call `onOrphaned` once the spawning process is gone. Returns a stop function.
 *
 * Deliberately conservative: every check that cannot be completed is treated as
 * "still parented". A false positive kills a live session's browser tools; a
 * false negative only leaves a process around until the next tick.
 */
export function watchParent(onOrphaned) {
  const startedAt = Date.now();
  const initialPpid = process.ppid;
  let ticks = 0;
  let fired = false;

  const orphaned = (why) => {
    if (fired) return;
    fired = true;
    clearInterval(timer);
    recordExit(`REAPER FIRED: ${why}`);
    try {
      process.stderr.write(`Parent process is gone (${why}); exiting.\n`);
    } catch {}
    onOrphaned();
  };

  // Whatever ends this process, say so — so a death the reaper had nothing to
  // do with can be told apart from one it caused, instead of inferred.
  process.on("exit", (code) => {
    if (!fired) recordExit(`process exit (code=${code}), reaper did not fire`);
  });

  const idleLimit = parseInt(process.env.OCIC_IDLE_EXIT_MS || "", 10);

  const timer = setInterval(async () => {
    if (idleLimit > 0 && Date.now() - lastActivity > idleLimit) {
      return orphaned(`idle for ${Math.round((Date.now() - lastActivity) / 1000)}s`);
    }

    const ppid = process.ppid;

    // POSIX reparents orphans to init, which is unambiguous and free.
    if (ppid <= 1) return orphaned("reparented to init");
    // A changed ppid means the original parent died and we were reparented.
    if (ppid !== initialPpid) return orphaned("reparented");
    if (!parentIsAlive(ppid)) return orphaned("pid no longer exists");

    if (++ticks % IDENTITY_EVERY !== 0) return;

    // The PID is alive — but is it still OUR parent, or has it been recycled
    // onto something else? A parent cannot be younger than its child.
    const born = await birthTime(ppid);
    if (born === null) return; // unreadable; assume still parented
    if (born > startedAt) orphaned("pid was recycled onto another process");
  }, LIVENESS_MS);

  // Never hold the event loop open on our own account.
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
