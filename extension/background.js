// Background service worker for Open Claude in Chrome extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

import * as humanize from "./humanize/index.js";
import * as audit from "./audit/index.js";

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome";

// --- State ---
let nativePort = null;
let tabGroupId = null;
let tabGroupTabs = new Set();

// --- Per-call timing forensics -------------------------------------------
// Ring buffer of tool-call timings, persisted to chrome.storage.session so a
// worker restart doesn't lose the window we were trying to catch. Exists to
// pin down a field-observed failure mode: calls against certain tabs paying a
// flat ~1s quantum each (payload-independent), in windows lasting minutes.
// Read (and optionally clear) via the debug_timings tool.
const bootAt = Date.now();
const callTimings = [];
let timingsDirty = 0;
function recordTiming(entry) {
  callTimings.push(entry);
  if (callTimings.length > 600) callTimings.splice(0, callTimings.length - 600);
  if (++timingsDirty >= 20) {
    timingsDirty = 0;
    try {
      chrome.storage.session.set({ mcp_call_timings: callTimings.slice(), mcp_boot_at: bootAt });
    } catch {}
  }
}
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
// tabId -> Map<requestId, record> — lets responseReceived augment the entry
// created by requestWillBeSent instead of recording each request twice.
const networkByRequestId = new Map();
const screenshotStore = new Map(); // imageId -> base64
const screenshotSaves = new Map(); // reqId -> { resolve, reject } for save_to_disk

// Where the cursor currently is, PER TAB. Viewport coordinates are tab-local,
// so a single global cursor would start a move in tab B from tab A's position
// — meaningless, and anomalous in its own right. Seeded on first interaction,
// dropped when the tab closes.
const cursorByTab = new Map(); // tabId -> { x, y }

// One humanization "hand" for the life of the service worker: a seeded rng
// plus a persona (tempo, steadiness, overshoot). Reused across actions so a
// session is internally consistent rather than re-rolling its character every
// click. Lazily created — costs nothing when humanize is off.
let humanSession = null;
let humanSessionSeed = null; // the seed the live session was built from

/**
 * The humanization "hand" for this browser: one persona (tempo, steadiness,
 * overshoot) reused across actions and tabs, because a person does not become
 * someone else between clicks or when they switch tab.
 *
 * With humanize_seed unset the hand is random per service-worker lifetime,
 * which is what production wants — two sessions should not share a trajectory
 * signature. Pinning the seed rebuilds the session deterministically, so a
 * controlled comparison can hold the hand fixed and vary only the tier.
 */
function human(speed, seed) {
  const tier = speed || "fast";
  const wantSeed = typeof seed === "number" ? seed : null;
  if (!humanSession || wantSeed !== humanSessionSeed) {
    humanSession = humanize.createSession(wantSeed === null ? undefined : wantSeed, tier);
    humanSessionSeed = wantSeed;
  } else {
    humanize.setSpeed(humanSession, tier);
  }
  return humanSession;
}

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

// Browser-aware mouse ack strategy. Whether we're on Brave is stable for the
// life of the service worker, so cache the detection at module level and
// resolve it lazily (detectBrowser is async). null = not yet determined.
let IS_BRAVE = null;

async function isBrave() {
  if (IS_BRAVE === null) {
    IS_BRAVE = (await detectBrowser()) === "Brave";
  }
  return IS_BRAVE;
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
      } else if (msg.type === "screenshot_saved") {
        // Reply from the native host after writing a screenshot to disk
        // (save_to_disk on the computer tool's screenshot action).
        const pending = screenshotSaves.get(String(msg.id));
        if (pending) {
          screenshotSaves.delete(String(msg.id));
          if (msg.ok && msg.path) pending.resolve(msg.path);
          else pending.reject(new Error(msg.error || "failed to save screenshot"));
        }
      } else if (msg.id && pendingNative.has(msg.id)) {
        // Generic reply to a nativeRequest() (e.g. write_temp_file). The host
        // echoes the request id back so we can settle the matching promise.
        const p = pendingNative.get(msg.id);
        pendingNative.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "Native request failed")));
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      dbg("port", `native host disconnected`, { err: err && String(err.message).slice(0, 120) });
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

// --- Native host request/response (ask host to do something, wait for result) ---
// The recorder's save_* messages are fire-and-forget; upload_image needs a
// reply (the temp file path). pendingNative correlates a reply by id. Bound
// the wait so a lost reply can't hang a tool call past the CDP timeout.
const pendingNative = new Map(); // request id -> { resolve, reject }
let nativeReqSeq = 0;

function nativeRequest(msg) {
  return new Promise((resolve, reject) => {
    if (!nativePort) { reject(new Error("Native host not connected")); return; }
    const id = `nr_${Date.now()}_${nativeReqSeq++}`;
    pendingNative.set(id, { resolve, reject });
    nativePort.postMessage({ ...msg, id });
    setTimeout(() => {
      const p = pendingNative.get(id);
      if (p) { pendingNative.delete(id); p.reject(new Error("Native request timed out")); }
    }, CDP_TIMEOUT_MS);
  });
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

  // Create a new window with a tab, group it. focused:false — the window is
  // created and rendered, but does not jump in front of whatever the operator
  // is doing. set_tab_focus raises it on purpose when that is actually wanted.
  const win = await chrome.windows.create({ focused: false, url: "about:blank" });
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
// NOTE ON TAB ACTIVATION: nothing in here selects a tab or raises a window.
// Automation drives background tabs, so it never yanks the operator away from
// what they are doing — that interruption is the whole of issue #28, and it is
// also how the official Claude in Chrome behaves. The one deliberate exception
// is the set_tab_focus tool, which exists precisely so surfacing a tab is a
// choice the agent makes rather than a side effect of every click.
//
// The tradeoff: Chromium throttles a fully hidden tab's compositor, so input
// dispatched to one can be slower than to a visible tab. A tab in a visible
// window (even an unfocused one) still renders, which is the normal case here
// since the MCP group lives in its own window.

// Attach is not idempotent and not instant: two concurrent calls to a
// not-yet-attached tab both pass the `has` check and the second
// chrome.debugger.attach throws "Another debugger is already attached".
// Reachable by any two consumers hitting a cold tab at the same time.
// Concurrent callers share one in-flight attach.
const attachingTabs = new Map();
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  if (attachingTabs.has(tabId)) return attachingTabs.get(tabId);
  const attach = (async () => {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.set(tabId, { enabledDomains: new Set() });
  // No device-metrics emulation here. Screenshots get CSS-pixel framing from an
  // explicit capture clip instead (see takeScreenshot), which is more direct and
  // touches nothing about the page — no re-layout, no resize handlers fired.
  //
  // An earlier version of this comment claimed the override was what froze the
  // viewport against resize_window. That was wrong. The real cause is below:
  // Chrome does not re-layout a tab that is not the SELECTED tab in its window,
  // and since #28 we never select tabs. Removing the override did not change
  // that, and restoring it would not either.
  //
  // Builds before this one DID install an override (at the outer window size,
  // which is larger than the viewport, so pages laid out for a size that did not
  // exist). A tab attached by one of those builds still carries it, so clear it
  // once here rather than inheriting a stale viewport from whatever ran before.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {});
  } catch {}
  // Make the tab behave as focused/active for input purposes WITHOUT selecting
  // it. Since we stopped foregrounding tabs (#28), a driven tab is often not
  // the selected one, and Chromium throttles a hidden tab: synthesized
  // mousePressed/mouseReleased can be dropped outright — observed as clicks
  // that reach the page as zero mousedown/mouseup events. This is the same
  // primitive headless automation uses to drive unfocused pages, and it is
  // what lets "never steal the operator's focus" and "input actually lands"
  // both hold. Best-effort: older builds without it just keep the old
  // behaviour rather than failing the attach.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  } catch (e) {
    // Without this, input to an unselected tab can be dropped outright, so a
    // silent failure here turns into clicks that vanish with no other trace.
    dbg("cdp", "Emulation.setFocusEmulationEnabled FAILED — input to unselected tabs may be dropped",
        { tab: tabId, err: String(e && e.message).slice(0, 120) });
    console.warn("setFocusEmulationEnabled unavailable:", e.message);
  }
  })();
  attachingTabs.set(tabId, attach);
  try {
    await attach;
  } catch (e) {
    // Failed attach must not leave a half-registered tab behind.
    attachedTabs.delete(tabId);
    throw e;
  } finally {
    attachingTabs.delete(tabId);
  }
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
  const t0 = Date.now();
  try {
    const out = await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      CDP_TIMEOUT_MS,
      `CDP ${method}`
    );
    dbg("cdp", `${method}${cdpDetail(method, params)}`, { tab: tabId, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    dbg("cdp", `${method}${cdpDetail(method, params)}`, {
      tab: tabId, ms: Date.now() - t0, err: String(e && e.message).slice(0, 120)
    });
    throw e;
  }
}

