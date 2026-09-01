// Options page: OpenAI key management + sessions viewer with progressive
// disclosure (§9). All captured data is visible to the operator — metadata
// first, then the two tracks, then per-action anchors and effects — nothing
// hidden. Reads the same IndexedDB the offscreen buffer writes.

import { validateOpenAiKey } from "./transcribe.js";
import { wireAuditTabs } from "./audits.js";

const keyInput = document.getElementById("key");
const keyStatus = document.getElementById("keyStatus");

// ---- API key ----
chrome.storage.local.get("openai_api_key").then(({ openai_api_key }) => {
  if (openai_api_key) keyInput.value = openai_api_key;
});

document.getElementById("reveal").addEventListener("click", () => {
  keyInput.type = keyInput.type === "password" ? "text" : "password";
});

// ---- microphone grant ----
// The Options page is a visible surface, so getUserMedia here shows the Chrome
// permission prompt. Once granted, the permission persists for the extension
// origin and the offscreen recorder can capture the mic without prompting.
const micStatus = document.getElementById("micStatus");
async function refreshMicStatus() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") { micStatus.textContent = "Enabled."; micStatus.className = "status ok"; }
    else if (p.state === "denied") { micStatus.textContent = "Blocked — allow mic for this extension in browser settings."; micStatus.className = "status err"; }
    else { micStatus.textContent = "Not enabled yet."; micStatus.className = "status"; }
  } catch { micStatus.textContent = ""; }
}
refreshMicStatus();
document.getElementById("mic").addEventListener("click", async () => {
  micStatus.textContent = "Requesting…";
  micStatus.className = "status";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // release immediately
    micStatus.textContent = "Enabled. You can record now.";
    micStatus.className = "status ok";
  } catch (e) {
    micStatus.textContent =
      e && e.name === "NotAllowedError"
        ? "Denied. Allow the microphone for this extension and retry."
        : `Error: ${e && e.message}`;
    micStatus.className = "status err";
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const key = keyInput.value.trim();
  keyStatus.textContent = "Validating…";
  keyStatus.className = "status";
  const v = await validateOpenAiKey(key);
  if (v.ok) {
    await chrome.storage.local.set({ openai_api_key: key });
    keyStatus.textContent = "Saved and valid.";
    keyStatus.className = "status ok";
  } else {
    keyStatus.textContent = v.error;
    keyStatus.className = "status err";
  }
});

