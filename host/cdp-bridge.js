// Translates the CDP commands the extension issues into WebDriver BiDi.
//
// The extension keeps calling cdp(tabId, method, params) exactly as it does on
// Chromium; on Firefox that call arrives here as { tabId, method, params }.
// Only the methods the extension actually uses are translated. Anything else
// fails loudly rather than being silently ignored.

import { newInputState, translateInput, translatePlan, WHEEL_WATCH, wheelFollowUp } from "./cdp-input.js";

// BiDi identifies tabs by its own browsing-context ids, not the extension's
// tabId. The extension stamps window.__ocic_tab = <tabId> into the page (MAIN
// world); we find the context carrying that stamp and cache the pairing. A
// top-level context id survives navigation, so the stamp only has to be
// readable at mapping time.
export const TAB_UNMAPPED = "TAB_UNMAPPED";

// BiDi RemoteValue -> plain JS value (what CDP returns under returnByValue).
export function bidiToValue(rv) {
  if (rv === null || rv === undefined) return undefined;
  switch (rv.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return rv.value;
    case "number":
      return typeof rv.value === "string"
        ? { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 }[rv.value]
        : rv.value;
    case "bigint":
      return rv.value;
    case "date":
      return rv.value;
    case "regexp":
      return `/${rv.value.pattern}/${rv.value.flags || ""}`;
    case "array":
    case "set":
    case "nodelist":
    case "htmlcollection":
      return (rv.value || []).map(bidiToValue);
    case "object": {
      const o = {};
      for (const [k, v] of rv.value || []) o[typeof k === "string" ? k : bidiToValue(k)] = bidiToValue(v);
      return o;
    }
    case "map": {
      const o = {};
      for (const [k, v] of rv.value || []) o[typeof k === "string" ? k : bidiToValue(k)] = bidiToValue(v);
      return o;
    }
    default:
      // function, node, window, error, symbol, ...: not serializable by value.
      return undefined;
  }
}

function cdpType(rv) {
  switch (rv?.type) {
    case "undefined": return "undefined";
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "bigint": return "bigint";
    case "symbol": return "symbol";
    case "function": return "function";
    default: return "object";
  }
}

// CDP domain -> the BiDi events that stand in for its events. Enabling the
// domain subscribes to them for that tab only, as CDP's enable does.
const DOMAIN_EVENTS = {
  Network: ["network.beforeRequestSent", "network.responseCompleted"],
  Console: ["log.entryAdded"],
  Runtime: ["log.entryAdded"],
};

const ROOT_NODE_ID = 1;

export class CdpBridge {
  /**
   * @param {BidiClient} client
   * @param {(tabId: number, method: string, params: object) => void} emit
   *   receives BiDi events translated to the CDP events the extension handles
   */
  constructor(client, emit = () => {}) {
    this.client = client;
    this.emit = emit;
    this.tabs = new Map(); // extension tabId -> BiDi context id
    this.input = new Map(); // extension tabId -> { state, queue }
    this.subscribed = new Map(); // extension tabId -> Set of BiDi event names
    this.parentOf = new Map(); // BiDi context id -> parent context id (null at top)
    this.nodes = new Map(); // extension tabId -> Map(fake CDP nodeId -> BiDi sharedId)
    client.onEvent?.((method, params) => {
      this.#onEvent(method, params).catch(() => {});
    });
  }

  async handle({ tabId, method, params = {} }) {
    const enable = /^(\w+)\.enable$/.exec(method);
    if (enable) return DOMAIN_EVENTS[enable[1]] ? this.#subscribe(tabId, DOMAIN_EVENTS[enable[1]]) : {};
    // Emulation has no BiDi equivalent that matters here.
    if (/^Emulation\./.test(method)) return {};

    switch (method) {
      case "DOM.getDocument":
        return { root: { nodeId: ROOT_NODE_ID } };
      case "DOM.querySelector":
        return this.#querySelector(tabId, params);
      case "DOM.setFileInputFiles":
        return this.#setFiles(tabId, params);
      case "Runtime.evaluate":
        return this.#evaluate(tabId, params);
      case "Page.captureScreenshot":
        return this.#screenshot(tabId, params);
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
      case "Ocic.dispatchPlan": // not CDP: a humanized plan, see translatePlan
        return this.#inputInOrder(tabId, method, params);
      default:
        throw new Error(`${method} is not supported on Firefox yet`);
    }
  }

