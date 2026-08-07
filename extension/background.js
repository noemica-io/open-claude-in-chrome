// Background service worker for Open Claude in Chrome extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome";

// --- State ---
let nativePort = null;
let tabGroupId = null;
let tabGroupTabs = new Set();
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const networkInflight = new Map(); // tabId -> active request count (for networkidle wait)
const screenshotStore = new Map(); // imageId -> base64

let heartbeatTimer = null;

// switch_browser releases this browser's hold on the shared runtime by
// dropping the native port; this window keeps us from immediately re-grabbing
// it so a target browser (extension enabled) can become primary.
let suspendReconnectUntil = 0;
const SWITCH_RELEASE_MS = 15000;

async function detectBrowser() {
  try {
    if (navigator.brave && (await navigator.brave.isBrave?.())) return "Brave";
  } catch (e) {}
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "Edge";
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  if (/Brave/i.test(brands)) return "Brave";
  if (/OPR\//.test(ua)) return "Opera";
  return "Chrome";
}

// --- Keep-alive alarm ---
// Backstop wake-up for the MV3 service worker. The proactive heartbeat
// inside connectNativeHost (~15s) is the primary mechanism; this alarm
// covers cases where the SW is fully evicted between heartbeats.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  // Honor a switch_browser release window: stay disconnected so another
  // browser can take the primary connection, then resume.
  if (Date.now() < suspendReconnectUntil) {
    setTimeout(connectNativeHost, 500);
    return;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      // Heartbeat acks (and any other non-request server-originated messages)
      // are intentionally ignored here — only tool_request kicks work.
      if (msg.type === "tool_request" && msg.id) {
        handleToolRequest(msg.id, msg.tool, msg.args || {});
      } else if (msg.type === "recording_saved") {
        // Reply from the native host after writing a recording bundle to disk.
        const resolve = recorder.pendingSaves.get(String(msg.recording_id));
        if (resolve) {
          recorder.pendingSaves.delete(String(msg.recording_id));
          resolve(msg.ok ? msg.path : null);
        }
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      stopHeartbeat();
      // Retry quickly. Reconnect latency dominates per-call wall-clock when
      // the SW just slept; 250ms is the right floor — fast enough to be
      // invisible to a single tool call, slow enough not to busy-spin on a
      // genuinely dead host (which will be retried again on next alarm).
      setTimeout(connectNativeHost, 250);
    });

    startHeartbeat();
  } catch (e) {
    nativePort = null;
    stopHeartbeat();
    setTimeout(connectNativeHost, 250);
  }
}

// Proactive heartbeat: send a small message every ~15s while the native
// port is alive. Two effects:
//   1) The SW stays alive between alarm fires (postMessage resets the
//      ~30s idle timer Chrome uses to evict MV3 service workers).
//   2) The native-host TCP socket stays warm — no chance of Chrome
//      garbage-collecting the connection because it's been idle.
// 15s is well under both Chrome's SW idle timeout and the alarm period.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!nativePort) return;
    try {
      nativePort.postMessage({ type: "heartbeat", t: Date.now() });
    } catch {
      // Port disconnected; the onDisconnect handler will reconnect.
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- Tab group management ---
async function ensureTabGroup(createIfEmpty) {
  // Check if our tab group still exists
  if (tabGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId);
      if (group) {
        // Verify tabs are still in the group
        const tabs = await chrome.tabs.query({ groupId: tabGroupId });
        tabGroupTabs = new Set(tabs.map((t) => t.id));
        if (tabGroupTabs.size > 0) return;
      }
    } catch {
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  }

  if (!createIfEmpty) return;

  // Create a new window with a tab, group it
  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  const tab = win.tabs[0];
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "MCP", color: "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tab.id]);
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, tabGroupId }) + "\n\n" + text,
      },
    ],
  };
}

async function isInGroup(tabId) {
  // Always check live state — in-memory tabGroupTabs can be stale after service worker restart
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1) {
      // Recover tabGroupId if we lost it (service worker restart)
      if (tabGroupId === null) {
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group.title === "MCP") {
            tabGroupId = group.id;
            const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
            tabGroupTabs = new Set(groupTabs.map((t) => t.id));
          }
        } catch {}
      }
      return tab.groupId === tabGroupId;
    }
    return tabGroupTabs.has(tabId);
  } catch {
    return false;
  }
}

// --- CDP helpers ---
// Chrome (and Chromium generally) throttle a non-visible tab: its compositor
// stops committing frames, so Input.dispatchMouseEvent to it stalls ~5s. We
// make a tab the active/selected tab of its window ONLY when it is created —
// that is the moment the tab we are about to drive must be foreground. We do
// NOT re-activate on every action, and we NEVER focus/raise the window (that
// would steal OS focus, which is disruptive when the browser is shared). If a
// tab is later backgrounded (e.g. the user selects another tab), its input
// pays the throttle cost until it is foreground again — an accepted tradeoff.
async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn("activateTab:", e.message);
  }
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  // Force devicePixelRatio to 1 so screenshots match CSS coordinate space.
  // Without this, Retina displays produce 2x screenshots and all coordinates are wrong.
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: win.width,
    height: win.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