// A short, useful summary of a CDP call: the parameters that matter for
// diagnosis (where an input went, which key, how far a scroll) without dumping
// entire payloads such as screenshot bytes into the log.
function cdpDetail(method, p) {
  if (!p) return "";
  if (method === "Input.dispatchMouseEvent")
    return ` ${p.type}(${p.x},${p.y})${p.deltaY ? ` dy=${p.deltaY}` : ""}${p.button && p.type !== "mouseMoved" ? ` ${p.button}` : ""}`;
  if (method === "Input.dispatchKeyEvent")
    return ` ${p.type} ${JSON.stringify(p.key || "")}${p.autoRepeat ? " repeat" : ""}`;
  if (method === "Input.insertText") return ` ${JSON.stringify(String(p.text).slice(0, 20))}`;
  if (method === "Runtime.evaluate") return ` ${JSON.stringify(String(p.expression || "").slice(0, 60))}`;
  if (method === "Input.synthesizeScrollGesture") return ` (${p.x},${p.y}) y=${p.yDistance}`;
  return "";
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
  networkByRequestId.delete(tabId);
  cursorByTab.delete(tabId);
  // Drop any per-tab config override too: tab ids are recycled by the browser,
  // so a stale override would silently apply to an unrelated future tab.
  if (configState.byTab[String(tabId)]) {
    const byTab = { ...configState.byTab };
    delete byTab[String(tabId)];
    configState.byTab = byTab;
    chrome.storage.session.set({ [TAB_CONFIG_KEY]: byTab }).catch(() => {});
  }
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

  // Merge CDP network events into one record per requestId so the reader
  // sees each request once. requestWillBeSent carries the real method + url;
  // responseReceived augments that same record with the status. A requestId
  // is reused across redirect hops, so a later event updates the existing
  // record in place rather than appending a duplicate.
  if (method === "Network.responseReceived" && params.response) {
    recordNetworkEvent(tabId, params.requestId, (existing) => ({
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      type: params.type || (existing && existing.type) || "Other",
      // method + url come from requestWillBeSent; fall back to the old
      // heuristic only when no earlier event was seen for this id.
      method: (existing && existing.method) || (params.response.requestHeaders ? "?" : "GET"),
      url: (existing && existing.url) || params.response.url,
      timestamp: (existing && existing.timestamp) || Date.now(),
    }));
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    recordNetworkEvent(tabId, params.requestId, (existing) => ({
      url: params.request.url,
      method: params.request.method,
      type: params.type || (existing && existing.type) || "Other",
      status: (existing && existing.status) || 0,
      timestamp: (existing && existing.timestamp) || Date.now(),
    }));
  }
});

// Append (or update) one entry for a network event, keyed by requestId.
// makeRecord(existing) returns the fields to merge; when a record already
// exists for the id (a duplicate event or a redirect hop) it is patched
// in place so the request appears exactly once in the reader's list.
function recordNetworkEvent(tabId, requestId, makeRecord) {
  const reqs = networkRequests.get(tabId) || [];
  let byId = networkByRequestId.get(tabId);
  if (!byId) {
    byId = new Map();
    networkByRequestId.set(tabId, byId);
  }

  const existing = byId.get(requestId);
  if (existing) {
    Object.assign(existing, makeRecord(existing));
    return;
  }

  const record = makeRecord(null);
  reqs.push(record);
  byId.set(requestId, record);

  if (reqs.length > 1000) {
    const evicted = reqs.splice(0, reqs.length - 1000);
    // Drop the requestId lookups for evicted records so a reused id does
    // not resurrect a stale entry.
    const evictedSet = new Set(evicted);
    for (const [id, rec] of byId) {
      if (evictedSet.has(rec)) byId.delete(id);
    }
  }
  networkRequests.set(tabId, reqs);
}

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
// Resolve a ref to the point to dispatch at, scrolling the element into view
// first so the point is actually reachable. Returns the full record (not just
// the pair) so callers can report interception.
async function resolveRefToCoordinates(tabId, ref, opts = {}) {
  const resp = await sendContentMessage(tabId, {
    type: "getRefCoordinates",
    ref,
    scrollIntoView: opts.scrollIntoView !== false
  });
  return resp?.result || null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // Capture at EXACTLY CSS-pixel dimensions, because the agent reads click
  // coordinates off this image and clicks are dispatched in CSS pixels. On a
  // 1.5x display an uncorrected capture of a 1008x632 viewport comes back
  // 1512x948, so an agent told to "click what you see" aims 1.5x off and
  // misses everything.
  //
  // The capture is rasterised at the display's pixel ratio, so on a scaled
  // display the image comes back larger than the CSS viewport and every
  // coordinate read off it is wrong by that factor. Undo it in the capture
  // itself: clip to the viewport and scale by 1/ratio, which yields an image
  // whose pixels ARE CSS pixels. Emulation would also achieve this, but at the
  // cost of freezing the viewport (see ensureAttached).
  let clip = null;
  try {
    const vp = await cdp(tabId, "Runtime.evaluate", {
      expression: "JSON.stringify([innerWidth, innerHeight, devicePixelRatio])",
      returnByValue: true
    });
    const [vw, vh, dpr] = JSON.parse(vp.result.value);
    if (vw > 0 && vh > 0) {
      clip = { x: 0, y: 0, width: vw, height: vh, scale: 1 / (dpr > 0 ? dpr : 1) };
    }
  } catch {}

  const shot = async (quality) => {
    const params = { format: "jpeg", quality, optimizeForSpeed: true, captureBeyondViewport: false };
    if (clip) params.clip = clip;
    return (await cdp(tabId, "Page.captureScreenshot", params)).data;
  };

  let base64 = await shot(45);

  // If still too large (>350KB base64 ≈ ~262KB binary), reduce quality further
  if (base64.length > 350000) {
    base64 = await shot(28);
  }

  // The coordinate space this image is in — the single fact that made screenshot
  // bugs invisible for so long. The response reports dimensions; it says nothing
  // about the pixel ratio the capture was rasterised at, the clip scale used to
  // undo it, or whether a quality retry fired. An agent reading coordinates off
  // this image is trusting every one of those.
  dbg(
    "cdp",
    `screenshot ${clip ? `${clip.width}x${clip.height} CSS px, dpr ${Math.round((1 / clip.scale) * 100) / 100}, clip scale ${Math.round(clip.scale * 1000) / 1000}` : "NO CLIP — image is in device pixels, not CSS pixels"}` +
      ` -> ${Math.round((base64.length * 3) / 4 / 1024)}KB${base64.length > 350000 ? " (after quality retry)" : ""}`,
    { tab: tabId }
  );

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// Write a captured base64 screenshot to disk via the native host and resolve
// with the absolute path. Used when the computer tool's screenshot action is
// called with save_to_disk: true. The native host replies with `screenshot_saved`.
function writeScreenshotToDisk(base64) {
  if (!nativePort) return Promise.reject(new Error("native host not connected"));
  const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    screenshotSaves.set(id, { resolve, reject });
    nativePort.postMessage({
      type: "save_screenshot_to_disk",
      id,
      dataUrl: "data:image/jpeg;base64," + base64,
    });
    // Guard against a dead native host so callers never hang forever.
    setTimeout(() => {
      if (screenshotSaves.has(id)) {
        screenshotSaves.delete(id);
        reject(new Error("timed out waiting for native host to save screenshot"));
      }
    }, 5000);
  });
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
const INPUT_ACK_WAIT_MS = 250; // Brave: bounded wait for fire-and-forget (mouseWheel never acks)
const CHROME_INPUT_ACK_WAIT_MS = 50; // Chrome: acks instantly, a short window suffices

