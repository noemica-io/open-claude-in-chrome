// The Audits pane. Reads the same IndexedDB the service worker writes — the
// options page and the worker share an extension origin, so no messaging is
// needed and an audit stays readable even while the worker is evicted.
//
// The read helpers come from ../audit/index.js rather than being reimplemented
// here, so segment derivation has exactly one definition and the unit tests
// cover the version the UI actually runs.

import { listSessions, readSession, deleteSession } from "../audit/index.js";

const $ = (id) => document.getElementById(id);
let cur = { payload: null, segIndex: 0, player: null };

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtWhen(t) {
  return new Date(t).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

export async function refreshAudits() {
  const host = $("auditList");
  if (!host) return;
  let sessions = [];
  try {
    sessions = await listSessions();
  } catch (e) {
    host.innerHTML = `<div class="empty">Could not read audits: ${e.message}</div>`;
    return;
  }
  if (!sessions.length) {
    host.innerHTML =
      '<div class="empty">No audits yet. Turn recording on with ' +
      '<code>set_config audit_mode=audit</code>, then drive the browser.</div>';
    $("auditPanel").hidden = true;
    return;
  }
  host.innerHTML = "";
  sessions.forEach((s, i) => {
    let label = s.title || "";
    const site = (() => {
      try { return new URL(s.url).host; } catch { return ""; }
    })();
    if (!label || label.length < 4 || label === "(untitled)") label = site || s.sessionId;
    else if (site) label = `${label} — ${site}`;

    const b = document.createElement("button");
    b.className = "sitem";
    b.setAttribute("aria-current", String(i === 0));
    b.innerHTML =
      `<span class="id">client ${s.clientId}</span>` +
      `<span class="ttl"></span>` +
      `<span class="meta">${s.segmentCount} segment${s.segmentCount === 1 ? "" : "s"} · ` +
      `${s.actionCount} actions · ${s.tabs} tab${s.tabs === 1 ? "" : "s"} · ${fmtWhen(s.startedAt)}</span>`;
    b.querySelector(".ttl").textContent = label;
    b.onclick = () => selectSession(s.sessionId, i);
    host.appendChild(b);
  });
  await selectSession(sessions[0].sessionId, 0);
}

async function selectSession(sessionId, index) {
  [...$("auditList").children].forEach((c, j) =>
    c.setAttribute && c.setAttribute("aria-current", String(index === j))
  );
  cur.payload = await readSession(sessionId);
  $("auditPanel").hidden = !cur.payload;
  if (!cur.payload) return;
  renderSegments();
  buildTimeline();
}

function renderSegments() {
  const host = $("segs");
  host.innerHTML = "";
  const { segments, streams } = cur.payload;
  if (!segments.length) {
    host.innerHTML = '<span class="empty">No recorded segments.</span>';
    return;
  }
  segments.forEach((seg, i) => {
    const st = streams[seg.streamId];
    const b = document.createElement("button");
    b.className = "seg";
    b.innerHTML =
      `<span class="n">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="tab">tab ${seg.tabId}</span>` +
      `<span class="cnt">${seg.actions.length} action${seg.actions.length === 1 ? "" : "s"} · ` +
      `${fmtClock(seg.tEnd - seg.tStart)}</span>`;
    b.title = (st && st.url) || seg.streamId;
    b.onclick = () => {
      const sp = T.spans.find((x) => x.segIndex === i);
      if (sp) { setPlaying(false); renderAt(sp.g0); }
      else selectSegment(i);
    };
    host.appendChild(b);
  });
}

// ---------------------------------------------------------------------------
// One timeline across the whole session.
//
// The streams cannot be concatenated — rrweb node ids are per-snapshot — so the
// continuity is built here instead: each segment contributes its own window to
// a single global clock, and playback swaps the underlying player at the
// boundaries. The reviewer presses play once and the tab switches happen on
// their own, which is the entire point of an audit; having to click between
// tabs and reassemble the order by hand is not a replay.
//
// Dead time between segments is compressed out. A wall-clock gap is time the
// agent spent in ANOTHER tab, already shown by that tab's own segment, so
// replaying it as a frozen screen would be showing nothing twice.
const LEAD_IN_MS = 1000;
const LEAD_OUT_MS = 2500;

let T = { spans: [], total: 0, t: 0, playing: false, timer: null, mounted: -1 };

function buildTimeline() {
  const { segments, streams } = cur.payload;
  T.spans = [];
  let acc = 0;
  segments.forEach((seg, i) => {
    const st = streams[seg.streamId];
    if (!st || !st.events || st.events.length < 2) return;
    const first = st.events[0].timestamp;
    const last = st.events[st.events.length - 1].timestamp;
    // Clamp to what the stream actually holds, so the player is never asked to
    // seek past its own end.
    const winStart = Math.max(first, seg.tStart - LEAD_IN_MS);
    const winEnd = Math.min(last, Math.max(seg.tEnd + LEAD_OUT_MS, winStart + 1200));
    const dur = Math.max(600, winEnd - winStart);
    T.spans.push({ segIndex: i, streamId: seg.streamId, tabId: seg.tabId, first, winStart, dur, g0: acc });
    acc += dur;
  });
  T.total = acc;
  T.t = 0;
  T.mounted = -1;
  $("transport").hidden = T.spans.length === 0;
  $("tTotal").textContent = fmtClock(T.total);
  $("scrub").max = String(Math.max(1, Math.round(T.total)));
  if (T.spans.length) renderAt(0);
  else selectSegment(0);
}

function spanAt(t) {
  for (let i = T.spans.length - 1; i >= 0; i--) if (t >= T.spans[i].g0) return i;
  return 0;
}

function renderAt(t, { play = false } = {}) {
  if (!T.spans.length) return;
  T.t = Math.max(0, Math.min(t, T.total));
  const i = spanAt(T.t);
  const sp = T.spans[i];
  if (T.mounted !== i) {
    T.mounted = i;
    selectSegment(sp.segIndex, { fromTimeline: true });
  }
  seekTo(sp.winStart - sp.first + (T.t - sp.g0), play);
  $("scrub").value = String(Math.round(T.t));
  $("tNow").textContent = fmtClock(T.t);
  $("nowTab").textContent = `tab ${sp.tabId}`;
}

function setPlaying(on) {
  T.playing = on;
  $("playBtn").innerHTML = on ? "&#10074;&#10074;" : "&#9654;";
  $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
  if (T.timer) clearInterval(T.timer);
  T.timer = null;
  if (!on) {
    if (cur.player) { try { cur.player.pause(); } catch {} }
    return;
  }
  if (T.t >= T.total - 50) T.t = 0;
  renderAt(T.t, { play: true });
  // Elapsed comes from the wall clock, not from accumulating a step per tick:
  // Chrome throttles timers in a background tab to about 1Hz, which made a
  // `t += 100` clock run roughly eight times slow and never reach the second
  // tab. Reading the clock makes throttling cost smoothness, never rate.
  const wall0 = Date.now();
  const base = T.t;
  T.timer = setInterval(() => {
    const next = base + (Date.now() - wall0);
    if (next >= T.total) { renderAt(T.total); setPlaying(false); return; }
    const before = spanAt(T.t);
    const after = spanAt(next);
    // Re-seek only at a boundary; in between the player runs on its own clock,
    // so playback stays smooth instead of stuttering every tick.
    if (before !== after) renderAt(next, { play: true });
    else {
      T.t = next;
      $("scrub").value = String(Math.round(T.t));
      $("tNow").textContent = fmtClock(T.t);
    }
  }, 100);
}

function selectSegment(i, opts = {}) {
  const { segments, streams } = cur.payload;
  cur.segIndex = i;
  [...$("segs").children].forEach((c, j) =>
    c.setAttribute && c.setAttribute("aria-current", String(i === j))
  );
  const seg = segments[i];
  if (!seg) return;
  const st = streams[seg.streamId];

  $("segTitle").textContent = (st && st.title) || `Segment ${i + 1}`;
  $("segUrl").textContent = (st && st.url) || "";
  const badge = $("segBadge");
  if (st && st.truncated) {
    badge.hidden = false;
    badge.className = "badge trunc";
    badge.textContent = "truncated — size cap";
  } else if (st && !st.endedAt) {
    badge.hidden = false;
    badge.className = "badge live";
    badge.textContent = "still open";
  } else {
    badge.hidden = true;
  }

  renderMarks(st, seg);
  mountPlayer(st, seg);
  if (!opts.fromTimeline) {
    const sp = T.spans.find((x) => x.segIndex === i);
    if (sp) { T.mounted = T.spans.indexOf(sp); renderAt(sp.g0); }
  }
}

function mountPlayer(stream, seg) {
  const host = $("player");
  host.innerHTML = "";
  cur.player = null;
  if (!stream || !stream.events || stream.events.length < 2) {
    host.innerHTML = '<p class="empty">This segment has too few events to replay.</p>';
    return;
  }
  // The UMD build exposes a module namespace, not the constructor itself.
  const Player = (window.rrwebPlayer && window.rrwebPlayer.default) || window.rrwebPlayer;
  if (typeof Player !== "function") {
    host.innerHTML = '<p class="empty">rrweb-player did not load.</p>';
    return;
  }
  try {
    cur.player = new Player({
      target: host,
      props: {
        events: stream.events,
        width: Math.min(host.clientWidth || 900, 1000),
        height: 420,
        autoPlay: false,
        showController: false
      }
    });
    // Open on the moment the agent first acted here, not the page's birth.
    const t0 = stream.events[0].timestamp;
    seekTo(seg.tStart - t0 - 1000);
  } catch (e) {
    host.innerHTML = `<p class="empty">Player failed: ${e.message}</p>`;
  }
}

function seekTo(offsetMs, play = false) {
  if (!cur.player) return;
  try {
    cur.player.goto(Math.max(0, offsetMs), play);
  } catch {}
}

function renderMarks(stream, seg) {
  const wrap = $("marks");
  const row = $("mrow");
  row.innerHTML = "";
  if (!stream || !stream.events.length) {
    wrap.hidden = true;
    return;
  }
  const t0 = stream.events[0].timestamp;
  wrap.hidden = false;
  seg.actions.forEach((a) => {
    const b = document.createElement("button");
    b.className = "mark";
    b.innerHTML = `<span class="t">${fmtClock(a.t - t0)}</span><span class="tool"></span>`;
    b.querySelector(".tool").textContent = a.action ? `${a.tool}.${a.action}` : a.tool;
    b.title = a.detail || "";
    // Land a beat BEFORE the action, so it is seen in context rather than as a
    // jump-cut to its aftermath.
    b.onclick = () => {
      setPlaying(false);
      const sp = T.spans.find((x) => x.segIndex === cur.segIndex);
      if (sp) renderAt(sp.g0 + (a.t - 1500 - sp.winStart));
      else seekTo(a.t - t0 - 1500);
    };
    row.appendChild(b);
  });
}

export function wireAuditTabs() {
  const tabA = $("tab-audits");
  const tabR = $("tab-recordings");
  if (!tabA || !tabR) return;
  const show = (audits) => {
    tabA.setAttribute("aria-selected", String(audits));
    tabR.setAttribute("aria-selected", String(!audits));
    $("pane-audits").hidden = !audits;
    $("pane-recordings").hidden = audits;
    if (audits) refreshAudits();
  };
  tabA.onclick = () => show(true);
  tabR.onclick = () => show(false);

  const del = $("auditDelete");
  if (del) {
    del.onclick = async () => {
      if (!cur.payload) return;
      const id = cur.payload.session.sessionId;
      del.disabled = true;
      try {
        await deleteSession(id);
        await refreshAudits();
      } finally {
        del.disabled = false;
      }
    };
  }
  const rf = $("auditRefresh");
  if (rf) rf.onclick = () => refreshAudits();

  const play = $("playBtn");
  if (play) play.onclick = () => setPlaying(!T.playing);
  const scrub = $("scrub");
  if (scrub) scrub.oninput = (e) => { setPlaying(false); renderAt(Number(e.target.value)); };
}