// A single CDP command must never hang a tool call to the 60s MCP timeout.
// On a heavy page mid-reflow, Page.captureScreenshot (and other commands) can
// block indefinitely; bound every command so a stuck one fails fast and
// surfaces as a tool error the agent can react to, instead of a silent stall.
const CDP_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    CDP_TIMEOUT_MS,
    `CDP ${method}`
  );
}

// Wait until the page has made no network requests for ~quietMs, or a hard
// timeout. The in-flight count is maintained by the Network event listener;
// callers enable the Network domain and zero the counter before navigating.
function waitForNetworkIdle(tabId, { quietMs = 500, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let idleSince = null;
    const poll = setInterval(() => {
      const n = (networkInflight.get(tabId) || new Set()).size;
      if (n <= 0) {
        if (idleSince === null) idleSince = Date.now();
        if (Date.now() - idleSince >= quietMs) {
          clearInterval(poll);
          resolve();
        }
      } else {
        idleSince = null;
      }
    }, 100);
    setTimeout(() => {
      clearInterval(poll);
      resolve();
    }, timeoutMs);
  });
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  networkInflight.delete(tabId);
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.response.url,
      method: params.response.requestHeaders ? "?" : "GET",
      status: params.response.status,
      statusText: params.response.statusText,
      type: params.type || "Other",
      mimeType: params.response.mimeType,
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
    // Track in-flight so a networkidle wait can detect when a page settles.
    // Keyed by requestId: a redirect re-emits requestWillBeSent for the SAME
    // requestId (with a redirectResponse) and never separately finishes, so
    // deduping on requestId keeps redirect chains from leaking +1 each.
    if (!params.redirectResponse) {
      let ids = networkInflight.get(tabId);
      if (!ids) { ids = new Set(); networkInflight.set(tabId, ids); }
      ids.add(params.requestId);
    }
  }

  if (
    (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
    params.requestId
  ) {
    const ids = networkInflight.get(tabId);
    if (ids) ids.delete(params.requestId);
  }
});

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Retry
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // With deviceScaleFactor: 1 set in ensureAttached, screenshots are captured
  // at CSS pixel dimensions (e.g., 1080x746), matching the coordinate space
  // used by Input.dispatchMouseEvent. No scaling tricks needed.
  const result = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 55,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  });
  let base64 = result.data;

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (base64.length > 500000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// --- Mouse helpers ---
// Brave withholds the debugger ack for synthesized mouse events (a constant
// ~5s flush for move/press/release; mouseWheel is never acked at all) while
// applying the event itself immediately. Chrome acks instantly. The ack
// carries no data we need, so give real protocol errors a short grace window
// and then proceed; a late ack (or late failure) is logged, not awaited.
// Brave's debugger input pipeline (verified empirically, 2026-07-15):
// the FIRST Input.dispatchMouseEvent of a burst acks after a constant ~5s
// cold-start; commands issued while an earlier one is still un-acked are
// NOT queued for press/release types, they are silently DROPPED (mouseMoved
// queues and applies late; mousePressed/Released vanish). mouseWheel is
// never acked at all but its scroll effect applies immediately.
// Consequences: move/press/release MUST be dispatched serially with each
// ack awaited (correctness over speed); ONLY mouseWheel may use a bounded
// race, because its effect is verified to apply without the ack and nothing
// depends on it inside the same action. Chrome acks everything instantly,
// so the awaits cost nothing there.
const INPUT_ACK_WAIT_MS = 250;

async function sendMouseEvent(tabId, params, { awaitAck = true } = {}) {
  await ensureAttached(tabId);
  const send = withTimeout(
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", params),
    CDP_TIMEOUT_MS,
    "CDP Input.dispatchMouseEvent",
  );
  if (awaitAck) {
    await send;
    return;
  }
  await Promise.race([
    send.catch((e) => console.warn("Input.dispatchMouseEvent late ack/failure:", e.message)),
    sleep(INPUT_ACK_WAIT_MS),
  ]);
}

async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await sendMouseEvent(tabId, {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureTabGroup(args.createIfEmpty);
    if (tabGroupId === null) {
      return {
        content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    await ensureTabGroup(true);
    const tab = await chrome.tabs.create({ active: true });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
    tabGroupTabs.add(tab.id);
    // Foreground the freshly created tab (grouping can drop it into another
    // window). This is the ONLY place we activate a tab — no per-action
    // re-activation, no window focus-stealing.
    await activateTab(tab.id);
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async tabs_close_mcp(args) {
    // Accept either a single tabId (most common) or a tabIds array for
    // batch close. Validate every id is actually in the current MCP group
    // so we never close the user's other tabs.
    const requested = Array.isArray(args?.tabIds)
      ? args.tabIds
      : args?.tabId !== undefined
        ? [args.tabId]
        : [];
    if (requested.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No tabId provided. Pass `tabId: <number>` or `tabIds: [<number>, ...]`."
          }
        ]
      };
    }
    const inGroup = [];
    const skipped = [];
    for (const id of requested) {
      const idNum = typeof id === "string" ? Number(id) : id;
      if (await isInGroup(idNum)) inGroup.push(idNum);
      else skipped.push(idNum);
    }
    if (inGroup.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `None of the requested tabs are in the MCP group. Requested: [${requested.join(", ")}]. Use tabs_context_mcp to see what is in the group.`
          }
        ]
      };
    }
    // chrome.tabs.remove force-closes — no beforeunload prompt. Detach any
    // CDP debuggers proactively so the onRemoved handler doesn't race.
    for (const id of inGroup) {
      if (attachedTabs.has(id)) {
        try { await chrome.debugger.detach({ tabId: id }); } catch {}
        attachedTabs.delete(id);
      }
    }
    await chrome.tabs.remove(inGroup);
    for (const id of inGroup) tabGroupTabs.delete(id);

    // Closing the last tab in the group also closes the window; the group
    // becomes invalid. Reflect that in the response so the model doesn't
    // try to reuse stale tabIds.
    let tabs = [];
    try {
      if (tabGroupId !== null) {
        tabs = await chrome.tabs.query({ groupId: tabGroupId });
      }
    } catch {}
    if (tabs.length === 0) {
      tabGroupId = null;
      tabGroupTabs.clear();
      return {
        content: [
          {
            type: "text",
            text:
              `Closed ${inGroup.length} tab(s): [${inGroup.join(", ")}]` +
              (skipped.length ? `. Skipped (not in group): [${skipped.join(", ")}]` : "") +
              `. The MCP tab group is now empty — the window has been closed. Use tabs_context_mcp({ createIfEmpty: true }) to start a new group.`
          }
        ]
      };
    }
    const result = formatTabContext(tabs);
    result.content[0].text =
      `Closed ${inGroup.length} tab(s): [${inGroup.join(", ")}]` +
      (skipped.length ? `. Skipped (not in group): [${skipped.join(", ")}]` : "") +
      `.\n\n` +
      result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId, wait = "load" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // networkidle needs the Network domain enabled from (just before) the start
    // of the navigation so every request the page makes is counted. Default
    // "load" keeps the old behavior and avoids attaching the debugger.
    const useNetworkIdle = wait === "networkidle";
    if (useNetworkIdle) {
      try {
        await cdp(tabId, "Network.enable");
        networkInflight.set(tabId, new Set());
      } catch {
        // If attachment fails, fall back to the plain load wait rather than erroring out.
      }
    }

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
        // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    // Optional networkidle: after load, additionally wait until the page has
    // made no network requests for ~500ms. Catches SPAs that fetch data after
    // the initial HTML load. Bounded so a long-polling page can't hang us.
    if (useNetworkIdle) await waitForNetworkIdle(tabId);

    const tab = await chrome.tabs.get(tabId);
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    let coordinate = args.coordinate;
    // Resolve ref to coordinates if provided
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        // Get viewport dimensions for the response message
        let dims = "";
        try {
          const vp = await cdp(tabId, "Runtime.evaluate", {
            expression: "window.innerWidth + 'x' + window.innerHeight",
          });
          if (vp?.result?.value) dims = vp.result.value;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      // Hidden diagnostic (not in the tool schema): serially times every CDP
      // input variant at the given coordinate so we can hunt for a dispatch
      // path Brave acks fast (keyboard-style) instead of the ~5s mouse path.
      case "diag_input": {
        const dx = coordinate ? coordinate[0] : 200;
        const dy = coordinate ? coordinate[1] : 200;
        const r = {};
        const t = async (label, fn) => {
          const t0 = Date.now();
          try { await fn(); r[label] = (Date.now() - t0) / 1000; }
          catch (e) { r[label] = (Date.now() - t0) / 1000; r[label + "_err"] = String(e.message || e).slice(0, 80); }
        };
        await t("mouse_moved", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: dx, y: dy }));
        await t("mouse_pressed", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("mouse_released", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("touch_start", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dx, y: dy }] }));
        await t("touch_end", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
        await t("synthesize_tap", () => cdp(tabId, "Input.synthesizeTapGesture", { x: dx, y: dy }));
        await t("synthesize_scroll", () => cdp(tabId, "Input.synthesizeScrollGesture", { x: dx, y: dy, yDistance: -100 }));
        await t("insert_text_noop", () => cdp(tabId, "Input.insertText", { text: "" }));
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        // Type character by character for better compatibility
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await sendMouseEvent(tabId, {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        }, { awaitAck: false });
        await sleep(300);
        // The scroll already happened; the confirmation screenshot is best-effort.
        // On a heavy page still re-rendering after the scroll, the capture can
        // block, so bound it and degrade to a text-only result rather than
        // stalling the whole scroll (and the agent's retries) to the 60s cap.
        const scrollContent = [
          { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
        ];
        try {
          const { base64 } = await withTimeout(takeScreenshot(tabId), 6000, "scroll screenshot");
          scrollContent.push({ type: "image", data: base64, mimeType: "image/jpeg" });
        } catch (e) {
          scrollContent[0].text += ` (post-scroll screenshot unavailable: ${e.message}; take a screenshot to see the result)`;
        }
        return { content: scrollContent };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/png" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    try {
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    const tab = await chrome.tabs.get(tabId);
    // A maximized/fullscreen window silently ignores width/height (notably on
    // macOS), so normalize the state first, then size it.
    try { await chrome.windows.update(tab.windowId, { state: "normal" }); } catch (e) {}
    await chrome.windows.update(tab.windowId, { width, height });
    // The page's layout viewport and every screenshot are pinned by the CDP
    // device-metrics override (set at attach to dpr=1 at the old size). Without
    // repointing it, the OS window moves but window.innerWidth, the rendered
    // viewport, and captures never change — which is why resize looked like a
    // no-op. Re-apply the override at the requested size.
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, coordinate, filename = "image.png" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    // Use CDP to set file input
    if (ref) {
      // Find the element and set its files via CDP
      await ensureAttached(tabId);
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__unblockedChrome?.resolveRef?.("${ref}");
          if (!el) return null;
          return el.tagName.toLowerCase();
        })()`,
        returnByValue: true,
      });

      if (result.result?.value === "input") {
        // For file inputs, we need DOM.setFileInputFiles via CDP
        // First get the node
        const doc = await cdp(tabId, "DOM.getDocument", {});
        const nodeResult = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = window.__unblockedChrome?.resolveRef?.("${ref}");
            if (el) el.scrollIntoView();
            return true;
          })()`,
          returnByValue: true,
        });
        return { content: [{ type: "text", text: `Upload via file input requires a temporary file. Use the file input directly.` }] };
      }
    }

    return { content: [{ type: "text", text: `Image upload for ref=${ref}, coordinate=${coordinate} — use drag & drop or file input.` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    const current = await detectBrowser();
    // Release AFTER this reply is delivered — it goes out over the very native
    // port we are about to drop. Suspending reconnect lets a target browser
    // whose extension is enabled bind the shared runtime and become primary;
    // if none takes over, this browser reconnects when the window elapses.
    setTimeout(() => {
      suspendReconnectUntil = Date.now() + SWITCH_RELEASE_MS;
      if (nativePort) {
        try { nativePort.disconnect(); } catch (e) {}
        nativePort = null;
        stopHeartbeat();
      }
    }, 300);
    return {
      content: [{
        type: "text",
        text:
          `Releasing the connection from ${current}. Enable this extension in the ` +
          `target browser (no restart needed) — for the next ~${SWITCH_RELEASE_MS / 1000}s it can take over ` +
          `the shared runtime automatically. Only one browser drives automation at a ` +
          `time. If nothing takes over, ${current} reconnects when the window elapses. ` +
          `Re-run tabs_context_mcp after a few seconds to confirm the active browser.`,
      }],
    };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  // recording_ack arrives from the MCP server when Claude confirms receipt of
  // a recording_complete event. Mark it delivered so stopRecording() can
  // report the "delivered to Claude Code" state (§4).
  if (tool === "recording_ack") {
    if (args && args.recording_id) recorder.deliveredIds.add(String(args.recording_id));
    sendResponse(id, { content: [{ type: "text", text: "ack received" }] });
    return;
  }

  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// ===========================================================================
// Imitation-learning recorder (NEEDS LIVE TESTING)
// ---------------------------------------------------------------------------
// The service worker is a THIN ROUTER only: it toggles recording on the icon,
// owns the offscreen document (the durable buffer that survives SW eviction),
// forwards behavior events from content scripts to it, segments the cross-tab
// timeline, and on stop ships the bundle to disk + notifies Claude Code.
// The heavy state lives in the offscreen doc, never in SW globals.
// ===========================================================================
const recorder = {
  active: false,
  recordingId: null,
  startedAt: null,
  deliveredIds: new Set(), // recording_ids Claude has acked
  pendingSaves: new Map(), // recording_id -> resolve (native-host disk write)
  imgSeq: 0, // frame counter for the images/ dir
  lastCapture: 0, // ts of last frame, to throttle to ≤1/sec
  lastVw: 0, // last viewport size seen (from content-script events), stamped
  lastVh: 0, // onto each frame so the viewer can map cursor x/y onto it
  // True while booting the mic or processing a stop (transcribe/save/copy).
  // Icon clicks are IGNORED while busy. In-memory on purpose: a dead SW has
  // no in-flight pipeline, so busy must never survive a restart.
  busy: false,
  // Badge epoch: bumped on every start/stop transition. Every DELAYED badge
  // writer (the post-copy delivery update, the 4s result-clear timer) captures
  // the epoch and is discarded if a newer transition happened — a previous
  // recording's stragglers must never repaint the current recording's badge.
  epoch: 0
};

// MV3 evicts this service worker after ~30s idle, which zeroes the globals
// above. Before this guard, a mid-recording eviction made the next icon click
// START a new recording (active had reset to false) whose offscreen "start"
// cleared the buffers — destroying the in-flight demo and shipping a 4-second
// shell instead. The cure: the toggle/forwarding state lives in
// chrome.storage.session (survives SW eviction, dies with the browser), and
// every gate hydrates from it before trusting `recorder`.
const REC_STATE_KEY = "recorder_state_v1";

function persistRecorderState() {
  chrome.storage.session
    .set({
      [REC_STATE_KEY]: {
        active: recorder.active,
        recordingId: recorder.recordingId,
        startedAt: recorder.startedAt,
        imgSeq: recorder.imgSeq,
        lastVw: recorder.lastVw,
        lastVh: recorder.lastVh
      }
    })
    .catch(() => {});
}

async function hydrateRecorderState() {
  try {
    const { [REC_STATE_KEY]: s } = await chrome.storage.session.get(REC_STATE_KEY);
    if (s && s.active && !recorder.active) {
      recorder.active = true;
      recorder.recordingId = s.recordingId;
      recorder.startedAt = s.startedAt;
      recorder.imgSeq = s.imgSeq || 0;
      recorder.lastVw = s.lastVw || 0;
      recorder.lastVh = s.lastVh || 0;
      setBadge(true); // restore REC after an eviction mid-recording
      chrome.action.setTitle({ title: "Recording… click to stop" });
    }
  } catch {}
}
// Kicked off at every SW (re)start; gates await it before reading `recorder`.
const recorderReady = hydrateRecorderState();

// Capture a 240p frame anchored to an event, at most once per second. The SW
// grabs the visible tab; the offscreen doc resizes + stores it for the viewer;
// the native host writes the file. The reference goes in the images track. All
// best-effort — a dropped frame just means no file at that ref.
async function maybeCapture(t) {
  if (!recorder.active || !nativePort) return;
  const now = Date.now();
  if (now - recorder.lastCapture < 1000) return;
  recorder.lastCapture = now;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 });
  } catch {
    return; // not capturable (chrome:// page, no active tab, etc.)
  }
  const name = String(++recorder.imgSeq).padStart(5, "0") + ".jpg";
  persistRecorderState(); // keep frame numbering monotonic across SW evictions
  try {
    const res = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "image",
      t: t || now,
      ref: "images/" + name,
      vw: recorder.lastVw, // viewport this frame was captured at
      vh: recorder.lastVh,
      dataUrl
    });
    if (res && res.ok && res.dataUrl && nativePort) {
      nativePort.postMessage({
        type: "save_screenshot",
        recording_id: recorder.recordingId,
        name,
        dataUrl: res.dataUrl
      });
    }
  } catch {}
}

