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
  selectSegment(0);
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
    b.onclick = () => selectSegment(i);
    host.appendChild(b);
  });
}

function selectSegment(i) {
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
        showController: true
      }
    });
    // Open on the moment the agent first acted here, not the page's birth.
    const t0 = stream.events[0].timestamp;
    seekTo(seg.tStart - t0 - 1000);
  } catch (e) {
    host.innerHTML = `<p class="empty">Player failed: ${e.message}</p>`;
  }
}

function seekTo(offsetMs) {
  if (!cur.player) return;
  try {
    cur.player.goto(Math.max(0, offsetMs));
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
    b.onclick = () => seekTo(a.t - t0 - 1500);
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
}