async function sendMouseEvent(tabId, params, { awaitAck = true, noAck = false } = {}) {
  await ensureAttached(tabId);
  const t0 = Date.now();
  dbg("input", `${params.type}(${params.x},${params.y})${params.deltaY ? ` dy=${params.deltaY}` : ""}${noAck ? " noack" : awaitAck ? "" : " raced"}`,
      { tab: tabId, x: params.x, y: params.y });
  const send = withTimeout(
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", params),
    CDP_TIMEOUT_MS,
    "CDP Input.dispatchMouseEvent",
  );
  if (noAck) {
    // Queue it and move on WITHOUT waiting for the ack at all.
    //
    // This exists for humanized motion, where the ack round-trip — not the
    // modelled timing — is the real cost: a natural click plans ~0.8s of
    // delays but measured ~3.9s in the browser, because each of ~45 moves
    // waited ~85ms for its ack. Cursor moves need no ack (they apply
    // regardless, and the plan carries its own pacing in sleep steps), so
    // waiting only buys latency. Press/release still use the awaited path,
    // since those ARE dropped if issued while an earlier command is un-acked.
    // A failure arriving after we stopped waiting is precisely the case where
    // the stream would otherwise show a clean dispatch for an event that never
    // landed. Record it against the coordinates it was meant for.
    send.catch((e) => {
      dbg("input", `${params.type}(${params.x},${params.y}) FAILED AFTER SEND (noack) — nothing received it`,
          { tab: tabId, x: params.x, y: params.y, err: String(e && e.message).slice(0, 120) });
      console.warn("Input.dispatchMouseEvent (noAck):", e.message);
    });
    return;
  }
  if (awaitAck) {
    await send; // serial-await path (required on Brave: press/release dropped if not awaited)
    return;
  }
  // Fire-and-forget path (mouseWheel, and Chrome mouseMoved): wait for the ack
  // only up to a bounded window so Brave's ~5s-stalled acks don't block us.
  // Brave needs the full window; Chrome acks instantly, so a short one suffices.
  const ackWaitMs = (await isBrave()) ? INPUT_ACK_WAIT_MS : CHROME_INPUT_ACK_WAIT_MS;
  await Promise.race([
    send.catch((e) => {
      dbg("input", `${params.type}(${params.x},${params.y}) LATE FAILURE — dispatch did not take`,
          { tab: tabId, x: params.x, y: params.y, err: String(e && e.message).slice(0, 120) });
      console.warn("Input.dispatchMouseEvent late ack/failure:", e.message);
    }),
    sleep(ackWaitMs),
  ]);
}

async function dispatchMouse(tabId, type, x, y, opts = {}) {
  if (opts.noAck) {
    await sendMouseEvent(
      tabId,
      { type, x, y, button: opts.button || "left", clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 },
      { noAck: true }
    );
    return;
  }
  // Chrome acks instantly and applies immediately, so the mouseMoved "move"
  // sub-event needs no ack and can be fire-and-forget (awaitAck:false). Brave
  // must keep the serial-await path (its moves silently drop if not awaited).
  const awaitAck = opts.awaitAck ?? (type === "mouseMoved" ? await isBrave() : true);
  await sendMouseEvent(
    tabId,
    {
      type,
      x,
      y,
      button: opts.button || "left",
      clickCount: opts.clickCount || 1,
      modifiers: opts.modifiers || 0,
    },
    { awaitAck },
  );
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  // Humanized: approach along a curved path from wherever this tab's cursor
  // actually is, land on the requested point, press/release with real dwell.
  if (await humanizeOn(tabId)) {
    const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
    const from = cursorByTab.get(tabId) || { x: Math.max(0, x - 220), y: Math.max(0, y - 160) };
    await dispatchPlan(
      tabId,
      humanize.planClick(s, from, { x, y }, { button, clickCount, targetSize: opts.targetSize }),
      modifiers
    );
    return;
  }

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  // Brave's debugger pipeline needs a ~50ms settle window between dispatched
  // events (verified empirically); Chrome acks instantly, so the sleeps are
  // pure latency there and are dropped to keep clicks snappy.
  const brave = await isBrave();
  if (brave) await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  if (brave) await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
  cursorByTab.set(tabId, { x, y });
}

// --- Humanization config + plan execution -----------------------------------
//
// The behavioural modelling lives in extension/humanize/ (pure, no browser
// APIs). Everything below is the thin seam: read the flag, walk a plan, map
// each primitive step onto the CDP call the non-humanized path already uses.

const CONFIG_KEY = "ocic_config_v1";       // { default: {...} } in local
const TAB_CONFIG_KEY = "ocic_tab_config_v1"; // { [tabId]: {...} } in session

// Recognized settings, and what they do when true. `get_config` reports this
// catalog, so adding a setting later means adding one entry here and reading
// effectiveConfig(tabId).<key> where it applies — set_config never changes.
const CONFIG_SCHEMA = {
  humanize:
    "Drive mouse and keyboard the way a person would: curved cursor paths with " +
    "acceleration and overshoot, clicks that land off-centre inside the target " +
    "with a real press dwell, scrolls decomposed into momentum ticks, and typing " +
    "with per-character keydown/keyup and human inter-key timing. Outcomes are " +
    "identical (same element, same text, same scroll position) — only the motion " +
    "and timing change, so actions take noticeably longer. Default false.",
  humanize_speed:
    "How much time humanized motion is allowed to take, fastest to slowest: " +
    "\"fastest\", \"fast\" (default), \"natural\", \"relaxed\". Higher tiers " +
    "spend more time and draw cursor paths with more samples. \"natural\" is " +
    "genuine human cadence; \"fastest\" keeps the shape of human motion but " +
    "compresses it, for when there is a lot to get through. Every tier keeps " +
    "movement before the click, real key events and identical outcomes — faster " +
    "tiers use fewer path samples and shorter pauses, never none. Only applies " +
    "while humanize is true.",
  audit_mode:
    "Passively record what this agent does in the browser, so a person can watch " +
    "it back. \"off\" (default) records nothing and costs nothing. \"audit\" " +
    "starts an rrweb DOM recording in each tab the first time an action touches " +
    "it, and stitches those into one timeline per Claude Code session, viewable " +
    "under Audits on the extension's options page. Recording runs in the " +
    "extension's isolated world, so the page cannot observe it, and captures DOM " +
    "rather than pixels — video and canvas content are not captured. This is a " +
    "mode rather than a flag because a future \"teach\" mode wants the opposite " +
    "masking defaults."
};

const AUDIT_MODES = ["off", "audit"];
let configState = {
  default: { humanize: false, humanize_speed: "fast", humanize_seed: null, audit_mode: "off" },
  byTab: {}
};
let configHydrated = null;

async function hydrateConfig() {
  try {
    const local = await chrome.storage.local.get(CONFIG_KEY);
    const session = await chrome.storage.session.get(TAB_CONFIG_KEY);
    configState = {
      default: {
        humanize: false, humanize_speed: "fast", humanize_seed: null, audit_mode: "off",
        ...(local[CONFIG_KEY] || {})
      },
      byTab: session[TAB_CONFIG_KEY] || {}
    };
  } catch {}
  return configState;
}
// MV3 evicts this worker, so re-hydrate at every start and keep the cache live.
configHydrated = hydrateConfig().then((c) => {
  audit.setEnabled(c.default.audit_mode === "audit");
  return c;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CONFIG_KEY]) {
    configState.default = { humanize: false, audit_mode: "off", ...(changes[CONFIG_KEY].newValue || {}) };
    audit.setEnabled(configState.default.audit_mode === "audit");
  }
  if (area === "session" && changes[TAB_CONFIG_KEY]) {
    configState.byTab = changes[TAB_CONFIG_KEY].newValue || {};
  }
});

/** Per-tab overrides win over the default. */
function effectiveConfig(tabId) {
  return { ...configState.default, ...(configState.byTab[String(tabId)] || {}) };
}

async function humanizeOn(tabId) {
  await configHydrated;
  return !!effectiveConfig(tabId).humanize;
}

async function writeConfig(key, value, tabId) {
  await configHydrated;
  if (tabId === undefined || tabId === null) {
    const next = { ...configState.default };
    if (value === null) delete next[key];
    else next[key] = value;
    configState.default = next;
    await chrome.storage.local.set({ [CONFIG_KEY]: next });
    return next;
  }
  const id = String(tabId);
  const byTab = { ...configState.byTab };
  const forTab = { ...(byTab[id] || {}) };
  if (value === null) delete forTab[key];
  else forTab[key] = value;
  if (Object.keys(forTab).length) byTab[id] = forTab;
  else delete byTab[id];
  configState.byTab = byTab;
  // Per-tab overrides live in session storage: tab ids are session-scoped, so
  // persisting them past a browser restart would attach settings to unrelated
  // future tabs.
  await chrome.storage.session.set({ [TAB_CONFIG_KEY]: byTab });
  return effectiveConfig(tabId);
}

/**
 * Execute a humanize plan. The ONLY place plans meet the browser: each step is
 * dispatched through the same CDP calls the non-humanized path uses, so a
 * humanized action cannot do anything a normal one could not.
 */