function newRecordingId() {
  return "rec_" + Math.random().toString(36).slice(2, 10);
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "recorder/offscreen.html",
    reasons: ["USER_MEDIA", "CLIPBOARD"],
    justification:
      "Capture microphone narration, buffer the recording durably, and copy the recording reference to the clipboard on stop."
  });
}

async function getApiKey() {
  const { openai_api_key } = await chrome.storage.local.get("openai_api_key");
  return openai_api_key || "";
}

// Validate the key BEFORE any recording — a recording with no transcript path
// is a poor outcome, so we fail fast (§5).
//
// This deliberately runs a REAL transcription of a 0.3s clip (in the offscreen
// document, which owns transcribe.js) rather than calling /v1/models. That
// endpoint returns 200 for a key whose credit balance is exhausted, so it once
// green-lit a 43-minute narrated recording that could never be transcribed.
// Authentication is not capability.
async function validateKey(apiKey) {
  if (!apiKey) return { ok: false, error: "No OpenAI API key set. Add one in the extension options." };
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "probe_key",
      apiKey
    });
    if (r && r.ok) return { ok: true };
    return { ok: false, error: (r && r.error) || "OpenAI transcription is unavailable." };
  } catch (e) {
    return { ok: false, error: `Could not reach OpenAI: ${e.message}` };
  }
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
}

