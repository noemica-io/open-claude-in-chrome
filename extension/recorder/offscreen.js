// Offscreen buffer + mic capture + stop pipeline.
//
// Reliability (§3):
//   - behavior events: appended to IndexedDB as they arrive (100%, local).
//   - audio: MediaRecorder timeslice → each chunk appended to IndexedDB
//     (~90%: only the final un-flushed slice is at risk on a crash), then
//     written to disk at stop BEFORE transcription is attempted.
//   - transcript: produced at stop from the saved audio (needs internet;
//     never blocks the bundle, and its failure is reported, never swallowed).
//
// The service worker forwards behavior events here and sends start/stop
// commands. This document owns the durable state so it survives SW eviction.
//
// NEEDS LIVE TESTING (Chrome): mic permission, MediaRecorder, IndexedDB.

import { transcribe, validateOpenAiKey } from "./transcribe.js";
import {
  newTrace,
  segmentsToCognitive,
  cursorToTrack,
  imagesToTrack,
  SCHEMA_VERSION
} from "./schema.js";

const AUDIO_TIMESLICE_MS = 3000; // flush an audio chunk to disk every 3s
const WARMUP_MS = 2500; // hold "ready" until the mic input settles (muffled start)

// Speech, not music: 32kbps mono Opus is transparent to Whisper (which
// resamples to 16kHz anyway) and 4x smaller than Chrome's ~128kbps default.
const AUDIO_BITRATE = 32000;

// Rotate the recorder into a fresh segment every 10 minutes (~2.4MB each).
// This is what makes a recording of ANY length transcribable: each segment is
// a complete, independently-decodable WebM, so it can be uploaded on its own.
// The MediaStream is NEVER touched — only the encoder is recycled — so the mic
// is not released, there is no permission re-prompt, and the operator sees
// nothing. The boundary costs one or two Opus frames (~20-60ms).
const SEGMENT_MS = 10 * 60 * 1000;

let db = null;
let mediaRecorder = null;
let micStream = null;
let segmentTimer = null;
let stopping = false;
let session = null; // { recording_id, started_at, segments, apiKey, url0 }
let pendingStop = null; // { recording_id, trace, segBlobs } between stop and transcribe