async function dispatchPlan(tabId, plan, modifiers = 0) {
  await ensureAttached(tabId);
  for (const step of plan) {
    switch (step.k) {
      case "sleep":
        await sleep(step.ms);
        break;
      case "move":
        // awaitAck:false is load-bearing here. A humanized path dispatches
        // dozens of mouseMoved events, and on some Chromium builds each one
        // can sit ~5s waiting for a debugger ack — 26 moves then blow past the
        // 60s tool timeout (observed). The plan already carries its own timing
        // in the sleep steps, and moves apply without their ack, so nothing is
        // lost by not waiting. Press/release still await (they are dropped if
        // issued while an earlier command is un-acked).
        await dispatchMouse(tabId, "mouseMoved", step.x, step.y, { modifiers, noAck: true });
        cursorByTab.set(tabId, { x: step.x, y: step.y });
        break;
      case "down":
        await dispatchMouse(tabId, "mousePressed", step.x, step.y, {
          button: step.button, clickCount: step.clickCount, modifiers
        });
        break;
      case "up":
        await dispatchMouse(tabId, "mouseReleased", step.x, step.y, {
          button: step.button, clickCount: step.clickCount, modifiers
        });
        cursorByTab.set(tabId, { x: step.x, y: step.y });
        break;
      case "wheel":
        await sendMouseEvent(
          tabId,
          { type: "mouseWheel", x: step.x, y: step.y, deltaX: step.dx, deltaY: step.dy, modifiers },
          { noAck: true }
        );
        break;
      case "kdown":
        // rawKeyDown is the NON-text-producing variant: it gives the page a
        // keydown event without the renderer inserting a character. All text
        // comes from the "text" step below, exactly once.
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: step.key,
          code: step.code,
          windowsVirtualKeyCode: step.keyCode || 0,
          modifiers: step.mods || 0,
          autoRepeat: !!step.autoRepeat
        });
        break;
      case "kup":
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: step.key,
          code: step.code,
          windowsVirtualKeyCode: step.keyCode || 0,
          modifiers: step.mods || 0
        });
        break;
      case "text":
        await cdp(tabId, "Input.insertText", { text: step.text });
        break;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- What a coordinate-based action actually landed on -----------------------
//
// A dispatch always "succeeds": the events go out whether or not anything is
// there to receive them. So a perfect hit, a click into empty space, and a
// click swallowed by a transparent overlay all used to return the identical
// `Clicked at (x, y)` and nothing else — the caller could not tell them apart
// without instrumenting the page itself. Every click-accuracy bug found so far
// was invisible for exactly this reason.
//
// Resolving the point through the content script (isolated world) lets the
// answer include the ref of whatever is there, in the same ref space that
// read_page and find hand out. Best-effort throughout: this is an observability
// aid, so a failure here must never fail the action it is describing.
// Probe what is at a point. Split into three pieces on purpose: the probe, the
// full descriptor, and the (usually empty) response note.
//
// The tool response is deliberately silent when a click lands cleanly, because
// annotating every successful click would be noise on the overwhelmingly common
// path. But "omitted from the response" must not mean "discarded": the debug
// stream is where everything the response leaves out is supposed to end up, so
// the descriptor is computed once and always recorded, whatever the response
// chooses to say.
async function probeHit(tabId, x, y) {
  try {
    const resp = await sendContentMessage(tabId, { type: "describePoint", x, y });
    const r = resp && resp.result;
    return r ? { ok: true, r } : { ok: false, err: "content script returned no result" };
  } catch (e) {
    return { ok: false, err: String(e && e.message).slice(0, 120) };
  }
}

// Compact one-line descriptor for the debug stream. Always produced — including
// on the success path, where the response itself says nothing.
function formatHit(p) {
  if (!p.ok) {
    // A failed probe is NOT a clean hit. Saying so explicitly is the whole
    // point: silence here would be indistinguishable from success.
    return `PROBE FAILED (${p.err}) — nothing is known about what is at this point`;
  }
  const r = p.r;
  const vp = r.viewport ? r.viewport.join("x") : "?";
  if (!r.hit) {
    return r.outside
      ? `NOTHING — point lies outside the ${vp} viewport`
      : `NOTHING — no element at that point in the ${vp} viewport`;
  }
  const h = r.hit;
  const a = h.attrs || {};
  const id = a.id ? `#${a.id}` : "";
  const cls = h.cls ? `.${h.cls}` : "";
  const extra = [];
  if (a["data-testid"] || a["data-test"]) extra.push(`testid=${a["data-testid"] || a["data-test"]}`);
  if (a.role) extra.push(`role=${a.role}`);
  if (a["aria-label"]) extra.push(`aria="${a["aria-label"]}"`);
  if (a.name) extra.push(`name=${a.name}`);
  if (a.type) extra.push(`type=${a.type}`);
  if (h.ref) extra.push(h.ref);
  const text = h.text ? ` "${h.text}"` : "";
  return `<${h.tag}${id}${cls}>${text}${extra.length ? " " + extra.join(" ") : ""}` +
    `${r.bare ? " (page background)" : ""} in ${vp} viewport`;
}

// The response note. Silent on success; only the two cases a caller cannot
// otherwise detect get a word. A failed probe stays silent here too — it is a
// fault in the instrument, not a finding about the click, and it is recorded in
// the debug stream instead of being guessed at in the result.
function hitNote_(p) {
  if (!p.ok) return "";
  const r = p.r;
  if (r.hit && !r.bare && !r.deadLabel) return "";
  const vp = r.viewport ? `${r.viewport[0]}x${r.viewport[1]}` : "the";
  // A label with no activatable control and no interactive ancestor: browsers
  // forward activation only for a label actually wired to a live control, so
  // nothing native is guaranteed to receive this click. It may still be caught
  // by a delegated handler we can't see, so warn rather than claim it failed.
  if (r.deadLabel) {
    return ` — WARNING: landed on a <label> whose control is missing or disabled, so the click may not have activated the widget it labels. Pass the control's ref instead of raw coordinates if that widget was intended.`;
  }
  if (!r.hit) {
    return r.outside
      ? ` — WARNING: nothing received this. The point is outside the ${vp} viewport, so it landed on no element. Pass the element's ref instead of raw coordinates and it will be scrolled into view automatically.`
      : ` — WARNING: no element at that point in the ${vp} viewport, so nothing received this.`;
  }
  return ` — WARNING: landed on <${r.hit.tag}> (page background), not on any element. Pass the element's ref instead of raw coordinates and it will be scrolled into view automatically.`;
}


// --- Debug recorder ----------------------------------------------------------
//
// One flat, timestamped event stream covering everything this extension does:
// tool calls, CDP commands and their durations, dispatched input with its
// coordinates, what each click actually landed on, and native-host connection
// changes. Read it with the `debug` tool.
//
// It exists so a failure can be SEEN rather than reconstructed. Several bugs
// here (clicks landing on nothing, screenshots in the wrong coordinate space,
// a resize the window manager refused) were invisible because success and
// failure produced identical output, and each took hours of forensics.
//
// Two rules, because a feedback channel that lies is worse than none:
//
//   1. Recording must never affect what it records. Every entry point is
//      wrapped so a fault in here can never fail, slow, or alter a real
//      action. Recording is a plain array push.
//   2. Absence of a record must never look like absence of an event. The
//      buffer is bounded and lives in a service worker that MV3 evicts, so
//      both limits are reported explicitly on every read: how many events were
//      dropped, and how far back the buffer actually reaches. A reader is told
//      what is NOT in here, not left to assume the silence is meaningful.
const DEBUG_MAX = 1000;
const debugLog = [];
let debugDropped = 0;
const debugBootedAt = Date.now();

// What the caller actually ASKED for. A tool response never echoes its own
// arguments, so without this the stream cannot answer the first question you
// ask of any log entry: what was this call, exactly?
function argSummary(args) {
  if (!args || typeof args !== "object") return "(no args)";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "tabId") continue; // already carried on the entry itself
    let out;
    if (typeof v === "string") {
      out = v.length > 60 ? JSON.stringify(v.slice(0, 60)) + `…+${v.length - 60}ch` : JSON.stringify(v);
    } else if (Array.isArray(v)) {
      out = `[${v.slice(0, 4).join(",")}${v.length > 4 ? ",…" : ""}]`;
    } else if (v && typeof v === "object") {
      out = "{…}";
    } else {
      out = String(v);
    }
    parts.push(`${k}=${out}`);
  }
  return parts.length ? parts.join(" ") : "(no args)";
}

// What the response LEAVES OUT about itself: how much came back, and the size
// of any image. Deliberately NOT the response text — the caller already has
// that, and echoing it here would make the stream a duplicate rather than a
// record of what was omitted.
function resultShape(result) {
  const items = (result && result.content) || [];
  let chars = 0, images = 0, b64 = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.type === "text" && typeof it.text === "string") chars += it.text.length;
    else if (it.type === "image" && typeof it.data === "string") { images++; b64 += it.data.length; }
  }
  const bits = [];
  if (chars) bits.push(`${chars}ch`);
  if (images) bits.push(`${images} image ${Math.round((b64 * 3) / 4 / 1024)}KB`);
  return bits.length ? bits.join(" + ") : "empty";
}