// ---- sessions viewer ----
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ocic-recorder", 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("sessions"))
        d.createObjectStore("sessions", { keyPath: "recording_id" });
      if (!d.objectStoreNames.contains("events"))
        d.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("audio"))
        d.createObjectStore("audio", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("cursor"))
        d.createObjectStore("cursor", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("images"))
        d.createObjectStore("images", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fmtTime(ms) {
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Truncate with an explicit ellipsis so a cutoff is always visible; the full
// value lives in the detail popup.
function trunc(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
// recording_id -> sorted { beh, cog }, so a clicked timeline item can be
// resolved to its full record for the popup.
const traceCache = new Map();

async function renderSessions() {
  const container = document.getElementById("sessions");
  let db;
  try { db = await openDb(); } catch { return; }
  const rows = await new Promise((resolve) => {
    const tx = db.transaction("sessions", "readonly");
    const req = tx.objectStore("sessions").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  if (!rows.length) return;
  rows.sort((a, b) => b.started_at - a.started_at);

  container.innerHTML = "";
  for (const s of rows) {
    const dur = Math.round(((s.ended_at || 0) - s.started_at) / 1000);
    const host = (() => { try { return new URL(s.url0).host; } catch { return "—"; } })();
    const audioUrl = s.audio && s.audio.size ? URL.createObjectURL(s.audio) : null;
    // An empty narration track is ambiguous on its own — silent operator, or
    // lost teaching? Say which, loudly, and never let it read as success.
    const tstat = s.transcriptStatus || (s.trace && s.trace.transcript_status) || "";
    const status =
      tstat && tstat !== "ok"
        ? `<div class="tstatus"><strong>Transcript ${esc(tstat.split(":")[0])}</strong> — ${esc(
            tstat.replace(/^[^:]*:\s*/, "")
          )}. The narration track is empty or incomplete; the audio is on disk in <code>audio/</code>.</div>`
        : "";
    const player = audioUrl
      ? `<audio controls src="${audioUrl}" style="width:100%;margin:6px 0"></audio>`
      : `<div class="empty">No audio captured (mic not enabled?).</div>`;
    // First words spoken, so sessions are tellable apart at a glance.
    const snip = (s.trace?.cognitive || []).slice(0, 2).map((u) => u.text).join(" ").trim();
    const snippet = snip ? `<span class="snip">“${esc(snip)}”</span>` : "";
    const pathText = s.path ? esc(s.path) : "not written to disk (mic or native-host issue)";
    const pathrow = `<div class="pathrow"><code>${pathText}</code><button class="copy-ref" data-rid="${esc(s.recording_id)}" data-path="${esc(s.path || "")}" data-tstatus="${esc(tstat)}">Copy reference</button></div>`;
    const frames = s.images && s.images.length ? ` · ${s.images.length} frames` : "";
    const el = document.createElement("details");
    el.className = "sess";
    el.innerHTML = `
      <summary>
        <span class="id">${esc(s.recording_id)}</span>
        <span class="meta">${esc(host)} · ${dur}s · ${s.events} events · ${s.utterances} utterances${frames} · ${fmtTime(s.started_at)}</span>
        ${snippet}
      </summary>
      <div class="body">${status}${pathrow}${player}${renderTracks(s.trace, s.recording_id, s.images)}</div>`;
    container.appendChild(el);
  }
}

// The three tracks, side by side and aligned by time. All share one clock
// (ms since started_at), and — this is the load-bearing part — one mapping
// from that clock to a y position, so what was said sits exactly beside what
// was done. Quiet stretches show as visible gaps. Raw per-event JSON is one
// layer deeper.
function renderTracks(trace, rid, images) {
  if (!trace) return `<div class="empty">Trace not stored for this session.</div>`;
  const beh = (trace.behavior || []).slice().sort((a, b) => a.t - b.t);
  const cog = (trace.cognitive || []).slice().sort((a, b) => a.t - b.t);
  const cur = (trace.cursor || []).slice().sort((a, b) => a.t - b.t);
  if (!beh.length && !cog.length && !cur.length)
    return `<div class="empty">Nothing recorded.</div>`;

  // Total span on the shared clock; fall back to the last timestamp seen.
  const lastT = Math.max(
    trace.ended_at ? trace.ended_at - trace.started_at : 0,
    beh.length ? beh[beh.length - 1].t : 0,
    cog.length ? cog[cog.length - 1].end || cog[cog.length - 1].t : 0,
    cur.length ? cur[cur.length - 1].t : 0,
    1000
  );
  // Track C: segment the cursor points into activity blocks (a gap > 500ms
  // starts a new block), so "cursor active, no behavior" stretches are visible
  // against the narration. Each block is clickable → the actual path on canvas.
  const cseg = [];
  {
    let s = null;
    for (const p of cur) {
      if (!s || p.t - s.end > 500) {
        s = { start: p.t, end: p.t, pts: [p] };
        cseg.push(s);
      } else {
        s.end = p.t;
        s.pts.push(p);
      }
    }
  }
  traceCache.set(rid, { beh, cog, cseg, images: images || [] }); // for the popups

  // ---- one shared, content-aware time axis ---------------------------------
  // Position is NOT proportional to time alone: a second holding fifty events
  // needs fifty events' worth of height, and no clamp may take that away.
  // So y advances with elapsed time, and stretches further whenever the lane
  // an item belongs to is still occupied. Crucially the stretch moves the
  // SHARED y, so all three lanes stay on one axis — nothing is nudged per
  // lane, which is what used to desynchronise them from each other and from
  // the time rail while spilling thousands of pixels out of the container.
  const MK_H = 20; // one behavior mark
  const GAP = 3;
  const PX_PER_MS = 0.003; // 3px per idle second: quiet stretches stay visible
  const CW = 112; // curseg content width (lane minus padding/border)

  const uttLines = (u) => Math.min(4, Math.max(1, Math.ceil((u.text || "").length / 46)));

  const items = [];
  beh.forEach((e, i) => items.push({ t: e.t, lane: 0, h: MK_H, kind: "b", i, e }));
  cseg.forEach((s, i) => {
    const im = nearestImage(images, s.start);
    const framed = !!(im && im.dataUrl && im.vw > 0 && im.vh > 0);
    items.push({
      t: s.start,
      lane: 1,
      h: framed ? Math.max(30, Math.round(CW * (im.vh / im.vw))) : 24,
      kind: "c",
      i,
      s,
      im: framed ? im : null
    });
  });
  cog.forEach((u, i) => {
    const lines = uttLines(u);
    items.push({ t: u.t, lane: 2, h: 10 + lines * 17, kind: "n", i, u, lines });
  });
  items.sort((a, b) => a.t - b.t || a.lane - b.lane);

  const bp = [[0, 0]]; // breakpoints [t, y] of the shared mapping
  const free = [0, 0, 0]; // per-lane occupied-until y
  let yy = 0, prevT = 0;
  for (const it of items) {
    yy += (it.t - prevT) * PX_PER_MS;
    prevT = it.t;
    if (yy < free[it.lane]) yy = free[it.lane];
    it.top = Math.round(yy);
    free[it.lane] = it.top + it.h + GAP;
    const last = bp[bp.length - 1];
    if (it.t === last[0]) last[1] = it.top;
    else bp.push([it.t, it.top]);
  }
  // Height is whatever the content actually needed — no clamp, so nothing
  // can overflow into the raw-JSON block below.
  const H = Math.max(Math.round(Math.max(yy + (lastT - prevT) * PX_PER_MS, ...free)) + 8, 220);
  if (lastT > bp[bp.length - 1][0]) bp.push([lastT, H - 8]);

  // The same mapping, interpolated, for things not anchored to an item.
  const y = (t) => {
    if (t <= bp[0][0]) return bp[0][1];
    if (t >= bp[bp.length - 1][0]) return bp[bp.length - 1][1];
    let lo = 0, hi = bp.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (bp[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const [t0, y0] = bp[lo], [t1, y1] = bp[hi];
    return Math.round(y0 + ((t - t0) / (t1 - t0 || 1)) * (y1 - y0));
  };

  // Each gesture: the path drawn on the faded frame it happened over, fit to
  // the frame (SVG viewBox = the frame's viewport, so raw x/y land in place).
  // No frame → a solid block. Click opens the full popup.
  const cursorBlocks = items
    .filter((x) => x.kind === "c")
    .map(({ s, i, im, top, h }) => {
      if (im) {
        const pts = s.pts.map((p) => `${p.x},${p.y}`).join(" ");
        const a = s.pts[0], b = s.pts[s.pts.length - 1];
        const r = Math.round(Math.max(im.vw, im.vh) * 0.013);
        return (
          `<div class="curseg" style="top:${top}px;height:${h}px" data-rid="${esc(rid)}" data-cseg="${i}" title="${s.pts.length} points">` +
          `<img class="curseg-frame" src="${im.dataUrl}" alt="">` +
          `<svg class="curseg-path" viewBox="0 0 ${im.vw} ${im.vh}" preserveAspectRatio="none">` +
          `<polyline points="${pts}" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
          `<polyline points="${pts}" fill="none" stroke="#ffd400" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
          `<circle cx="${a.x}" cy="${a.y}" r="${r}" fill="#0e8a5f"/>` +
          `<circle cx="${b.x}" cy="${b.y}" r="${r}" fill="#d23b2e"/>` +
          `</svg></div>`
        );
      }
      const dens = Math.min(1, s.pts.length / 24);
      return `<div class="cur" style="top:${top}px;height:${h}px;opacity:${(0.35 + 0.55 * dens).toFixed(2)}" data-rid="${esc(rid)}" data-cseg="${i}" title="${s.pts.length} points"></div>`;
    })
    .join("");

  // Each item carries data-rid/idx so a click resolves it to its full record
  // in the popup. Labels truncate with an explicit … ; the full text is in the
  // popup, so nothing is silently clipped.
  const marks = items
    .filter((x) => x.kind === "b")
    .map(({ e, i, top }) => {
      const name = e.anchor?.name || e.anchor?.selector || "";
      const t = (e.t / 1000).toFixed(1);
      const flags =
        (e.suppressed ? ' <span class="sup">[ovr]</span>' : "") +
        (e.inferred ? ' <span class="inf">[?]</span>' : "");
      const label = `${t}s ${esc(e.action)}${flags} ${esc(trunc(name, 32))}`;
      return `<div class="mk${e.inferred ? " mk-inf" : ""}" style="top:${top}px" data-rid="${esc(rid)}" data-kind="b" data-idx="${i}">${label}</div>`;
    })
    .join("");
  const utts = items
    .filter((x) => x.kind === "n")
    .map(({ u, i, top, h, lines }) =>
      `<div class="utt" style="top:${top}px;height:${h}px;-webkit-line-clamp:${lines}" data-rid="${esc(rid)}" data-kind="c" data-idx="${i}">${esc(u.text)}</div>`
    )
    .join("");

  // Time: labels in the left rail, dashed gridlines across every lane. The
  // axis is non-uniform by design, so the spacing between labels is itself
  // information — bursts of activity read as stretched stretches of rail.
  const stepSec = lastT > 240000 ? 60 : lastT > 120000 ? 30 : lastT > 30000 ? 10 : lastT > 10000 ? 5 : 2;
  let railLabels = "", gridLines = "";
  for (let s = 0; s * 1000 <= lastT; s += stepSec) {
    const yt = y(s * 1000);
    railLabels += `<div class="tk" style="top:${yt}px">${s}s</div>`;
    gridLines += `<div class="gl" style="top:${yt}px"></div>`;
  }

  const raw = `<details class="raw"><summary>raw trace JSON</summary><pre>${esc(JSON.stringify(trace, null, 2))}</pre></details>`;

  return `
    <div class="tl-head">
      <div class="th-rail"></div>
      <div class="th-b">Behavior (${beh.length})</div>
      <div class="th-cur">cursor</div>
      <div class="th-n">Narration (${cog.length})</div>
    </div>
    <div class="tl-lanes" style="height:${H}px">
      <div class="rail">${railLabels}</div>
      <div class="lane behav">${marks}</div>
      <div class="curlane">${cursorBlocks}</div>
      <div class="lane narr">${utts}</div>
      <div class="gridlines">${gridLines}</div>
    </div>
    ${raw}`;
}

// ---- detail popup ----
// Clicking a timeline item opens its full record in a modal that floats over
// the page, so the absolutely-positioned timeline never shifts or distorts.
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
function closeModal() {
  modal.hidden = true;
  modalBody.innerHTML = "";
}
modal.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});
document.getElementById("sessions").addEventListener("click", (e) => {
  // Copy a paste-able reference to a session (path + how to read it).
  const copyBtn = e.target.closest(".copy-ref");
  if (copyBtn) {
    e.preventDefault();
    const p = copyBtn.getAttribute("data-path");
    const rid = copyBtn.getAttribute("data-rid");
    const ts = copyBtn.getAttribute("data-tstatus") || "";
    // Same contract as the on-stop reference in background.js: the text must
    // describe what is actually in the bundle, never what usually is.
    const warn =
      ts && ts !== "ok"
        ? ` WARNING — TRANSCRIPT FAILED: ${ts}. The narration track is empty or incomplete, so do NOT read a short/absent cognitive[] as the operator having stayed silent. The raw audio is in audio/ and trace.json records per-segment status in transcript_segments. Please tell me this happened.`
        : "";
    const ref = p
      ? `Read the browser recording at ${p} — an imitation-learning rollout of an expert doing a task. trace.json holds four tracks on one shared clock (behavior, cursor, images, narration); SCHEMA_v0.md in that folder is the field reference, and images/ holds the frames.${warn}`
      : `Recording ${rid} was not written to disk; open it in the Open Claude in Chrome extension Options to inspect.`;
    navigator.clipboard.writeText(ref).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy reference"), 1500);
    });
    return;
  }
  // Cursor gesture thumbnail (or fallback block) → full gesture popup.
  const cblk = e.target.closest(".curseg, .cur");
  if (cblk) {
    const cache = traceCache.get(cblk.getAttribute("data-rid"));
    if (cache && cache.cseg) openCursorDetail(cache.cseg[+cblk.getAttribute("data-cseg")], cache.images);
    return;
  }
  const el = e.target.closest(".mk, .utt");
  if (!el) return;
  const cache = traceCache.get(el.getAttribute("data-rid"));
  if (!cache) return;
  const idx = +el.getAttribute("data-idx");
  if (el.getAttribute("data-kind") === "b") openBehaviorDetail(cache.beh[idx], cache.images);
  else openUtteranceDetail(cache.cog[idx], cache.images);
});

// The 240p frame nearest a given time on the shared clock — the screen as it
// looked at that moment. (The on-disk full-size images/ dir is the agent's;
// these small frames are for the viewer.)
function nearestImage(images, t) {
  if (!images || !images.length) return null;
  let best = images[0], bd = Math.abs(images[0].t - t);
  for (const im of images) {
    const d = Math.abs(im.t - t);
    if (d < bd) { bd = d; best = im; }
  }
  return best;
}
function frameHtml(images, t) {
  const im = nearestImage(images, t);
  if (!im || !im.dataUrl) return "";
  return `${row("Frame", `nearest at ${(im.t / 1000).toFixed(1)}s${im.ref ? ` · <code>${esc(im.ref)}</code>` : ""}`)}<img class="frame" src="${im.dataUrl}" alt="frame">`;
}

// A labelled endpoint dot: filled circle + a coloured pill with the label,
// nudged to stay on-canvas.
function endpointDot(ctx, x, y, color, label) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = "600 11px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width;
  let lx = x + 10;
  if (lx + tw + 6 > ctx.canvas.width) lx = x - tw - 16;
  let ly = y;
  if (ly < 10) ly = 10;
  else if (ly > ctx.canvas.height - 10) ly = ctx.canvas.height - 10;
  ctx.fillStyle = color;
  ctx.fillRect(lx - 4, ly - 8, tw + 8, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, lx, ly + 1);
}

// Cursor gesture drawn ON the frame it happened over. With the frame's viewport
// dims, cursor (x,y) map straight onto the screenshot, so you see the path over
// the actual screen. Start = green, end = red. Falls back to an abstract path
// if the nearest frame has no viewport dims.
function openCursorDetail(seg, images) {
  if (!seg || !seg.pts.length) return;
  const im = nearestImage(images, seg.start);
  const overlay = !!(im && im.dataUrl && im.vw > 0 && im.vh > 0);
  const W = 520;
  const Hc = overlay ? Math.max(120, Math.round(W * (im.vh / im.vw))) : 300;

  modalBody.innerHTML = `
    <h3>Cursor gesture</h3>
    ${row("Time", `${(seg.start / 1000).toFixed(2)}s – ${(seg.end / 1000).toFixed(2)}s`)}
    ${row("Points", String(seg.pts.length))}
    ${overlay ? row("Over frame", `nearest at ${(im.t / 1000).toFixed(1)}s${im.ref ? ` · <code>${esc(im.ref)}</code>` : ""}`) : ""}
    <canvas id="curcv" width="${W}" height="${Hc}"></canvas>
    ${overlay ? "" : frameHtml(images, seg.start)}`;
  modal.hidden = false;
  const ctx = document.getElementById("curcv").getContext("2d");

  const strokePath = (mapx, mapy, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    seg.pts.forEach((p, i) => (i ? ctx.lineTo(mapx(p.x), mapy(p.y)) : ctx.moveTo(mapx(p.x), mapy(p.y))));
    ctx.stroke();
  };
  const drawPath = (mapx, mapy) => {
    strokePath(mapx, mapy, "rgba(0,0,0,.45)", 5); // halo so the path reads on any frame
    strokePath(mapx, mapy, "#ffd400", 2.5);
    const a = seg.pts[0], b = seg.pts[seg.pts.length - 1];
    endpointDot(ctx, mapx(a.x), mapy(a.y), "#0e8a5f", "start");
    endpointDot(ctx, mapx(b.x), mapy(b.y), "#d23b2e", "end");
  };

  if (overlay) {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, Hc);
      ctx.fillStyle = "rgba(0,0,0,.18)"; // dim the frame so the path pops
      ctx.fillRect(0, 0, W, Hc);
      drawPath((x) => (x / im.vw) * W, (y) => (y / im.vh) * Hc);
    };
    img.src = im.dataUrl;
  } else {
    const xs = seg.pts.map((p) => p.x), ys = seg.pts.map((p) => p.y);
    const minx = Math.min(...xs), maxx = Math.max(...xs);
    const miny = Math.min(...ys), maxy = Math.max(...ys);
    const pad = 22, sx = maxx - minx || 1, sy = maxy - miny || 1;
    const scale = Math.min((W - 2 * pad) / sx, (Hc - 2 * pad) / sy);
    drawPath((x) => pad + (x - minx) * scale, (y) => pad + (y - miny) * scale);
  }
}