// ---- IndexedDB (durable buffer) -------------------------------------------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ocic-recorder", 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("events"))
        d.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("audio"))
        d.createObjectStore("audio", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("sessions"))
        d.createObjectStore("sessions", { keyPath: "recording_id" });
      if (!d.objectStoreNames.contains("cursor"))
        d.createObjectStore("cursor", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("images"))
        d.createObjectStore("images", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function put(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).add(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
// add() throws on a duplicate key; the session record is written once at stop
// and again after transcription, so that one needs an upsert.
function putRecord(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function getAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getRow(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function clearStore(store) {
  return new Promise((resolve) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = resolve;
  });
}
function patchSession(recording_id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const get = store.get(recording_id);
    get.onsuccess = () => {
      const rec = get.result;
      if (rec) {
        Object.assign(rec, patch);
        store.put(rec);
      }
      resolve(!!rec);
    };
    get.onerror = () => reject(get.error);
  });
}

// ---- audio segments --------------------------------------------------------
// Start a new encoder over the SAME live MediaStream and stamp its wall-clock
// start. Every segment is anchored to its own epoch, so transcript timestamps
// are mapped independently and boundary loss can never accumulate into drift.
function startSegment() {
  const index = session.segments.length;
  session.segments.push({ index, startEpoch: Date.now() });
  const mr = new MediaRecorder(micStream, {
    mimeType: "audio/webm",
    audioBitsPerSecond: AUDIO_BITRATE
  });
  mr.ondataavailable = async (e) => {
    if (e.data && e.data.size) {
      const buf = await e.data.arrayBuffer();
      // Tag the row with the recording it belongs to. The audio store is only
      // cleared when the NEXT recording starts, so without this tag a retranscribe
      // of an older recording would map its segEpochs onto a newer recording's
      // bytes and silently overwrite the older trace.json with the wrong transcript.
      await put("audio", { recording_id: session.recording_id, seg: index, bytes: buf, at: Date.now() });
    }
  };
  mr.start(AUDIO_TIMESLICE_MS);
  mediaRecorder = mr;
}

function rotateSegment() {
  const mr = mediaRecorder;
  if (!mr || mr.state === "inactive" || stopping || !session) return;
  // Chain the successor off onstop so the gap is one task, not one timer tick.
  mr.onstop = () => {
    if (!stopping && session) startSegment();
  };
  mr.stop();
}

// ---- lifecycle -------------------------------------------------------------
async function startRecording(cmd) {
  // NEVER clobber a recording in progress. If the service worker lost track of
  // us (MV3 eviction wiped its globals) and asks to start again, refuse and
  // report the live session so the SW can adopt it instead. Without this
  // guard, the clearStore calls below silently destroyed in-flight demos.
  if (session) {
    return {
      ok: false,
      already: true,
      session: { recording_id: session.recording_id, started_at: session.started_at }
    };
  }
  db = db || (await openDb());
  await clearStore("events");
  await clearStore("audio");
  await clearStore("cursor");
  await clearStore("images");
  stopping = false;
  pendingStop = null;
  session = {
    recording_id: cmd.recording_id,
    started_at: cmd.started_at, // epoch ms — shared clock zero
    segments: [],
    apiKey: cmd.apiKey,
    url0: cmd.url0 || null
  };

  // Mic → MediaRecorder → audio chunks to IndexedDB.
  // An offscreen document CANNOT show a permission prompt, so the mic grant
  // must already exist (granted via the Options page). If it doesn't, fail
  // with a clear message the service worker surfaces to the operator.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    session = null;
    const msg =
      e && e.name === "NotAllowedError"
        ? "Microphone permission not granted. Open the extension Options and click Enable microphone."
        : `Microphone error: ${e && e.message}`;
    return { ok: false, error: msg };
  }
  startSegment();
  segmentTimer = setInterval(rotateSegment, SEGMENT_MS);
  // Warm-up: the first couple of seconds of mic audio are often muffled while
  // the input settles. Hold the "ready" reply until then, and set the trace
  // zero to the post-warm-up moment, so the operator isn't cued to talk early
  // and the clock starts on clean audio. (The SW shows REC only after this
  // reply, and behavior capture starts then too, so no events land in warm-up.)
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  session.started_at = Date.now();
  return { ok: true };
}

async function addEvent(evt) {
  if (!session) return;
  // Convert epoch to ms-since-start (the shared clock) at ingest.
  const e = { ...evt };
  delete e.__ocic;
  e.t = evt.t - session.started_at;
  await put("events", e);
}

// Raw cursor points arrive in batches; stored as-is (epoch t), converted to
// the shared clock at stop.
async function addCursor(points) {
  if (!session || !points || !points.length) return;
  await put("cursor", { points });
}

// Downscale a captured frame to 240p JPEG (small enough to keep in IndexedDB
// for the viewer). Runs here because the offscreen document has canvas + Image;
// the service worker does not. Returns { dataUrl, w, h }.
function resize240(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const h = 240;
      const w = Math.max(1, Math.round(img.width * (h / img.height)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: c.toDataURL("image/jpeg", 0.6), w, h });
    };
    img.onerror = () => resolve({ dataUrl, w: 0, h: 0 });
    img.src = dataUrl;
  });
}

// A captured frame: resize, store (blob-as-dataURL + ref + t) for the viewer,
// and return the resized dataURL so the SW can write the file to disk.
async function addImage(msg) {
  if (!session) return { ok: false };
  const { dataUrl, w, h } = await resize240(msg.dataUrl);
  await put("images", { t: msg.t, ref: msg.ref, dataUrl, w, h, vw: msg.vw, vh: msg.vh });
  return { ok: true, dataUrl, w, h };
}