function dbg(kind, detail, extra) {
  try {
    const e = { t: Date.now(), kind, detail: String(detail).slice(0, 300) };
    if (extra && typeof extra === "object") {
      for (const k of ["tab", "ms", "x", "y", "err"]) {
        if (extra[k] !== undefined && extra[k] !== null) e[k] = extra[k];
      }
    }
    debugLog.push(e);
    if (debugLog.length > DEBUG_MAX) {
      debugDropped += debugLog.length - DEBUG_MAX;
      debugLog.splice(0, debugLog.length - DEBUG_MAX);
    }
  } catch {
    // A recorder that throws would take down the action it is observing.
  }
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
    // Create the tab INSIDE the MCP group's own window and do NOT select it:
    // automation must never yank the operator away from what they are looking
    // at. Without windowId the tab lands in whatever window is currently
    // focused — i.e. the operator's — which is exactly the interruption we
    // are avoiding. Use the set_tab_focus tool to surface a tab deliberately.
    let windowId;
    try {
      const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
      windowId = groupTabs[0]?.windowId;
    } catch {}
    const tab = await chrome.tabs.create(
      windowId ? { active: false, windowId } : { active: false }
    );
    await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
    tabGroupTabs.add(tab.id);
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
    const { url, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      // chrome-extension: is allowed so the agent can reach this extension's own
      // pages — the options page is where audits and recordings are reviewed,
      // and without this it was the one destination the browser tool could not
      // open, silently turning into https://chrome-extension://...
      if (
        !targetUrl.match(/^https?:\/\//i) &&
        !targetUrl.startsWith("about:") &&
        !targetUrl.startsWith("chrome:") &&
        !targetUrl.startsWith("chrome-extension:") &&
        !targetUrl.startsWith("brave:")
      ) {
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
    // Resolve ref to coordinates if provided. This scrolls the element into
    // view first: coordinates are viewport-relative, so an element that is off
    // screen has coordinates no dispatch can reach, and the click would land on
    // the document root instead of the thing that was named.
    let refCovering = null;
    if (args.ref && !coordinate) {
      const res = await resolveRefToCoordinates(tabId, args.ref);
      if (!res) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates. The page may have changed — re-run read_page or find for a fresh ref.` }] };
      if (!res.reachable) {
        return { content: [{ type: "text", text: `Could not bring ref "${args.ref}" into view — it is still outside the viewport after scrolling, so a click there would land on the page background rather than the element. It may be inside a container that needs scrolling separately, or hidden.` }] };
      }
      coordinate = [res.x, res.y];
      refCovering = res.covering;
      if (res.scrolledFrom) {
        // The coordinates just changed underneath the caller. Recording it is
        // what stops a reader of the log concluding no scroll took place.
        dbg(
          "hit",
          `${args.ref} scrolled into view: (${res.scrolledFrom[0]},${res.scrolledFrom[1]}) -> (${res.x},${res.y})`,
          { tab: tabId }
        );
      }
    }

    const modifiers = parseModifierString(args.modifiers);

    // Probe BEFORE dispatching: the action itself can change what is under the
    // point, so an after-the-fact test would describe the consequence rather
    // than the target. For a drag the meaningful point is where the grab
    // happens, not where it is released.
    const HIT_PROBED = ["left_click", "right_click", "double_click", "triple_click", "hover", "scroll"];
    let hitNote = "";
    if (args.ref && coordinate) {
      // Resolving the ref already scrolled it into view and hit-tested the
      // result, so there is nothing left to check — only interception is worth
      // mentioning, and it is deliberately not auto-corrected: a person
      // clicking there would hit the same thing.
      if (refCovering) {
        hitNote = ` — NOTE: <${args.ref}> is covered at that point by ${refCovering}, which received this instead.`;
        dbg("hit", `${args.ref} @(${coordinate[0]},${coordinate[1]}) COVERED BY ${refCovering}`, { tab: tabId });
      } else {
        dbg("hit", `${args.ref} @(${coordinate[0]},${coordinate[1]}) reachable`, { tab: tabId });
      }
    } else if (HIT_PROBED.includes(action) && coordinate) {
      const probe = await probeHit(tabId, coordinate[0], coordinate[1]);
      hitNote = hitNote_(probe);
      dbg("hit", `@(${coordinate[0]},${coordinate[1]}) ${formatHit(probe)}`, { tab: tabId, x: coordinate[0], y: coordinate[1] });
    } else if (action === "left_click_drag" && args.start_coordinate) {
      const probe = await probeHit(tabId, args.start_coordinate[0], args.start_coordinate[1]);
      hitNote = hitNote_(probe);
      dbg("hit", `drag start @(${args.start_coordinate[0]},${args.start_coordinate[1]}) ${formatHit(probe)}`,
          { tab: tabId, x: args.start_coordinate[0], y: args.start_coordinate[1] });
    }

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
        // save_to_disk: write the captured image to disk and report the path so
        // Claude Code can open it. Best-effort — never fails the screenshot.
        let saveNote = "";
        if (args.save_to_disk) {
          try {
            const path = await writeScreenshotToDisk(base64);
            saveNote = `\nSaved to disk: ${path}`;
          } catch (e) {
            saveNote = `\n(Unable to save to disk: ${e.message})`;
          }
        }
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}${saveNote}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
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
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        if (await humanizeOn(tabId)) {
          // Curved approach, then park STILL. No tremor while holding: a hover
          // exists to keep a tooltip/menu open, and jitter near an element edge
          // can cross the boundary, fire mouseleave and dismiss it.
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId) || { x: Math.max(0, coordinate[0] - 200), y: Math.max(0, coordinate[1] - 150) };
          await dispatchPlan(tabId, humanize.planHover(s, from, { x: coordinate[0], y: coordinate[1] }), modifiers);
          return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
        }
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        cursorByTab.set(tabId, { x: coordinate[0], y: coordinate[1] });
        // Let the page apply the hover state; Brave additionally needs a settle
        // window, Chrome doesn't.
        if (await isBrave()) await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        if (await humanizeOn(tabId)) {
          // Same key events as the default path below, but with human-shaped
          // inter-key timing instead of a flat interval.
          await dispatchPlan(tabId, humanize.planType(human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed), args.text));
          return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
        }
        // Default path: emit real keydown/keyup around each character.
        //
        // Measured against the official Claude in Chrome on an instrumented
        // page: its `type` delivers a keydown+keyup per character with correct
        // `code` values. Insertion-only (bare insertText) delivered ZERO key
        // events, so pages that gate on keydown — search-as-you-type, key
        // validators, shortcut handlers — saw nothing. That was a parity gap,
        // not just a realism one, so key events are the default here too.
        //
        // rawKeyDown is the NON-text-producing variant: the character comes
        // from insertText alone, exactly once, so this cannot double-insert or
        // drop text. Characters with no real key identity (emoji, CJK) fall
        // back to insertText on its own rather than a fabricated keystroke.
        for (const char of args.text) {
          const d = humanize.keyDescriptorFor(char);
          if (d) {
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: char,
              code: d.code,
              windowsVirtualKeyCode: d.keyCode || 0,
              modifiers: d.shift ? 8 : 0
            });
          }
          await cdp(tabId, "Input.insertText", { text: char });
          if (d) {
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: char,
              code: d.code,
              windowsVirtualKeyCode: d.keyCode || 0,
              modifiers: d.shift ? 8 : 0
            });
          }
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
            // Brave's debugger pipeline needs a settle window between key
            // events; Chrome acks instantly, so the sleep is pure latency there.
            if (await isBrave()) await sleep(30);
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
        if (await humanizeOn(tabId)) {
          // Humanize the APPROACH, deliver the scroll with the same single
          // wheel event the non-humanized path uses.
          //
          // Two attempts at decomposing the scroll both broke the invariant
          // that humanization must not change outcomes, in opposite ways:
          //   - many wheel ticks spread over time: the page scrolled under the
          //     stationary cursor, a nested scrollable slid into place and ate
          //     the rest (page moved 89-109px instead of 400px). Capping the
          //     burst under 200ms did not help.
          //   - Input.synthesizeScrollGesture: fixed the targeting (the nested
          //     box stayed at 0) but its yDistance is literal pixels, while a
          //     wheel event's deltaY goes through the browser's own scaling —
          //     the same request scrolled 600px humanized vs 400px plain.
          //     Matching them would mean hardcoding a platform-specific factor.
          //
          // So the wheel event stays exactly as it is, and what gets humanized
          // is the cursor arriving at the scroll position and the beat before
          // and after. A real mouse wheel is a chunky discrete device anyway;
          // the smooth part of a scroll is the page's own animation, not the
          // input. Correctness first: an agent asking to scroll one screen must
          // land in the same place whether or not humanization is on.
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId);
          if (from && (from.x !== coordinate[0] || from.y !== coordinate[1])) {
            await dispatchPlan(tabId, humanize.planHover(s, from, { x: coordinate[0], y: coordinate[1] }), modifiers);
          }
          await sendMouseEvent(tabId, {
            type: "mouseWheel", x: coordinate[0], y: coordinate[1], deltaX, deltaY, modifiers
          }, { awaitAck: false });
          await sleep(humanize.thinkDelay(s, 0.5));
        } else {
        await sendMouseEvent(tabId, {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        }, { awaitAck: false });
        }
        // Let the compositor repaint before the confirmation screenshot; Chrome
        // repaints fast, Brave needs a longer settle window.
        await sleep((await isBrave()) ? 300 : 100);
        // The scroll already happened; the confirmation screenshot is best-effort.
        // On a heavy page still re-rendering after the scroll, the capture can
        // block, so bound it and degrade to a text-only result rather than
        // stalling the whole scroll (and the agent's retries) to the 60s cap.
        const scrollContent = [
          { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})${hitNote}` },
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
        // Let the page repaint the scroll; Chrome is fast, Brave slower.
        await sleep((await isBrave()) ? 300 : 100);
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
        if (await humanizeOn(tabId)) {
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId) || { x: sx, y: sy };
          await dispatchPlan(tabId, humanize.planDrag(s, from, { x: sx, y: sy }, { x: ex, y: ey }), modifiers);
          return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})${hitNote}` }] };
        }
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        if (await isBrave()) await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        if (await isBrave()) await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          if (await isBrave()) await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})${hitNote}` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // save_to_disk: write the captured image to disk and report the path.
        // Best-effort — never fails the zoom.
        let zoomSaveNote = "";
        if (args.save_to_disk) {
          try {
            const path = await writeScreenshotToDisk(fullBase64);
            zoomSaveNote = `\nSaved to disk: ${path}`;
          } catch (e) {
            zoomSaveNote = `\n(Unable to save to disk: ${e.message})`;
          }
        }
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]${zoomSaveNote}` },
            { type: "image", data: fullBase64, mimeType: "image/jpeg" },
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
    let anyOff = false;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})`;
      if (r.offViewport) {
        anyOff = true;
        text += ` [OFF-VIEWPORT]`;
      }
      text += `\n`;
    }
    if (anyOff) {
      // Handing out coordinates that cannot be clicked is how a silent miss
      // starts: the click dispatches fine and lands on the document root.
      text +=
        `\nNote: entries marked [OFF-VIEWPORT] are scrolled out of view. Clicking their ` +
        `coordinates would land on the page background, not the element. Bring one into ` +
        `view first (computer scroll_to with its ref, or scroll its container), then re-run ` +
        `find to get fresh coordinates.\n`;
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
    const tIn = Date.now();
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    try {
      const tEval = Date.now();
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });
      // preMs = group check + debugger attach; evalMs = the evaluate alone.
      // The split is the whole point: it separates "the renderer serviced the
      // task late" from every other stage of the pipe.
      recordTiming({ t: tIn, tool: "javascript_tool", tab: tabId,
                     preMs: tEval - tIn, evalMs: Date.now() - tEval,
                     bytes: (text || "").length });

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

  // Read the per-call timing ring (live + storage.session backlog from before
  // any worker restart) plus a live snapshot of every group tab's scheduling-
  // relevant state. The snapshot is what turns a timing anomaly into a
  // diagnosis: it says which tabs were active/audible/discarded/frozen and
  // what state their windows were in while the quantum was being paid.
  async debug_timings(args) {
    const limit = Math.min(Number(args?.limit) || 200, 600);
    let stored = [];
    let storedBootAt = null;
    try {
      const got = await chrome.storage.session.get(["mcp_call_timings", "mcp_boot_at"]);
      stored = got.mcp_call_timings || [];
      storedBootAt = got.mcp_boot_at ?? null;
    } catch {}
    const seen = new Set(callTimings.map((e) => `${e.t}|${e.tool}`));
    const merged = stored.filter((e) => !seen.has(`${e.t}|${e.tool}`)).concat(callTimings);
    const tabs = [];
    const winIds = new Set();
    for (const id of tabGroupTabs) {
      try {
        const t = await chrome.tabs.get(id);
        winIds.add(t.windowId);
        tabs.push({ id, windowId: t.windowId, active: t.active, audible: !!t.audible,
                    discarded: !!t.discarded, frozen: !!t.frozen,
                    origin: (t.url || "").split("/").slice(0, 3).join("/") });
      } catch {}
    }
    const windows = [];
    for (const wid of winIds) {
      try {
        const w = await chrome.windows.get(wid);
        windows.push({ id: wid, state: w.state, focused: w.focused });
      } catch {}
    }
    if (args?.clear) {
      callTimings.length = 0;
      timingsDirty = 0;
      try { chrome.storage.session.remove(["mcp_call_timings", "mcp_boot_at"]); } catch {}
    }
    return { content: [{ type: "text", text: JSON.stringify({
      bootAt, storedBootAt, now: Date.now(), count: merged.length,
      tabs, windows, timings: merged.slice(-limit),
    }) }] };
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
      networkByRequestId.set(tabId, new Map());
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

    // A maximized or full-screen window ignores width/height, so it has to be
    // returned to "normal" FIRST, and the state change has to have landed before
    // the resize is issued: chrome.windows.update resolves when the request is
    // accepted, not when the window manager has applied it. Exiting macOS
    // full-screen is an animation, which is why this polls rather than retrying
    // once.
    //
    // This guard is precautionary — it has never been observed firing. It was
    // written to explain four resizes that left the viewport untouched, and that
    // explanation was wrong: the cause was that Chrome does not re-layout a tab
    // which is not the selected tab in its window (see the NOTE further down),
    // and the window measured "normal" every time. So the race described above
    // is plausible rather than demonstrated. It stays because the behaviour it
    // guards against is real — a maximized window genuinely does ignore a resize
    // — and because the whole block is a no-op on a window already normal.
    let win = await chrome.windows.get(tab.windowId);
    if (win.state !== "normal") {
      try {
        await chrome.windows.update(tab.windowId, { state: "normal" });
      } catch {}
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        try {
          win = await chrome.windows.get(tab.windowId);
        } catch {
          break;
        }
        if (win.state === "normal") break;
      }
    }
    if (win.state !== "normal") {
      return {
        content: [
          {
            type: "text",
            text: `Could not resize: the window is ${win.state} and would not return to a normal state, so the window manager will ignore any size. Exit full screen and try again.`
          }
        ]
      };
    }
    // Record the window's own bounds either side of the call. The viewport
    // alone cannot distinguish "the window never moved" from "the window moved
    // but the page did not follow", and those have completely different causes.
    const before = { state: win.state, w: win.width, h: win.height, left: win.left, top: win.top };
    // The viewport before the call, so a window that moves while the page stays
    // put is detectable. That combination is not a window-manager behaviour at
    // all — it means something on our side has pinned the viewport — and it is
    // exactly what emulation used to do here.
    let vpBefore = null;
    try {
      const v0 = await cdp(tabId, "Runtime.evaluate", {
        expression: "JSON.stringify([innerWidth, innerHeight])",
        returnByValue: true
      });
      vpBefore = JSON.parse(v0.result.value);
    } catch {}
    let updateErr = null;
    try {
      await chrome.windows.update(tab.windowId, { width, height, state: "normal" });
    } catch (e) {
      updateErr = String(e && e.message).slice(0, 160);
    }
    // Give the window manager a moment to apply the size before measuring it,
    // for the same reason as above.
    await sleep(150);
    let after = null;
    try {
      const w2 = await chrome.windows.get(tab.windowId);
      after = { state: w2.state, w: w2.width, h: w2.height, left: w2.left, top: w2.top };
    } catch {}

    // A window resize and the page's re-layout are not the same event: the
    // window can report its new bounds while the renderer has not yet reflowed.
    // A fixed sleep here read the pre-resize viewport often enough to make
    // correct resizes report themselves as failures. Wait for the viewport to
    // actually move instead, then let it settle, and cap the wait so a resize
    // that genuinely changes nothing still returns promptly.
    const readViewport = async () => {
      try {
        const v = await cdp(tabId, "Runtime.evaluate", {
          expression: "JSON.stringify([innerWidth, innerHeight])",
          returnByValue: true
        });
        return JSON.parse(v.result.value);
      } catch {
        return null;
      }
    };
    const changedFromBefore = (v) =>
      v && vpBefore && (v[0] !== vpBefore[0] || v[1] !== vpBefore[1]);
    const settleDeadline = 900;
    let waited = 0;
    let last = await readViewport();
    while (waited < settleDeadline) {
      if (changedFromBefore(last)) {
        // Moved. One more read so a mid-reflow value is not what we report.
        await sleep(60);
        waited += 60;
        const settled = await readViewport();
        if (settled) last = settled;
        break;
      }
      await sleep(60);
      waited += 60;
      const next = await readViewport();
      if (next) last = next;
    }
    const settledViewport = last;
    dbg(
      "tool",
      `resize_window bounds ${before.w}x${before.h}(${before.state}) -> ${after ? `${after.w}x${after.h}(${after.state})` : "unknown"} requested ${width}x${height}${updateErr ? ` ERR ${updateErr}` : ""}`,
      { tab: tabId }
    );
    // Report what actually happened rather than echoing the request, and judge
    // the window against the WINDOW bounds — not the viewport, which is legitimately
    // ~100px shorter than the window it lives in because the browser's own chrome
    // takes that space. Comparing the two directly made every successful resize
    // look like a failure.
    const actual = settledViewport;

    const windowTook = after && Math.abs(after.w - width) <= 8 && Math.abs(after.h - height) <= 8;
    const windowMoved = after && (after.w !== before.w || after.h !== before.h);
    const pageFollowed =
      !vpBefore || !actual || actual[0] !== vpBefore[0] || actual[1] !== vpBefore[1];

    let note = "";
    if (!windowTook) {
      // The window itself did not reach the requested size: a window-manager call.
      note =
        ` — NOTE: requested ${width}x${height} but the window went ${before.w}x${before.h} -> ` +
        `${after ? `${after.w}x${after.h}` : "unknown"} (state ${after ? after.state : "?"}), so the ` +
        `window manager ${windowMoved ? "clamped" : "ignored"} the request. Full-screen, tiled, and ` +
        `snapped windows refuse resizes; on macOS, Stage Manager and split view do too, while still ` +
        `reporting state "normal".${updateErr ? ` The update call also errored: ${updateErr}` : ""}`;
    } else if (windowMoved && !pageFollowed) {
      // The window took the size but the page did not re-layout. Not the window
      // manager's doing — something is holding the viewport fixed on our side.
      // Gated on windowMoved so that asking for the size the window already has
      // (a legitimate no-op, where the viewport correctly does not change) is
      // not reported as a fault.
      note =
        ` — NOTE: the window resized to ${after.w}x${after.h} as requested, but the page's viewport ` +
        `stayed ${actual[0]}x${actual[1]} after waiting ${settleDeadline}ms for it to reflow. Chrome ` +
        `does not re-layout a tab that is not the SELECTED tab in its window, and this tab is not ` +
        `selected, so the page keeps the size it had when it was last displayed. Call set_tab_focus ` +
        `on this tab first if the new size actually needs to reach the page. Note that the page ` +
        `cannot tell you this itself: focus emulation makes it report visibilityState "visible" and ` +
        `hasFocus() true either way. Until then, anything measured at this "new size" is really ` +
        `still the old one.`;
    }
    return {
      content: [
        {
          type: "text",
          text: `Resized window to ${width}x${height}${after ? ` (window is ${after.w}x${after.h})` : ""}; ` +
            `viewport is now ${actual ? `${actual[0]}x${actual[1]}` : "unknown"}.${note}`
        }
      ]
    };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, filename = "image.png" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    if (!ref) {
      return { content: [{ type: "text", text: "upload_image requires 'ref' (element reference from read_page/find) identifying the target <input type=file>." }] };
    }

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    await ensureAttached(tabId);
    await ensureDomain(tabId, "DOM");

    // 1) Resolve the ref through the content-script channel (isolated world,
    //    where resolveRef lives), stamping a DOM attribute CDP can find. A
    //    main-world Runtime.evaluate can't see the isolated-world globals.
    const mark = await sendContentMessage(tabId, { type: "markElementForUpload", ref });
    if (!mark || !mark.ok) {
      return { content: [{ type: "text", text: `No element found for ref=${ref}. Re-run read_page/find to get a fresh ref.` }] };
    }
    if (!mark.isFileInput) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Target ref=${ref} is a <${mark.tag}>, not a file input.` }] };
    }

    // 2) Stage the screenshot bytes as a real temp file via the native host.
    //    The screenshot lives in-memory (base64), so setFileInputFiles needs a
    //    path on disk to attach.
    let tempPath;
    try {
      tempPath = await nativeRequest({ type: "write_temp_file", dataUrl: base64, filename });
    } catch (e) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Failed to stage temp file for ${imageId}: ${String(e && e.message)}` }] };
    }
    if (!tempPath) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Failed to stage temp file for ${imageId}.` }] };
    }

    // 3) Find the marked file input via CDP, then attach the staged file.
    try {
      const doc = await cdp(tabId, "DOM.getDocument", {});
      const q = await cdp(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "[data-ocic-upload-target]",
      });
      if (!q || !q.nodeId) {
        return { content: [{ type: "text", text: `Could not resolve the file input node for ref=${ref}.` }] };
      }
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files: [tempPath] });
    } finally {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
    }

    return { content: [{ type: "text", text: `Uploaded ${filename} (${imageId}) to the file input. Temp file: ${tempPath}` }] };
  },

  // Re-run a failed transcription for a saved recording. The offscreen doc
  // re-assembles the durable segments from IndexedDB and re-maps them onto the
  // shared clock; we then persist the patched trace.json on disk.
  async retranscribe_recording(args) {
    const { recording_id } = args;
    if (!recording_id)
      return { content: [{ type: "text", text: "recording_id is required." }] };

    const apiKey = await getApiKey();
    // The offscreen document owns the durable audio buffer; make sure it's alive
    // before asking it to retranscribe, or the message is dropped (res undefined).
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "retranscribe",
      recording_id,
      apiKey,
    });
    if (!res || !res.ok) {
      return { content: [{ type: "text", text: res?.error || "retranscription failed." }] };
    }

    // Persist the patched trace via the SAME disk-write path used at stop
    // (saveBundleToDisk -> save_recording -> native host), rather than a
    // bespoke retry-only write path. Reuse keeps the retry a thin re-run.
    const path = await saveBundleToDisk({
      recording_id,
      schema: res.trace?.schema || "v0",
      trace: res.trace,
    }).catch(() => null);
    const synopsis =
      `Recording ${recording_id} retranscribed: ${res.transcript_status}. ` +
      `${(res.cognitive || []).length} utterances. ` +
      (path ? `trace.json updated on disk (${path}).` : "WARNING: trace.json could not be written to disk.");
    return { content: [{ type: "text", text: synopsis }] };
  },

  async file_upload(args) {
    const { tabId, paths, ref } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p)) {
      return { content: [{ type: "text", text: "file_upload requires 'paths' — a non-empty array of absolute file paths that already exist on this machine." }] };
    }
    if (!ref || typeof ref !== "string") {
      return { content: [{ type: "text", text: "file_upload requires 'ref' — the element reference of an <input type=file> from read_page or find." }] };
    }

    await ensureAttached(tabId);
    await ensureDomain(tabId, "DOM");

    // Resolve the ref through the content-script channel (isolated world, where
    // resolveRef/__unblockedChrome live), which stamps a DOM attribute on the
    // element. CDP Runtime.evaluate runs in the page's MAIN world and can't see
    // the isolated-world globals, so we locate the element via that shared-DOM
    // attribute instead. Works for hidden file inputs too.
    const mark = await sendContentMessage(tabId, { type: "markElementForUpload", ref });
    if (!mark || !mark.ok) {
      return { content: [{ type: "text", text: `No element found for ref=${ref}. Re-run read_page/find to get a fresh ref.` }] };
    }
    if (!mark.isFileInput) {
      return { content: [{ type: "text", text: `Target ref=${ref} is a <${mark.tag}>, not a file input. Point at the <input type=file> element (read_page/find can locate hidden ones).` }] };
    }

    // The files are already on disk on the same machine as the browser, so pass
    // the real paths straight to CDP — no temp staging needed. Find the marked
    // node via CDP, then DOM.setFileInputFiles.
    try {
      const doc = await cdp(tabId, "DOM.getDocument", {});
      const q = await cdp(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "[data-ocic-upload-target]",
      });
      if (!q || !q.nodeId) {
        return { content: [{ type: "text", text: `Could not resolve the file input node for ref=${ref}.` }] };
      }
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files: paths });
    } finally {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
    }

    const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
    return { content: [{ type: "text", text: `Attached ${label} to the file input (ref=${ref}).` }] };
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

  async debug(args) {
    const limit = Math.min(Math.max(Number(args?.limit) || 100, 1), DEBUG_MAX);
    const kind = args?.kind;
    const filter = args?.filter;
    const tabId = args?.tabId;
    const sinceMs = Number(args?.since_ms) || 0;
    const now = Date.now();

    let re = null;
    let reErr = "";
    if (filter) {
      try {
        re = new RegExp(filter, "i");
      } catch (e) {
        // Fall back to substring rather than failing the call: a debug tool
        // that errors on its own input is useless exactly when it is needed.
        reErr = ` (filter "${filter}" is not valid regex — matched as plain text)`;
      }
    }

    let rows = debugLog;
    const total = rows.length;
    if (sinceMs) rows = rows.filter((e) => now - e.t <= sinceMs);
    if (kind) rows = rows.filter((e) => e.kind === kind);
    if (tabId !== undefined && tabId !== null) rows = rows.filter((e) => e.tab === tabId);
    if (filter) {
      rows = rows.filter((e) => {
        const hay = `${e.kind} ${e.detail} ${e.err || ""}`;
        return re ? re.test(hay) : hay.toLowerCase().includes(String(filter).toLowerCase());
      });
    }
    const matched = rows.length;
    rows = rows.slice(-limit);

    // Everything the reader needs to know about what is NOT here. Silence in a
    // debug stream must never be mistaken for silence in the system.
    const ageS = Math.round((now - debugBootedAt) / 1000);
    const head = [
      `OCIC debug — ${rows.length} shown of ${matched} matching, ${total} in buffer${reErr}`,
      `Buffer keeps the most recent ${DEBUG_MAX} events${debugDropped ? `; ${debugDropped} older event(s) have been DROPPED` : ""}.`,
      `Recording started ${ageS}s ago (service worker start). NOTHING before that is in here — MV3 evicts the worker, which clears the buffer, so an empty or short log may mean the worker restarted rather than that nothing happened.`
    ];
    if (!rows.length) {
      head.push("", "No events matched. If you expected some, check the window above before concluding the action did not occur.");
      return { content: [{ type: "text", text: head.join("\n") }] };
    }

    const t0 = rows[0].t;
    const lines = rows.map((e) => {
      const rel = `+${String(e.t - t0).padStart(6)}ms`;
      const ms = e.ms !== undefined ? ` (${e.ms}ms)` : "";
      const tab = e.tab !== undefined ? ` tab=${e.tab}` : "";
      const err = e.err ? `  ERR: ${e.err}` : "";
      return `${rel}  ${e.kind.padEnd(5)} ${e.detail}${ms}${tab}${err}`;
    });

    // Timing roll-up: the question after "what happened" is nearly always
    // "what was slow", and it is cheap to answer here.
    const byKind = {};
    for (const e of rows) {
      if (typeof e.ms !== "number") continue;
      const k = e.detail.split(" ")[0];
      (byKind[k] = byKind[k] || []).push(e.ms);
    }
    const slow = Object.entries(byKind)
      .map(([k, v]) => ({ k, n: v.length, total: v.reduce((a, b) => a + b, 0), max: Math.max(...v) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
      .map((r) => `  ${r.k} x${r.n}: ${r.total}ms total, ${r.max}ms slowest`);

    const span = rows[rows.length - 1].t - t0;
    const out = [
      ...head,
      `Window shown spans ${span}ms.`,
      "",
      ...lines
    ];
    if (slow.length) out.push("", "Slowest by total time:", ...slow);
    if (args?.clear) {
      debugLog.length = 0;
      debugDropped = 0;
      out.push("", "Buffer cleared.");
    }
    return { content: [{ type: "text", text: out.join("\n") }] };
  },

  async get_config(args) {
    await configHydrated;
    const tabId = args?.tabId;
    const payload = {
      default: configState.default,
      perTab: configState.byTab,
      recognizedKeys: CONFIG_SCHEMA,
      // The persona currently in use, so a comparison can record it and show
      // the hand really was held constant rather than assuming it.
      activeHand: humanSession
        ? {
            seed: humanSessionSeed,
            speed: +humanSession.persona.speed.toFixed(3),
            steadiness: +humanSession.persona.steadiness.toFixed(3),
            overshoot: +humanSession.persona.overshoot.toFixed(3),
            typeTempo: +humanSession.persona.typeTempo.toFixed(3)
          }
        : null
    };
    if (tabId !== undefined && tabId !== null) {
      payload.effectiveForTab = { tabId, config: effectiveConfig(tabId) };
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },

  async set_config(args) {
    const { key, value, tabId } = args || {};
    if (!key || typeof key !== "string") {
      return { content: [{ type: "text", text: "set_config requires 'key' (a string)." }] };
    }
    const effective = await writeConfig(key, value === undefined ? null : value, tabId);
    const scope =
      tabId === undefined || tabId === null ? "default (all tabs)" : `tab ${tabId}`;
    const known = Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, key)
      ? ""
      : ` Note: "${key}" is not a recognized setting, so nothing reads it — it was stored anyway.`;

    // Build the humanization hand NOW rather than lazily on the first action.
    // Otherwise pinning a seed stores a number and changes nothing observable
    // until something is clicked, so there is no way to check what you pinned
    // before relying on it — and get_config would report activeHand: null.
    // Priming here makes the hand inspectable the moment it is configured, and
    // lets this call report exactly what it built.
    let handNote = "";
    if (key === "humanize_seed" || key === "humanize" || key === "humanize_speed") {
      const s = human(effective.humanize_speed, effective.humanize_seed);
      handNote =
        `\nActive hand (seed ${humanSessionSeed === null ? "random" : humanSessionSeed}): ` +
        JSON.stringify({
          speed: +s.persona.speed.toFixed(3),
          steadiness: +s.persona.steadiness.toFixed(3),
          overshoot: +s.persona.overshoot.toFixed(3),
          typeTempo: +s.persona.typeTempo.toFixed(3)
        });
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Set ${key}=${JSON.stringify(value === undefined ? null : value)} for ${scope}.${known}\n` +
            `Effective config${tabId != null ? ` for tab ${tabId}` : ""}: ${JSON.stringify(effective)}` +
            handNote
        }
      ]
    };
  },

  // Deliberate, opt-in attention. Nothing else in this extension selects a tab
  // or raises a window: automation drives background tabs, so the operator is
  // never yanked around as a side effect. This tool is the ONE way to surface
  // a tab, and it is the agent's judgement call when that is worth doing.
  async set_tab_focus(args) {
    const { tabId, focus_window = false } = args;
    if (!(await isInGroup(tabId))) {
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    }
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      return { content: [{ type: "text", text: `Could not select tab ${tabId}: ${e.message}` }] };
    }
    let note = "";
    if (focus_window) {
      try {
        const tab = await chrome.tabs.get(tabId);
        // focused:true raises the browser above every other application —
        // this is the part that interrupts the operator.
        await chrome.windows.update(tab.windowId, { focused: true });
        note = " and brought its window to the front";
      } catch (e) {
        note = ` (could not raise its window: ${e.message})`;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Tab ${tabId} is now the active tab in its window${note}.`
        }
      ]
    };
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

  const t0 = Date.now();
  const label = tool === "computer" ? `computer.${args && args.action}` : tool;
  dbg("tool", `${label} <- ${argSummary(args)}`, { tab: args && args.tabId });

  // Attribute this action to the Claude Code session that asked for it. The
  // host namespaces every request as `h{clientId}_{id}` and we echo that id
  // back untouched, so the client is already identifiable here with no
  // protocol change on either side. Two sessions driving two tabs therefore
  // produce two independent audits rather than one interleaved mess.
  //
  // Awaited deliberately: the recorder must be attached BEFORE the action runs,
  // or the first action on a tab is the one action the replay is missing.
  if (audit.isEnabled()) {
    const clientId = (String(id).match(/^h(\d+)_/) || [])[1] ?? null;
    await audit
      .noteAction({
        clientId,
        tool,
        action: args && args.action,
        tabId: args && args.tabId,
        detail: argSummary(args),
        // Passed rather than imported so the audit module stays free of any
        // native-host coupling — the seam that keeps it foldable later.
        postToHost: (m) => {
          try {
            if (nativePort) nativePort.postMessage(m);
          } catch {}
        }
      })
      .catch(() => {});
  }
  try {
    const t0 = Date.now();
    const result = await handler(args);
    // Record the SHAPE of the reply, not the reply. Echoing the response text
    // here would make the stream a copy of what the caller already received,
    // which is worth nothing to them; what they cannot see is how long it took
    // and how much came back.
    dbg("tool", `${label} -> ${resultShape(result)}`, { tab: args && args.tabId, ms: Date.now() - t0 });
    // Upstream's separate per-call timing buffer, kept so its debug_timings tool
    // still reports. javascript_tool records its own richer entry (preMs/evalMs);
    // debug_timings reading the buffer should not pollute it.
    if (tool !== "javascript_tool" && tool !== "debug_timings") {
      recordTiming({ t: t0, tool, tab: args?.tabId, ms: Date.now() - t0 });
    }
    sendResponse(id, result);
  } catch (err) {
    dbg("tool", `${label} -> THREW`, { tab: args && args.tabId, ms: Date.now() - t0, err: String(err.message).slice(0, 160) });
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
  if (msg && msg.type === "audit_events") {
    audit.ingest(msg).catch(() => {});
    return; // fire-and-forget; the tab does not wait on us
  }
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
chrome.tabs.onRemoved.addListener((tabId) => {
  recordSwEvent("tab_closed", tabId, { url: null });
  audit.onTabRemoved(tabId).catch(() => {});
});
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