// The cursor gesture, drawn spatially (the trajectory can't live in a
// time-vertical lane, so the lane shows WHEN and the popup shows the SHAPE —
// the circle, the point, the drag curve). Start = green dot, end = red.
function row(k, v) {
  return v ? `<div class="mrow"><div class="k">${k}</div><div class="v">${v}</div></div>` : "";
}
function openBehaviorDetail(e, images) {
  if (!e) return;
  const a = e.anchor || {};
  const attrs = a.attrs
    ? Object.entries(a.attrs).map(([k, v]) => `<code>${esc(k)}="${esc(v)}"</code>`).join(" ")
    : "";
  const path = a.path && a.path.length ? `<div class="path">${a.path.map(esc).join("\n")}</div>` : "";
  const val = e.value != null ? (typeof e.value === "string" ? e.value : JSON.stringify(e.value)) : "";
  const effect = e.effect ? JSON.stringify(e.effect, null, 2) : "";
  // Spatial grounding, same treatment as the cursor popup: if the event has a
  // pointer position (p) or drag endpoints, draw it ON the nearest frame using
  // the frame's viewport dims. Falls back to the plain frame image otherwise.
  const im = nearestImage(images, e.t);
  // The command core key first; fallbacks for older bundles (flattened
  // fields, then value.from/to and p).
  const ci = (e.command && e.command.input) || e;
  const drag =
    ci.start_coordinate && ci.coordinate
      ? { from: { x: ci.start_coordinate[0], y: ci.start_coordinate[1] },
          to: { x: ci.coordinate[0], y: ci.coordinate[1] } }
      : e.value && e.value.from && e.value.to
        ? e.value
        : null;
  const pt = !drag && ci.coordinate ? { x: ci.coordinate[0], y: ci.coordinate[1] } : e.p || null;
  const overlay = !!(im && im.dataUrl && im.vw > 0 && im.vh > 0 && (pt || drag));
  const W = 520;
  const Hb = overlay ? Math.max(120, Math.round(W * (im.vh / im.vw))) : 0;
  modalBody.innerHTML = `
    <h3>${esc(e.action)}${e.suppressed ? " · override (not fired)" : ""}${e.inferred ? " · inferred (heuristic — check the narration)" : ""}</h3>
    ${row("Time", `${(e.t / 1000).toFixed(2)}s · t=${e.t}ms · tab ${e.tab}/frame ${e.frame ?? 0}`)}
    ${row("Element", esc(a.name || "") + (a.role ? ` · <code>${esc(a.role)}</code>` : ""))}
    ${row("Selector", a.selector ? `<code>${esc(a.selector)}</code>` : "")}
    ${row("Text", esc(a.text || ""))}
    ${row("Attrs", attrs)}
    ${row("Path", path)}
    ${row("Command", e.command ? `<code>${esc(JSON.stringify(e.command))}</code>` : "")}
    ${row("Coordinate", ci.coordinate ? `<code>[${ci.coordinate.join(", ")}]</code>${ci.start_coordinate ? ` from <code>[${ci.start_coordinate.join(", ")}]</code>` : ""}${ci.modifiers ? ` · <code>${esc(ci.modifiers)}</code>` : ""}` : "")}
    ${row("Text", ci.text ? `<code>${esc(ci.text)}</code>` : "")}
    ${row("URL", (ci.url || e.url) ? `<code>${esc(ci.url || e.url)}</code>` : "")}
    ${row("Scroll", ci.scroll_direction ? `<code>${esc(ci.scroll_direction)} × ${ci.scroll_amount || 3} ticks</code>` : "")}
    ${row("Value", val ? `<code>${esc(val)}</code>` : "")}
    ${row("Effect", effect ? `<code>${esc(effect)}</code>` : "")}
    ${overlay
      ? `${row("On frame", `nearest at ${(im.t / 1000).toFixed(1)}s${im.ref ? ` · <code>${esc(im.ref)}</code>` : ""}`)}<canvas id="behcv" width="${W}" height="${Hb}"></canvas>`
      : frameHtml(images, e.t)}
    <details class="raw"><summary>raw JSON</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details>`;
  modal.hidden = false;
  if (overlay) {
    const ctx = document.getElementById("behcv").getContext("2d");
    const mx = (x) => (x / im.vw) * W;
    const my = (y) => (y / im.vh) * Hb;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, Hb);
      ctx.fillStyle = "rgba(0,0,0,.18)"; // dim so the marker pops
      ctx.fillRect(0, 0, W, Hb);
      if (drag) {
        ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 5; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(mx(drag.from.x), my(drag.from.y)); ctx.lineTo(mx(drag.to.x), my(drag.to.y)); ctx.stroke();
        ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(mx(drag.from.x), my(drag.from.y)); ctx.lineTo(mx(drag.to.x), my(drag.to.y)); ctx.stroke();
        endpointDot(ctx, mx(drag.from.x), my(drag.from.y), "#0e8a5f", "from");
        endpointDot(ctx, mx(drag.to.x), my(drag.to.y), "#d23b2e", "to");
      } else if (pt) {
        // Crosshair ring at the pointer position + the action as the label.
        ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(mx(pt.x), my(pt.y), 11, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx(pt.x), my(pt.y), 11, 0, Math.PI * 2); ctx.stroke();
        endpointDot(ctx, mx(pt.x), my(pt.y), "#2a5fd8", e.action);
      }
    };
    img.src = im.dataUrl;
  }
}
function openUtteranceDetail(u, images) {
  if (!u) return;
  modalBody.innerHTML = `
    <h3>Narration</h3>
    ${row("Time", `${(u.t / 1000).toFixed(2)}s – ${(u.end / 1000).toFixed(2)}s`)}
    ${row("Said", esc(u.text))}
    ${frameHtml(images, u.t)}
    <details class="raw"><summary>raw JSON</summary><pre>${esc(JSON.stringify(u, null, 2))}</pre></details>`;
  modal.hidden = false;
}

renderSessions();

// Audits pane: its own module, wired here so the recorder UI stays untouched.
wireAuditTabs();
