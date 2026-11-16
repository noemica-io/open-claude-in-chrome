// Launching and restarting Firefox with its automation port enabled.
//
// Firefox only reads --remote-debugging-port at startup: a second invocation
// against a running profile hands its arguments to the running instance and the
// flag is dropped. So automation on an already-running Firefox means quitting
// it and starting it again with the flag.
//
// This runs in the MCP server process, not the native host: the host is a child
// of Firefox and dies with it.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { DEFAULT_BIDI_PORT, automationStatus } from "./bidi.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, just not ours to signal
  }
}

// True if something accepts connections on the port.
export function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function waitFor(check, ms, stepMs = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

// Where a Firefox install lives when we have to start one from scratch.
export function findFirefoxBinary() {
  if (process.env.OCIC_FIREFOX_PATH) return process.env.OCIC_FIREFOX_PATH;
  const isFile = (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  if (process.platform === "darwin") {
    const p = "/Applications/Firefox.app/Contents/MacOS/firefox";
    return isFile(p) ? p : null;
  }
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      const p = path.join(base, "Mozilla Firefox", "firefox.exe");
      if (isFile(p)) return p;
    }
    return null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, "firefox");
    if (dir && isFile(p)) return p;
  }
  return null;
}

// The command line a running process was started with, as [argv0, ...args], or
// null if it cannot be read. Replaying it restores the same wrapper, profile
// and options the user chose, which a bare "firefox" would not.
export function readArgv(pid) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    }
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      const line = (r.stdout || "").trim();
      // ps flattens argv; paths containing spaces cannot be recovered.
      return line ? line.split(/\s+/) : null;
    }
  } catch {}
  return null; // Windows: fall back to the default install
}

export function looksLikeFirefox(argv) {
  return !!argv && /firefox/i.test(path.basename(argv[0] || ""));
}

// Ask the process to quit the way a user closing it would, not killing it.
function requestQuit(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid)]);
  } else {
    process.kill(pid, "SIGTERM");
  }
}

// Clean up a replayed command line:
//  - drop any --remote-debugging-port already in it, in "--flag value" and
//    "--flag=value" forms (one dash too), so ours is the only one;
//  - drop URL arguments. Firefox opens a URL given on the command line instead
//    of restoring the previous session, so replaying one would lose the user's
//    tabs. No flag Firefox takes has a URL for its value.
const URL_ARG = /^(?:[a-z][a-z0-9+.-]*:\/\/|about:|data:|javascript:)/i;
function withoutPortFlag(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (URL_ARG.test(args[i])) continue;
    if (/^--?remote-debugging-port=/.test(args[i])) continue;
    if (/^--?remote-debugging-port$/.test(args[i])) {
      if (/^\d+$/.test(args[i + 1] || "")) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function launch(argv, port) {
  const [bin, ...args] = argv;
  const child = spawn(bin, [...withoutPortFlag(args), "--remote-debugging-port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {}); // a failed spawn is caught by the port wait below
  child.unref();
}

/**
 * Start Firefox with the automation port, or restart it that way.
 *
 * @param {object}   opts
 * @param {number=}  opts.pid   running Firefox to replace, if any
 * @param {number=}  opts.port
 * @returns {Promise<string>} what happened, for the agent
 */
export async function startFirefoxWithAutomation({ pid, port = DEFAULT_BIDI_PORT } = {}) {
  if (await portOpen(port)) {
    // Listening isn't enough: Firefox's one session may be stranded (see
    // bidi.js), and only a restart frees it.
    if ((await automationStatus(port)) !== "taken") {
      return `Firefox is already listening for automation on port ${port}; nothing to do.`;
    }
    if (!pid) {
      throw new Error(
        `Firefox's automation session on port ${port} is taken, but the extension is not connected, ` +
          "so the Firefox process to restart is unknown. Ask the user to restart Firefox."
      );
    }
  }

  let argv = null;
  if (pid) {
    argv = readArgv(pid);
    if (argv && !looksLikeFirefox(argv)) {
      throw new Error(
        `The connected browser (${path.basename(argv[0])}) is not Firefox. ` +
          "restart_browser only applies to Firefox."
      );
    }
    requestQuit(pid);
    if (!(await waitFor(() => !isAlive(pid), 20000))) {
      throw new Error(
        "Firefox did not quit within 20s (it may be showing a confirmation dialog, such as " +
          "'close N tabs?'). Ask the user to close Firefox, then call restart_browser again."
      );
    }
  }

  if (!argv) {
    const bin = findFirefoxBinary();
    if (!bin) {
      throw new Error(
        "Could not find a Firefox installation. Set OCIC_FIREFOX_PATH to the Firefox executable."
      );
    }
    argv = [bin];
  }

  // A restart may leave the old process's port briefly open; wait it out so
  // the check below sees the new Firefox, not the old one.
  await waitFor(async () => !(await portOpen(port)), 10000);
  launch(argv, port);
  if (!(await waitFor(() => portOpen(port), 30000, 300))) {
    throw new Error(
      `Started Firefox, but nothing is listening on port ${port}. If Firefox was already running, ` +
        `it ignored the flag; if another program holds port ${port}, set OCIC_FIREFOX_PORT.`
    );
  }
  return `Firefox started with automation enabled on port ${port}.`;
}
