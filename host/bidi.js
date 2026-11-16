// Minimal WebDriver BiDi client for Firefox.
//
// Firefox has no chrome.debugger, so on Firefox the extension forwards its CDP
// calls to this host (native messaging), and the host speaks WebDriver BiDi to
// the browser's Remote Agent, which Firefox starts when launched with
// --remote-debugging-port. See cdp-bridge.js for the CDP -> BiDi translation.
//
// Uses Node's built-in WebSocket client (no dependency). The Remote Agent
// rejects any connection carrying an Origin header it does not allow; Node's
// client sends none, which is the accepted case.
//
// Session lifetime. Firefox allows ONE BiDi session, and closing the WebSocket
// does not end it: it lives on until session.end or Firefox quits
// (remote/webdriver-bidi/WebDriverBiDiConnection.sys.mjs, onConnectionClose
// only unregisters the connection). A session made with BiDi session.new also
// cannot be reattached: Firefox serves /session/<id> only for classic WebDriver
// sessions. This host is replaced whenever the extension reconnects, so it
// must end its session on the way out (see end(), called by native-host.js),
// or every later host is locked out until Firefox restarts.

export const DEFAULT_BIDI_PORT = Number(process.env.OCIC_FIREFOX_PORT) || 9222;
const COMMAND_TIMEOUT_MS = 20000;

// Open a WebSocket and wait for the handshake.
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e.error || new Error(`cannot open ${url}`)), { once: true });
  });
}

// Firefox's one session is taken: a different automation client holds it, or
// a host died (crashed, was killed) before ending its own. Firefox releases it
// only when it restarts.
export class BidiSessionTakenError extends Error {
  constructor() {
    super(
      "Firefox's automation session is already taken (Firefox allows one, and keeps it until it " +
        "restarts): another automation tool is attached, or an earlier connection was lost. " +
        "ASK THE USER for permission to restart Firefox: tell them it will close and reopen, and " +
        "that open tabs only come back if their Firefox restores the previous session. If they " +
        "agree, call restart_browser, then retry this action."
    );
    this.name = "BidiSessionTakenError";
  }
}

// Raised when nothing is listening: Firefox is closed, or it was started
// without --remote-debugging-port.
export class BidiUnreachableError extends Error {
  constructor(port, cause) {
    super(
      `Firefox is not running with automation enabled (nothing is listening on 127.0.0.1:${port}), ` +
        "which click, type, screenshot and page-evaluation tools need. Firefox only enables it at " +
        "startup, so it has to be restarted. ASK THE USER for permission first: tell them Firefox " +
        "will close and reopen, and that open tabs only come back if their Firefox is set to " +
        "restore the previous session. If they agree, call restart_browser, then retry this action."
    );
    this.name = "BidiUnreachableError";
    this.cause = cause;
  }
}

export class BidiClient {
  #ws = null;
  #ready = null; // Promise<void> while connecting or connected
  #seq = 0;
  #pending = new Map(); // id -> { resolve, reject, timer, method }
  #hasSession = false;
  #listeners = new Set(); // (method, params) => void, for BiDi events

  constructor(port = DEFAULT_BIDI_PORT) {
    this.port = port;
  }

  // Idempotent: concurrent callers share one in-flight connect.
  connect() {
    if (!this.#ready) {
      this.#ready = this.#open().catch((e) => {
        this.#ready = null;
        throw e;
      });
    }
    return this.#ready;
  }

  async #open() {
    let ws;
    try {
      ws = await openSocket(`ws://127.0.0.1:${this.port}/session`);
    } catch (e) {
      throw new BidiUnreachableError(this.port, e);
    }
    this.#use(ws);
    try {
      await this.#send("session.new", { capabilities: {} });
    } catch (e) {
      // Without a session this socket is useless; don't leave it open.
      this.close();
      if (e.bidiError === "session not created") throw new BidiSessionTakenError();
      throw e;
    }
    this.#hasSession = true;
  }

  #use(ws) {
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", () => this.#onClose(ws));
    this.#ws = ws;
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    if (msg.type === "event") {
      for (const cb of this.#listeners) {
        try {
          cb(msg.method, msg.params);
        } catch {}
      }
      return;
    }
    if (msg.id === undefined) return;
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "error") {
      const err = new Error(`${p.method}: ${msg.error}: ${msg.message}`);
      err.bidiError = msg.error;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  #onClose(ws) {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#ready = null;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: connection to Firefox closed`));
      this.#pending.delete(id);
    }
  }

  #send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.#seq;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async command(method, params = {}) {
    await this.connect();
    return this.#send(method, params);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {}
  }

  // End our session (so the next client can create one), then disconnect.
  // Bounded: this runs while the host is shutting down.
  async end(timeoutMs = 1000) {
    if (this.#hasSession && this.#ws) {
      this.#hasSession = false;
      await Promise.race([
        this.#send("session.end", {}).catch(() => {}),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    }
    this.close();
  }
}

/**
 * Can automation use this Firefox right now? Never creates a session (one
 * created here would be stranded when this check disconnects).
 *
 * @returns {Promise<"usable"|"taken"|"unreachable">}
 */
export async function automationStatus(port = DEFAULT_BIDI_PORT) {
  let ws;
  try {
    ws = await openSocket(`ws://127.0.0.1:${port}/session`);
  } catch {
    return "unreachable";
  }
  try {
    // session.status needs no session; `ready` is false while one exists.
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session.status timed out")), 5000);
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        resolve(msg.type === "success" && msg.result.ready === true);
      });
      ws.send(JSON.stringify({ id: 1, method: "session.status", params: {} }));
    });
    return ready ? "usable" : "taken";
  } finally {
    ws.close();
  }
}