// The "..." processing state: shown while the mic boots and while a stopped
// recording is transcribed, saved, and copied. Clicks are ignored throughout.
function setProcessingBadge(title) {
  chrome.action.setBadgeText({ text: "\u2026" });
  chrome.action.setBadgeBackgroundColor({ color: "#a5701a" });
  chrome.action.setTitle({ title });
}

// A paste-able reference to a saved recording — the same text the Options
// "Copy reference" button produces. Copied to the clipboard on stop so you can
// paste it straight into Claude Code, regardless of any channel.
// `transcriptStatus` is "ok" or a reason. The reference must never claim a
// narration track it doesn't have: the whole point of pasting this into a
// coding agent is that the text describes what is ACTUALLY in the bundle.
function buildRecordingReference(path, transcriptStatus) {
  const base =
    `Read the browser recording at ${path} — an imitation-learning rollout of an expert doing a task. ` +
    `trace.json holds four tracks on one shared clock (behavior, cursor, images, narration); ` +
    `SCHEMA_v0.md in that folder is the field reference, and images/ holds the frames.`;
  if (!transcriptStatus || transcriptStatus === "ok") return base;
  return (
    base +
    ` WARNING — TRANSCRIPT FAILED: ${transcriptStatus}. The narration track is empty or incomplete, ` +
    `so do NOT read a short/absent cognitive[] as the operator having stayed silent. ` +
    `The raw audio is in audio/ and trace.json records per-segment status in transcript_segments. ` +
    `Please tell me this happened.`
  );
}