// Stop capture and assemble the tracks. Transcription deliberately does NOT
// happen here: the SW writes the audio to disk between this call and
// `transcribe`, so the narration source is durable before anything that can
// fail over the network is attempted.
async function stopRecording() {
  if (!session) return { ok: false, error: "no active session" };
  const s = session;
  stopping = true;
  if (segmentTimer) {
    clearInterval(segmentTimer);
    segmentTimer = null;
  }

  // Flush + stop the current segment.
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      mediaRecorder.stop();
    });
  }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());

  // Reassemble one Blob per segment (Tier: ~90% — everything flushed is here).
  const audioRows = await getAll("audio");
  const bySeg = new Map();
  for (const r of audioRows) {
    const k = r.seg ?? 0;
    if (!bySeg.has(k)) bySeg.set(k, []);
    bySeg.get(k).push(r.bytes);
  }
  const segBlobs = s.segments
    .map((seg) => ({
      ...seg,
      blob: new Blob(bySeg.get(seg.index) || [], { type: "audio/webm" })
    }))
    .filter((seg) => seg.blob.size > 0);

  // Track A from the durable event log (Tier: 100%).
  const eventRows = await getAll("events");
  const trace = newTrace(s.started_at, { recording_id: s.recording_id, url0: s.url0 });
  trace.behavior = eventRows.sort((a, b) => a.t - b.t);
  // Track C: the raw cursor trajectory, flattened from batches, on the clock.
  const cursorRows = await getAll("cursor");
  trace.cursor = cursorToTrack(cursorRows.flatMap((r) => r.points || []), s.started_at);
  // Track D: frame references into images/ (the files are already on disk).
  const imageRows = await getAll("images");
  trace.images = imagesToTrack(imageRows, s.started_at);
  trace.ended_at = Date.now();
  trace.transcript_status = "pending";

  pendingStop = {
    recording_id: s.recording_id,
    apiKey: s.apiKey,
    trace,
    segBlobs,
    imageRows
  };
  session = null;

  // Write the session record NOW, before transcription. If transcription
  // never runs (SW evicted, browser closed), the viewer still shows the
  // session — saying plainly that the transcript never completed, rather
  // than the session vanishing from the list.
  await writeSessionRecord(pendingStop, "pending: transcription did not finish");

  return {
    ok: true,
    bundle: {
      recording_id: s.recording_id,
      schema: SCHEMA_VERSION,
      trace,
      // metadata only — Blobs do not survive runtime messaging, so the SW
      // pulls the bytes back with `audio_slice` below.
      audioSegments: segBlobs.map((x) => ({
        index: x.index,
        size: x.blob.size,
        name: audioName(x.index)
      }))
    }
  };
}

function audioName(index) {
  return `audio/${String(index).padStart(3, "0")}.webm`;
}

// Hand a slice of one segment's bytes to the SW as base64, so it can be
// written to disk through the native host. Sliced because runtime messages
// are JSON and a whole segment would make an unreasonably large one.
function audioSlice(msg) {
  const seg = pendingStop && pendingStop.segBlobs.find((x) => x.index === msg.index);
  if (!seg) return Promise.resolve({ ok: false, error: "no such segment" });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve({ ok: true, b64: s.slice(s.indexOf(",") + 1) });
    };
    fr.onerror = () => resolve({ ok: false, error: String(fr.error) });
    fr.readAsDataURL(seg.blob.slice(msg.start, msg.start + msg.len));
  });
}

