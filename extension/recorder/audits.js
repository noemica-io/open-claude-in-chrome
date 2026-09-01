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

function siteOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

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
    const b = document.createElement("button");
    b.className = "sitem";
    b.setAttribute("aria-current", String(i === 0));
    b.innerHTML =
      `<span class="id">Claude session ${s.clientId}</span>` +
      `<span class="ttl"></span>` +
      `<span class="meta">${s.actionCount} actions · ${s.tabs} tab${s.tabs === 1 ? "" : "s"} · ` +
      `${fmtWhen(s.startedAt)}</span>`;
    // The journey IS the identity. "client 1" means nothing alone, and every
    // capture of one page shares a title, so the list read "untouched" four
    // times over. The sequence of sites is what a reviewer recognises.
    b.querySelector(".ttl").textContent = s.journey && s.journey.length
      ? s.journey.join(" → ")
      : "(nothing recorded)";
    b.title = s.sessionId;
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
  buildTimeline();
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
const LEAD_OUT_MS = 3000;

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
    const winStart = Math.max(first, seg.tStart - LEAD_IN_MS);
    // Do NOT clamp the window to the stream's last event. rrweb stops emitting
    // the moment a page goes quiet, so the final event can land milliseconds
    // after the last action — clamping there cut the action's aftermath off,
    // and a scroll snapped away to the next tab just as it began. The window
    // runs past the events; the SEEK is clamped instead, so the replay holds
    // its final frame for the remainder.
    const winEnd = Math.max(seg.tEnd + LEAD_OUT_MS, winStart + 1500);
    const dur = Math.max(900, winEnd - winStart);
    T.spans.push({
      segIndex: i, streamId: seg.streamId, tabId: seg.tabId,
      first, last, streamDur: Math.max(0, last - first), winStart, dur, g0: acc,
      site: siteOf(st.url) || `tab ${seg.tabId}`,
      actions: seg.actions
    });
    acc += dur;
  });
  T.total = acc;
  T.t = 0;
  T.mounted = -1;
  $("transport").hidden = T.spans.length === 0;
  $("tTotal").textContent = fmtClock(T.total);
  $("scrub").max = String(Math.max(1, Math.round(T.total)));
  renderTimeline();
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
  // Clamp into the stream: past its end the player holds the final frame,
  // which is what makes the lead-out above possible.
  seekTo(Math.min(sp.winStart - sp.first + (T.t - sp.g0), sp.streamDur), play);
  $("scrub").value = String(Math.round(T.t));
  $("tNow").textContent = fmtClock(T.t);
  $("nowTab").textContent = sp.site;
  highlight(i);
}

function globalTimeOf(sp, a) {
  return Math.max(sp.g0, Math.min(sp.g0 + sp.dur, sp.g0 + (a.t - sp.winStart)));
}

function renderTimeline() {
  const host = $("timeline");
  host.innerHTML = "";
  if (!T.spans.length) {
    host.innerHTML = '<span class="empty">Nothing was recorded in this session.</span>';
    return;
  }
  T.spans.forEach((sp, i) => {
    const g = document.createElement("div");
    g.className = "tlgroup";
    g.dataset.span = String(i);
    const head = document.createElement("div");
    head.className = "tlhead";
    head.innerHTML = `<span class="site"></span><span class="tabid">tab ${sp.tabId}</span>`;
    head.querySelector(".site").textContent = sp.site;
    const acts = document.createElement("div");
    acts.className = "tlacts";
    sp.actions.forEach((a) => {
      const gt = globalTimeOf(sp, a);
      const b = document.createElement("button");
      b.className = "act";
      b.dataset.g = String(gt);
      b.innerHTML = `<span class="t">${fmtClock(gt)}</span><span class="tool"></span>`;
      b.querySelector(".tool").textContent = a.action ? `${a.tool}.${a.action}` : a.tool;
      b.title = a.detail || "";
      // Land a beat before the action, so it is seen in context rather than as
      // a jump-cut to its aftermath.
      b.onclick = () => { setPlaying(false); renderAt(Math.max(sp.g0, gt - 1200)); };
      acts.appendChild(b);
    });
    g.appendChild(head);
    g.appendChild(acts);
    host.appendChild(g);
  });
}

function highlight(spanIndex) {
  const groups = [...$("timeline").querySelectorAll(".tlgroup")];
  groups.forEach((g, j) => g.setAttribute("data-active", String(j === spanIndex)));
  const all = [...$("timeline").querySelectorAll(".act")];
  let active = -1;
  all.forEach((b, j) => { if (Number(b.dataset.g) <= T.t + 250) active = j; });
  all.forEach((b, j) => b.setAttribute("aria-current", String(j === active)));
  if (active >= 0 && all[active]) {
    all[active].scrollIntoView({ block: "nearest", inline: "nearest" });
  }
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

  mountPlayer(st, seg);
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