async function copyToClipboard(text) {
  // The service worker has no clipboard; the offscreen document (created with
  // the CLIPBOARD reason) does it via a textarea + execCommand. Awaited so the
  // busy gate releases exactly when the reference is on the clipboard.
  try {
    const r = await chrome.runtime.sendMessage({ __ocic_offscreen: true, cmd: "copy", text });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// Post-recording icon — same idea as REC while recording, so you see the
// outcome without hovering (icon AND tooltip). On success the icon is a
// clipboard (📋): the reference was copied to your clipboard. Delivery to
// Claude, if any, is appended to the tooltip. Auto-clears a few seconds after
// the last update; a new recording cancels the clear (see startRecording).
let resultClearTimer = null;
function scheduleBadgeClear() {
  if (resultClearTimer) clearTimeout(resultClearTimer);
  const ep = recorder.epoch; // this timer belongs to THIS result only
  resultClearTimer = setTimeout(() => {
    resultClearTimer = null;
    if (recorder.epoch === ep && !recorder.active && !recorder.busy) {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Open Claude in Chrome — click to start/stop recording" });
    }
  }, 4000);
}
function showResultBadge(kind, detail) {
  if (kind === "failed") {
    chrome.action.setBadgeText({ text: "✗" });
    chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
    chrome.action.setTitle({
      title: "Could not save the recording — is the native host installed? Run ./install.sh."
    });
  } else if (kind === "no_transcript") {
    // The recording IS saved — but its narration is missing or partial, which
    // for a teaching rollout is most of the value. It gets its own badge so it
    // can never be mistaken for the clean success state.
    chrome.action.setBadgeText({ text: "⚠" });
    chrome.action.setBadgeBackgroundColor({ color: "#a5701a" });
    chrome.action.setTitle({
      title: `Recording saved WITHOUT narration — ${detail}. Reference copied; the audio is on disk in audio/.`
    });
  } else {
    // "copied" — the reference is on your clipboard. Delivery-to-Claude info
    // arrives later and updates the TOOLTIP only (see stopRecording).
    chrome.action.setBadgeText({ text: "📋" });
    chrome.action.setBadgeBackgroundColor({ color: "#0e8a5f" });
    chrome.action.setTitle({
      title: "Recording saved · reference copied to clipboard — paste it into Claude Code."
    });
  }
  scheduleBadgeClear();
}

async function broadcastRecordingState(on) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null)
      chrome.tabs
        .sendMessage(t.id, { __ocic: "recording_state", on })
        .catch(() => {});
  }
}