// Transcribe every segment, then merge onto the shared clock. Each segment is
// mapped through its OWN epoch anchor, so one failed or slow segment shifts
// nothing around it — a failure is a hole, never a drift.
async function transcribeRecording() {
  if (!pendingStop) return { ok: false, error: "nothing to transcribe" };
  const { trace, segBlobs, apiKey, recording_id, imageRows } = pendingStop;

  const { status } = await runTranscription(segBlobs, apiKey, trace);

  await writeSessionRecord(pendingStop, status);
  pendingStop = null;
  return {
    ok: true,
    cognitive: trace.cognitive,
    transcript_status: status,
    transcript_segments: trace.transcript_segments,
    summary: buildSummary(trace)
  };
}

// Shared transcription core: run whisper over each segment, map onto the shared
// clock, and fold statuses into the trace. Used at stop (in-memory segBlobs)
// and on retry (segments rebuilt from IndexedDB). Only mutates the passed
// trace — persistence is the caller's job.
async function runTranscription(segBlobs, apiKey, trace) {
  const segStatuses = [];
  let cognitive = [];
  for (const seg of segBlobs) {
    const t0 = seg.startEpoch - trace.started_at;
    try {
      const r = await transcribe(seg.blob, apiKey, { filename: `${seg.index}.webm` });
      cognitive = cognitive.concat(
        segmentsToCognitive(r.segments, seg.startEpoch, trace.started_at)
      );
      segStatuses.push({ index: seg.index, t: t0, status: "ok" });
    } catch (err) {
      segStatuses.push({ index: seg.index, t: t0, status: `failed: ${err.message}` });
    }
  }
  cognitive.sort((a, b) => a.t - b.t || a.end - b.end);

  const failed = segStatuses.filter((x) => x.status !== "ok");
  let status;
  if (!segStatuses.length) status = "failed: no audio was captured";
  else if (!failed.length) status = "ok";
  else if (failed.length === segStatuses.length) status = failed[0].status;
  else
    status = `partial: ${failed.length} of ${segStatuses.length} audio segments failed — ${failed[0].status.replace(/^failed: /, "")}`;

  trace.cognitive = cognitive;
  trace.transcript_status = status;
  trace.transcript_segments = segStatuses;
  return { cognitive, status, segStatuses };
}

// Re-run transcription for a saved recording whose transcript failed at stop.
// The durable segment bytes live in IndexedDB until the next recording starts,
// and the per-segment epoch anchors persisted in the session record map them
// onto the same shared clock. The SW writes the patched trace to disk.
async function retranscribe(recording_id, apiKey) {
  db = db || (await openDb());
  const row = await getRow("sessions", recording_id);
  if (!row || !row.trace) return { ok: false, error: "no such recording" };
  if (!row.segEpochs || !row.segEpochs.length)
    return { ok: false, error: "recording predates this retry path (missing segment anchors)" };

  // Only this recording's own audio. The store also holds any NEWER recording's
  // bytes until that one starts recording clears it, so without the filter a
  // retranscribe of an older recording would transcribe the wrong audio and
  // overwrite the older recording's trace.json with a mismatched transcript.
  // (A pre-fix target row has no recording_id and is filtered out — safe failure,
  // and such recordings are already rejected by the segEpochs guard above.)
  const audioRows = (await getAll("audio")).filter((r) => r.recording_id === recording_id);
  const bySeg = new Map();
  for (const r of audioRows) {
    const k = r.seg ?? 0;
    if (!bySeg.has(k)) bySeg.set(k, []);
    bySeg.get(k).push(r.bytes);
  }
  const segBlobs = row.segEpochs
    .map((e) => ({
      index: e.index,
      startEpoch: e.startEpoch,
      blob: new Blob(bySeg.get(e.index) || [], { type: "audio/webm" })
    }))
    .filter((seg) => seg.blob.size > 0);
  if (!segBlobs.length)
    return { ok: false, error: "no audio segments remain (a newer recording cleared them)" };

  const trace = row.trace;
  const { status } = await runTranscription(segBlobs, apiKey, trace);
  row.trace = trace;
  row.transcriptStatus = status;
  row.utterances = (trace.cognitive || []).length;
  await putRecord("sessions", row);
  return {
    ok: true,
    recording_id,
    trace,
    cognitive: trace.cognitive,
    transcript_status: status,
    transcript_segments: trace.transcript_segments,
    summary: buildSummary(trace)
  };
}

