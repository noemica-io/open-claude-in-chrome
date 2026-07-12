// Shared secret that authenticates connections on the local TCP control channel
// between the MCP servers and the native messaging host.
//
// The token lives in a 0600 file next to config.json, so only the current user
// can read it. That is the whole access-control model: any local process that
// can read the file is already running as the user (and could drive the browser
// by other means anyway), while other local users — who can still reach the
// loopback port — cannot read the token and are therefore rejected.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(os.homedir(), ".config", "open-claude-in-chrome");
const tokenPath = path.join(dir, "token");

function tryRead() {
  try {
    const t = fs.readFileSync(tokenPath, "utf-8").trim();
    return t || null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Read the shared token, creating it on first use. Concurrent starts (multiple
// sessions, the native host) converge on a single token: the create is atomic
// (write a temp file, then hard-link it into place), so whoever loses the race
// just reads the winner's token.
export function getAuthToken() {
  const existing = tryRead();
  if (existing) return existing;

  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}

  const token = crypto.randomBytes(32).toString("hex");
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.linkSync(tmp, tokenPath); // throws EEXIST if another process got there first
    return token;
  } catch {
    const other = tryRead();
    if (other) return other;
    throw new Error("open-claude-in-chrome: could not establish auth token");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