async function startRecording() {
  // New transition: stale writers from any previous stop are dead from here.
  recorder.epoch++;
  if (resultClearTimer) {
    clearTimeout(resultClearTimer);
    resultClearTimer = null;
  }
  // Boot feedback at the INSTANT of the click — before the key validation
  // network call — so the icon never looks dead after a press.
  setProcessingBadge("Starting… validating key and warming up the microphone");
  const apiKey = await getApiKey();
  const v = await validateKey(apiKey);
  if (!v.ok) {
    // Surface via badge + a notification-free options nudge.
    chrome.action.setTitle({ title: `Cannot record: ${v.error}` });
    setBadge(false);
    return { ok: false, error: v.error };
  }
  await ensureOffscreen();
  recorder.recordingId = newRecordingId();
  recorder.startedAt = Date.now();
  recorder.imgSeq = 0;
  recorder.lastCapture = 0;
  const url0 = await activeTabUrl();
  // Warm-up continues: REC appears only when the offscreen doc reports the
  // mic ready (~2.5s later § muffled start).
  chrome.action.setTitle({ title: "Starting microphone… wait for REC before talking" });
  const startRes = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "start",
    recording_id: recorder.recordingId,
    started_at: recorder.startedAt,
    apiKey,
    url0
  });
  // Split-brain heal: the offscreen doc already has a live session (we lost
  // track of it, e.g. session-state loss this hydration couldn't cover).
  // ADOPT it — never clobber a recording in progress.
  if (startRes && startRes.already && startRes.session) {
    recorder.active = true;
    recorder.recordingId = startRes.session.recording_id;
    recorder.startedAt = startRes.session.started_at;
    setBadge(true);
    chrome.action.setTitle({ title: "Recording… click to stop" });
    persistRecorderState();
    return { ok: true, adopted: true };
  }
  // If the mic didn't start (permission not granted), fail LOUDLY — voice is
  // core to a recording. Guide the operator to enable it in Options rather
  // than silently capturing behavior with no narration.
  if (!startRes || !startRes.ok) {
    recorder.active = false;
    persistRecorderState();
    setBadge(false);
    const err = (startRes && startRes.error) || "microphone unavailable";
    chrome.action.setTitle({ title: `Can't record: ${err}` });
    chrome.runtime.openOptionsPage();
    return { ok: false, error: err };
  }
  recorder.active = true;
  setBadge(true);
  chrome.action.setTitle({ title: "Recording… click to stop" });
  persistRecorderState();
  await broadcastRecordingState(true);
  return { ok: true };
}

