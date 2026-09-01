// The tab half of audit recording. Injected on demand, alongside the rrweb
// bundle, into the extension's ISOLATED world.
//
// Isolated world is the whole trick. The page cannot see this script, its
// globals, or that it was injected — no web API exposes content scripts — while
// MutationObserver still works because the DOM is shared. So auditing adds no
// detectable surface to the page, unlike a main-world injection, which would
// have to patch natives and could be spotted with a `toString` check.
//
// The cost of that choice: no native patching, so canvas and closed shadow
// roots are not captured. Canvas recording stays off regardless — it is the one
// rrweb feature that touches natives (`toDataURL`/`getImageData`) which
// anti-fingerprinting sweeps already watch.

(() => {
  if (window.__ocicAuditReady) return;
  window.__ocicAuditReady = true;

  const FLUSH_MS = 1000;
  const FLUSH_EVENTS = 40;

  let stopFn = null;
  let streamId = null;
  let seq = 0;
  let buffer = [];
  let timer = null;

  function flush() {
    if (!buffer.length || !streamId) return;
    const events = buffer;
    buffer = [];
    const payload = { type: "audit_events", streamId, seq: seq++, events };
    try {
      // Fire and forget: the worker may be asleep, and waking it is the point.
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {
      // Extension context invalidated (reload/update). Stop cleanly rather
      // than throwing on every subsequent event for the life of the page.
      teardown();
    }
  }

  function teardown() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stopFn) {
      try {
        stopFn();
      } catch {}
    }
    stopFn = null;
    buffer = [];
  }

  window.__ocicAuditStart = (sid, opts = {}) => {
    if (stopFn) return { ok: true, streamId, already: true };
    if (typeof rrweb === "undefined" || !rrweb.record) return { ok: false, error: "rrweb absent" };
    streamId = sid;
    seq = 0;
    try {
      stopFn = rrweb.record({
        emit(e) {
          buffer.push(e);
          if (buffer.length >= FLUSH_EVENTS) flush();
        },
        // Off deliberately — see the note at the top of this file.
        recordCanvas: false,
        collectFonts: false,
        // Same-origin CSS is inlined so a replay does not depend on the page's
        // stylesheets still being reachable later. Cross-origin CSS is
        // CORS-blocked and cannot be inlined at all, which is a real fidelity
        // limit of replay, not something this flag can fix.
        inlineStylesheet: true,
        sampling: {
          mousemove: 50,
          mouseInteraction: true,
          scroll: 100,
          media: 800,
          input: "last"
        },
        maskAllInputs: !!opts.maskInputs
      });
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
    timer = setInterval(flush, FLUSH_MS);
    // A document being torn down still has events worth keeping.
    window.addEventListener("pagehide", flush, { capture: true });
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    return { ok: true, streamId };
  };

  window.__ocicAuditStop = () => {
    flush();
    teardown();
    const id = streamId;
    streamId = null;
    return { ok: true, streamId: id };
  };

  // The worker asks "are you already recording?" rather than tracking it in
  // memory, because the worker can be evicted while this page keeps running.
  // The tab is the source of truth about whether the tab is recording.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "audit_ping") return;
    sendResponse({ streamId: stopFn ? streamId : null });
    return true;
  });
})();