// The session record the Options viewer renders (progressive disclosure). The
// full trace (text, small) is kept so the viewer can drill from metadata into
// the tracks and per-action anchors. Written twice: once at stop, once with
// the transcript result — so the list is never missing a saved recording.
async function writeSessionRecord(p, status) {
  db = db || (await openDb());
  const { trace, segBlobs, imageRows, recording_id } = p;
  await putRecord("sessions", {
    recording_id,
    started_at: trace.started_at,
    ended_at: trace.ended_at,
    url0: trace.url0,
    events: (trace.behavior || []).length,
    utterances: (trace.cognitive || []).length,
    transcriptStatus: status,
    // Per-segment epoch anchors, so a later retry can re-run transcription and
    // map the rebuilt track onto the same shared clock.
    segEpochs: (segBlobs || []).map((x) => ({ index: x.index, startEpoch: x.startEpoch })),
    trace,
    // kept for playback in the viewer; the authoritative copy is on disk
    audio: new Blob(segBlobs.map((x) => x.blob), { type: "audio/webm" }),
    // 240p frames (dataURL) on the shared clock — the viewer can't read the
    // on-disk images/ dir, so it shows these; the agent uses the disk files.
    images: (imageRows || []).map((r) => ({
      t: r.t - trace.started_at,
      ref: r.ref,
      dataUrl: r.dataUrl,
      w: r.w,
      h: r.h,
      vw: r.vw,
      vh: r.vh
    }))
  });
}

function buildSummary(trace) {
  const dur = Math.round(((trace.ended_at || 0) - trace.started_at) / 1000);
  const tabs = new Set(trace.behavior.map((e) => e.tab)).size;
  const host = (() => {
    try { return new URL(trace.url0).host; } catch { return "a site"; }
  })();
  const utt = (trace.cognitive || []).length;
  const narration =
    trace.transcript_status === "ok"
      ? `${utt} utterance(s)`
      : `NO usable narration (${trace.transcript_status})`;
  return `Recording ready: ${dur}s across ${tabs || 1} tab(s) on ${host}, ${narration}.`;
}

// Copy text to the clipboard on the SW's behalf (the SW has no clipboard).
// Uses the textarea + execCommand pattern, which works in an offscreen
// document created with the CLIPBOARD reason + the clipboardWrite permission.
function copyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text || "";
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return { ok };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

// ---- message bridge with the service worker -------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__ocic_offscreen !== true) return;
  (async () => {
    try {
      if (msg.cmd === "probe_key") sendResponse(await validateOpenAiKey(msg.apiKey));
      else if (msg.cmd === "start") sendResponse(await startRecording(msg));
      else if (msg.cmd === "event") sendResponse(await addEvent(msg.event));
      else if (msg.cmd === "cursor") sendResponse(await addCursor(msg.points));
      else if (msg.cmd === "image") sendResponse(await addImage(msg));
      else if (msg.cmd === "stop") sendResponse(await stopRecording());
      else if (msg.cmd === "audio_slice") sendResponse(await audioSlice(msg));
      else if (msg.cmd === "transcribe") sendResponse(await transcribeRecording());
      else if (msg.cmd === "retranscribe") sendResponse(await retranscribe(msg.recording_id, msg.apiKey));
      else if (msg.cmd === "copy") sendResponse(copyText(msg.text));
      else if (msg.cmd === "set_path") {
        db = db || (await openDb());
        await patchSession(msg.recording_id, { path: msg.path });
        sendResponse({ ok: true });
      } else sendResponse({ ok: false, error: "unknown cmd" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
  })();
  return true; // async response
});