async function stopRecording() {
  const ep = ++recorder.epoch; // stale writers below check this before painting
  const live = () => recorder.epoch === ep;
  const tProc = Date.now();
  recorder.active = false;
  persistRecorderState();
  setProcessingBadge("Processing recording\u2026 (transcribing, saving, copying)");
  await broadcastRecordingState(false);
  const res = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "stop"
  });
  if (!res || !res.ok) {
    if (live()) chrome.action.setTitle({ title: "Recording failed to save." });
    return { ok: false, error: res && res.error };
  }
  const { bundle } = res;
  // 1) Persist to disk FIRST (reliability), before anything that can fail over
  // the network. The trace lands with transcript_status "pending" so the bundle
  // exists even if the steps below never complete.
  const path = await saveBundleToDisk(bundle).catch((e) => {
    console.error("save failed", e);
    return null;
  });
  if (!path) {
    if (live()) showResultBadge("failed");
    return { ok: false, error: "save failed" };
  }
  // 2) The AUDIO goes to disk next — still before transcription. This is the
  // one artifact that makes a failed transcript recoverable, and it used to
  // live only inside the browser profile where nothing could reach it.
  setProcessingBadge("Processing recording… (saving audio)");
  await saveAudioToDisk(bundle).catch((e) => console.error("audio save failed", e));

  // 3) Transcribe, segment by segment. A failure here is reported, never
  // swallowed: it reaches the trace, the badge, the clipboard and Claude.
  setProcessingBadge("Processing recording… (transcribing)");
  const tr = await chrome.runtime
    .sendMessage({ __ocic_offscreen: true, cmd: "transcribe" })
    .catch((e) => ({ ok: false, error: String(e && e.message) }));
  const transcriptStatus =
    tr && tr.ok ? tr.transcript_status : `failed: ${(tr && tr.error) || "transcription did not run"}`;
  if (tr && tr.ok) {
    bundle.trace.cognitive = tr.cognitive || [];
    bundle.trace.transcript_segments = tr.transcript_segments || [];
    if (tr.summary) bundle.summary = tr.summary;
  }
  bundle.trace.transcript_status = transcriptStatus;
  bundle.transcriptStatus = transcriptStatus;
  // Re-save the trace now that narration (or the reason there is none) is known.
  await saveBundleToDisk(bundle).catch((e) => console.error("re-save failed", e));

  // 4) Copy the reference to the clipboard — the primary, channel-independent
  // feedback. On a transcript failure the text says so, so pasting it into a
  // coding agent surfaces the problem instead of hiding it.
  await copyToClipboard(buildRecordingReference(path, transcriptStatus));
  // Hold the "…" long enough to be SEEN even when the pipeline was instant
  // (no audio -> no transcription): the stages must read consistently.
  const hold = 800 - (Date.now() - tProc);
  if (hold > 0) await sleep(hold);
  if (live()) {
    if (transcriptStatus === "ok") showResultBadge("copied");
    else showResultBadge("no_transcript", transcriptStatus);
  }
  recorder.busy = false; // reference on the clipboard: the icon is live again
  // Record the on-disk path on the session so the Options viewer can copy it too.
  chrome.runtime
    .sendMessage({ __ocic_offscreen: true, cmd: "set_path", recording_id: bundle.recording_id, path })
    .catch(() => {});
  // 3) Notify Claude (best-effort); append delivery to the tooltip when it resolves.
  // Delivery confirmation can arrive up to ~12s later. It must NEVER repaint
  // the badge (a new recording may be underway by then) — tooltip only, and
  // only while this stop is still the latest transition.
  const connectionState = await notifyClaude(bundle, path);
  if (live() && !recorder.active && !recorder.busy) {
    const deliv =
      connectionState === "delivered"
        ? " Also delivered to Claude Code."
        : connectionState === "sent_unconfirmed"
          ? " Sent to Claude — delivery not confirmed."
          : " No Claude Code session connected.";
    const head =
      transcriptStatus === "ok"
        ? "Recording saved · reference copied to clipboard — paste it into Claude Code."
        : `Recording saved WITHOUT narration — ${transcriptStatus}. Reference copied (it says so); audio is on disk in audio/.`;
    chrome.action.setTitle({ title: head + deliv });
  }
  return { ok: true, path, connectionState, transcriptStatus };
}

// Pull each audio segment back out of the offscreen document in slices and
// write it through the native host. Runs BEFORE transcription, so the raw
// narration is durable on disk no matter what the network does afterwards.
// Slices because runtime messages are JSON — a whole segment in one message
// would be needlessly large.
const AUDIO_SLICE_BYTES = 768 * 1024; // ~1MB once base64-encoded
async function saveAudioToDisk(bundle) {
  if (!nativePort || !bundle.audioSegments) return;
  for (const seg of bundle.audioSegments) {
    for (let start = 0; start < seg.size; start += AUDIO_SLICE_BYTES) {
      const r = await chrome.runtime.sendMessage({
        __ocic_offscreen: true,
        cmd: "audio_slice",
        index: seg.index,
        start,
        len: AUDIO_SLICE_BYTES
      });
      if (!r || !r.ok) throw new Error((r && r.error) || "audio slice failed");
      nativePort.postMessage({
        type: "save_audio",
        recording_id: bundle.recording_id,
        name: seg.name,
        b64: r.b64,
        append: start > 0
      });
    }
  }
}

// Disk write goes through the NATIVE HOST (a Node process with fs), not
// chrome.downloads — the browser download path pops an OS "save as" dialog on
// some setups even with saveAs:false, and this writes to a stable location
// (~/.config/open-claude-in-chrome/recordings/<id>/) the agent can open.
// trace.json is small text; the audio goes through save_audio (above) into
// audio/. Returns the absolute directory, or null if the host isn't reachable.
async function saveBundleToDisk(bundle) {
  if (!nativePort) return null;
  const schemaMd = await getSchemaMd();
  const done = new Promise((resolve) => {
    recorder.pendingSaves.set(String(bundle.recording_id), resolve);
    setTimeout(() => {
      if (recorder.pendingSaves.delete(String(bundle.recording_id))) resolve(null);
    }, 8000);
  });
  try {
    nativePort.postMessage({
      type: "save_recording",
      recording_id: bundle.recording_id,
      schema: bundle.schema || "v0",
      schema_md: schemaMd,
      trace: bundle.trace
    });
  } catch {
    recorder.pendingSaves.delete(String(bundle.recording_id));
    return null;
  }
  return await done;
}