  // Run a BiDi command against a tab's context. If the cached context is gone
  // (tab replaced), drop it and map once more.
  async #inTab(tabId, run) {
    let ctx = this.tabs.get(tabId) ?? (await this.#map(tabId));
    try {
      return await run(ctx);
    } catch (e) {
      if (e.bidiError !== "no such frame" && e.bidiError !== "no such web element") throw e;
      this.tabs.delete(tabId);
      ctx = await this.#map(tabId);
      return run(ctx);
    }
  }

  async #map(tabId) {
    const { contexts } = await this.client.command("browsingContext.getTree", { maxDepth: 0 });
    const probes = await Promise.allSettled(
      contexts.map(async (c) => {
        const r = await this.client.command("script.evaluate", {
          expression: "window.__ocic_tab",
          target: { context: c.context },
          awaitPromise: false,
        });
        return r.type === "success" && r.result.value === tabId ? c.context : null;
      })
    );
    const hit = probes.find((p) => p.status === "fulfilled" && p.value)?.value;
    if (!hit) {
      // The extension reacts to this prefix by (re)stamping the tab and retrying.
      throw new Error(`${TAB_UNMAPPED}: no browsing context carries the stamp for tab ${tabId}`);
    }
    this.tabs.set(tabId, hit);
    return hit;
  }

  // --- Events ---

  async #subscribe(tabId, events) {
    let have = this.subscribed.get(tabId);
    if (!have) this.subscribed.set(tabId, (have = new Set()));
    const missing = events.filter((e) => !have.has(e));
    if (!missing.length) return {};
    await this.#inTab(tabId, (context) => this.client.command("session.subscribe", { events: missing, contexts: [context] }));
    missing.forEach((e) => have.add(e));
    return {};
  }

  // The extension tab a BiDi context belongs to. Events from iframes carry the
  // iframe's own context, so walk up to the top-level one we mapped.
  async #tabFor(context) {
    for (let c = context, hops = 0; c && hops < 20; hops++) {
      for (const [tabId, top] of this.tabs) if (top === c) return tabId;
      let parent = this.parentOf.get(c);
      if (parent === undefined) {
        try {
          const { contexts } = await this.client.command("browsingContext.getTree", { root: c, maxDepth: 0 });
          parent = contexts[0]?.parent ?? null;
        } catch {
          parent = null; // context already gone
        }
        this.parentOf.set(c, parent);
      }
      c = parent;
    }
    return null;
  }

  async #onEvent(method, p) {
    if (method === "log.entryAdded") {
      const tabId = await this.#tabFor(p.source?.context);
      if (tabId === null) return;
      // console.* calls keep their method as the level (console.warn is
      // "warning", as in CDP); uncaught errors are "error" so onlyErrors finds them.
      const level = p.type === "console" ? (p.method === "warn" ? "warning" : p.method || p.level) : "error";
      this.emit(tabId, "Console.messageAdded", {
        message: { level, text: p.text ?? "", url: p.stackTrace?.callFrames?.[0]?.url || "" },
      });
    } else if (method === "network.beforeRequestSent" || method === "network.responseCompleted") {
      const tabId = await this.#tabFor(p.context);
      if (tabId === null) return;
      const requestId = p.request?.request;
      if (method === "network.beforeRequestSent") {
        this.emit(tabId, "Network.requestWillBeSent", {
          requestId,
          request: { url: p.request.url, method: p.request.method },
        });
      } else {
        const r = p.response || {};
        this.emit(tabId, "Network.responseReceived", {
          requestId,
          response: { status: r.status, statusText: r.statusText, mimeType: r.mimeType, url: r.url },
        });
      }
    }
  }

  // --- DOM, for file upload ---
  // CDP finds the input by nodeId; BiDi addresses it by the sharedId in a
  // script result. DOM.getDocument returns a fixed root id, querySelector
  // hands out ids that stand for sharedIds, setFileInputFiles resolves them.

  #querySelector(tabId, { nodeId, selector }) {
    if (nodeId !== ROOT_NODE_ID) throw new Error("DOM.querySelector on Firefox only supports the document root");
    return this.#inTab(tabId, async (context) => {
      const r = await this.client.command("script.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        target: { context },
        awaitPromise: false,
      });
      if (r.type === "exception") throw new Error(`DOM.querySelector: ${r.exceptionDetails?.text}`);
      const sharedId = r.result?.sharedId;
      if (r.result?.type !== "node" || !sharedId) return { nodeId: 0 };
      let nodes = this.nodes.get(tabId);
      if (!nodes) this.nodes.set(tabId, (nodes = new Map()));
      const id = ROOT_NODE_ID + 1 + nodes.size;
      nodes.set(id, sharedId);
      return { nodeId: id };
    });
  }

  #setFiles(tabId, { nodeId, files }) {
    const sharedId = this.nodes.get(tabId)?.get(nodeId);
    if (!sharedId) throw new Error(`DOM.setFileInputFiles: unknown nodeId ${nodeId}`);
    return this.#inTab(tabId, async (context) => {
      await this.client.command("input.setFiles", { context, element: { sharedId }, files });
      this.nodes.get(tabId)?.delete(nodeId);
      return {};
    });
  }

  #evaluate(tabId, params) {
    return this.#inTab(tabId, async (context) => {
      const r = await this.client.command("script.evaluate", {
        expression: params.expression,
        target: { context },
        awaitPromise: !!params.awaitPromise,
        resultOwnership: "none",
      });
      if (r.type === "exception") {
        const d = r.exceptionDetails || {};
        return {
          result: { type: "object", subtype: "error", description: d.text },
          exceptionDetails: {
            text: d.text || "Uncaught",
            lineNumber: d.lineNumber,
            columnNumber: d.columnNumber,
            exception: { type: "object", description: d.text },
          },
        };
      }
      const value = bidiToValue(r.result);
      const out = { type: cdpType(r.result) };
      if (r.result?.type === "null") out.subtype = "null";
      if (value !== undefined || r.result?.type === "null") out.value = value;
      else out.description = r.result?.type;
      return { result: out };
    });
  }

  // Input events for one tab run strictly in arrival order. The extension
  // fires some of them without waiting (humanized cursor paths), and the
  // translation is stateful (held modifiers, click counts), so letting one
  // overtake another would scramble both the gesture and that state.
  #inputInOrder(tabId, method, params) {
    let entry = this.input.get(tabId);
    if (!entry) {
      entry = { state: newInputState(), queue: Promise.resolve() };
      this.input.set(tabId, entry);
    }
    const run = entry.queue.then(() => this.#input(tabId, entry.state, method, params));
    entry.queue = run.catch(() => {});
    return run;
  }

  async #input(tabId, state, method, params) {
    if (method === "Ocic.dispatchPlan") {
      const actions = translatePlan(state, params.plan || [], params.modifiers || 0);
      if (actions.length) {
        await this.#inTab(tabId, (context) => this.client.command("input.performActions", { context, actions }));
      }
      return {};
    }
    const steps = translateInput(state, method, params);
    for (const step of steps) {
      await this.#inTab(tabId, (context) =>
        step.kind === "wheel" ? this.#wheel(context, step) : this.client.command("input.performActions", { context, actions: step.actions })
      );
    }
    return {};
  }

  async #wheel(context, { x, y, deltaX, deltaY }) {
    const inSandbox = (expression) =>
      this.client.command("script.evaluate", {
        expression,
        target: { context, sandbox: "ocic" },
        awaitPromise: false,
      });
    const vis = await inSandbox(WHEEL_WATCH);
    await this.client.command("input.performActions", {
      context,
      actions: [{ type: "wheel", id: "ocic-wheel", actions: [{ type: "scroll", x, y, deltaX, deltaY, duration: 0 }] }],
    });
    if (vis.result?.value === "hidden") await inSandbox(wheelFollowUp(x, y, deltaX, deltaY));
  }

  #screenshot(tabId, params) {
    return this.#inTab(tabId, async (context) => {
      const type = params.format === "png" ? "image/png" : params.format === "webp" ? "image/webp" : "image/jpeg";
      const format = { type };
      if (type !== "image/png" && typeof params.quality === "number") format.quality = params.quality / 100;
      const req = {
        context,
        origin: params.captureBeyondViewport ? "document" : "viewport",
        format,
      };
      // BiDi's clip has no `scale`; device-pixel-ratio compensation, if the
      // extension asked for it, is not applied here.
      if (params.clip) {
        const { x, y, width, height } = params.clip;
        req.clip = { type: "box", x, y, width, height };
      }
      const r = await this.client.command("browsingContext.captureScreenshot", req);
      return { data: r.data };
    });
  }
}