// The versioned schema descriptor, shipped into each bundle so the agent knows
// how to read the trace. Read once from the packaged file, then cached.
let _schemaMd = null;
async function getSchemaMd() {
  if (_schemaMd != null) return _schemaMd;
  try {
    const res = await fetch(chrome.runtime.getURL("recorder/SCHEMA_v0.md"));
    _schemaMd = await res.text();
  } catch {
    _schemaMd = "";
  }
  return _schemaMd;
}

// Fire recording_complete upstream (→ native host → TCP → MCP server → channel
// notification). Then wait briefly for Claude's recording_ack to know delivery
// (§4). The native-host heartbeat tells us if any session is connected at all.
async function notifyClaude(bundle, path) {
  if (!nativePort) return "no_session"; // native host not connected
  try {
    nativePort.postMessage({
      type: "recording_complete",
      recording_id: bundle.recording_id,
      path: path || "",
      schema: bundle.schema,
      summary: bundle.summary,
      transcript_status: bundle.transcriptStatus || "ok"
    });
  } catch {
    return "no_session";
  }
  // Await ack up to ~12s.
  const acked = await waitForAck(bundle.recording_id, 12000);
  return acked ? "delivered" : "sent_unconfirmed";
}

function waitForAck(recordingId, timeoutMs) {
  if (recorder.deliveredIds.has(recordingId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (recorder.deliveredIds.has(recordingId)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 250);
  });
}


async function activeTabUrl() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.url || null;
  } catch {
    return null;
  }
}

// The icon is a start/stop toggle (§9 — non-negotiable). Hydrate first: after
// an SW eviction the in-memory flag is a lie, and acting on it destroys the
// in-flight recording.
chrome.action.onClicked.addListener(() => {
  recorderReady
    .then(() => {
      // Busy = booting the mic or processing a stop: the click is IGNORED.
      // The toggle is live only when idle, recording, or showing a result.
      if (recorder.busy) return;
      recorder.busy = true;
      const op = recorder.active ? stopRecording() : startRecording();
      return op.finally(() => {
        recorder.busy = false; // safety net; the copied-path clears it earlier
      });
    })
    .catch((e) => console.error("recorder toggle failed", e));
});

// Behavior events from content scripts → offscreen buffer. Tab segmentation.
// Every gate awaits hydration: an event arriving right after SW wake-up must
// still be forwarded to the (still-recording) offscreen buffer.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.__ocic === "behavior_event") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      const evt = { ...msg, tab: sender.tab?.id ?? -1, frame: sender.frameId ?? 0 };
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "event", event: evt })
        .catch(() => {});
      maybeCapture(msg.t); // frame anchored to this action (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "cursor_batch") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "cursor", points: msg.points })
        .catch(() => {});
      maybeCapture(); // frame during cursor activity (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "recorder_hello") {
    recorderReady.then(() => sendResponse({ on: recorder.active }));
    return true; // async response
  }
});

// Tab + navigation events, captured in the SW so the trace has one-to-one
// parity with OCIC's own commands (navigate, tab focus/create) — not just the
// computer-tool primitives. Each carries the tab's URL so the trace records
// what tab we're in and what the current URL is.
async function recordSwEvent(action, tabId, extra = {}) {
  await recorderReady; // SW may have just woken mid-recording
  if (!recorder.active) return;
  let url = extra.url;
  if (url === undefined && tabId != null && tabId >= 0) {
    try {
      const t = await chrome.tabs.get(tabId);
      url = t && t.url;
    } catch {
      url = undefined;
    }
  }
  chrome.runtime
    .sendMessage({
      __ocic_offscreen: true,
      cmd: "event",
      event: {
        t: Date.now(),
        tab: tabId ?? -1,
        frame: 0,
        action,
        // The core `command` key: the exact OCIC tool input (plus the event's
        // tab as tabId). tab_activated has NO OCIC verb — tools select tabs
        // via their tabId param — so it carries no command, only context.
        command:
          action === "navigate"
            ? { tool: "navigate", input: { url } }
            : action === "tab_opened"
              ? { tool: "tabs_create_mcp", input: {} }
              : action === "tab_closed"
                ? { tool: "tabs_close_mcp", input: {} }
                : undefined,
        url: url || undefined // context enrichment (what URL the tab shows)
      }
    })
    .catch(() => {});
  maybeCapture(); // frame on navigation / tab change (throttled ≤1/sec)
}

// Focus/select a tab → tab_activated (with the URL now showing).
chrome.tabs.onActivated.addListener((info) => recordSwEvent("tab_activated", info.tabId));
// Open a tab → tab_opened.
chrome.tabs.onCreated.addListener((tab) =>
  recordSwEvent("tab_opened", tab.id, { url: tab.url || tab.pendingUrl })
);
// Close a tab → tab_closed.
chrome.tabs.onRemoved.addListener((tabId) => recordSwEvent("tab_closed", tabId, { url: null }));
// URL change in a tab (address bar, link, redirect, SPA history) → navigate.
// This is what captures "the current state of the URL" as it changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) recordSwEvent("navigate", tabId, { url: changeInfo.url });
});

// --- Init ---

// Recover MCP tab group state after service worker restart
async function recoverTabGroupState() {
  try {
    const groups = await chrome.tabGroups.query({ title: "MCP" });
    if (groups.length > 0) {
      tabGroupId = groups[0].id;
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
    }
  } catch {
    // Not critical — will be set on first tabs_context_mcp call
  }
}

recoverTabGroupState();
connectNativeHost();
