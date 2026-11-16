// Saved browser workflows: a flow worked out once in a project, replayed in
// one call afterwards.
//
// The first time through a flow, every step depends on what the page showed,
// so it costs a model turn per step. The second time the answers are already
// known; only the page is new. So the host journals every action it runs,
// workflow_save turns the successful ones into a named flow on disk (in the
// project, next to the code it automates), and workflow_run replays it without
// the model in the loop.
//
// Replay never trusts a recorded coordinate or ref: both are stale by the next
// session. Each element-targeted action is recorded with an anchor instead (a
// selector built from the element that was actually under the point, or the
// role and name of the ref), located fresh at replay, waited for, and checked
// before anything is dispatched. A step that cannot be matched stops the run
// and says how far it got, rather than clicking whatever is there now: this is
// the operator's real browser, and a misplaced click has real effects.

import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".claude", "ocic-workflows");
const JOURNAL_MAX = 500;
const ANCHOR_WAIT_MS = 6000;
const POLL_MS = 150;
const SETTLE_QUIET_MS = 200;
const SETTLE_MAX_MS = 3000;
// Before reporting, wait out the last step's consequences (a submit's request
// typically changes nothing on screen until it returns).
const FINAL_QUIET_MS = 1000;
const FINAL_MAX_MS = 8000;

const CLICKS = new Set(["left_click", "right_click", "double_click", "triple_click", "hover"]);
// Calls that only look. Left out of a saved flow; the replay looks at the end.
const OBSERVE = new Set([
  "read_page", "get_page_text", "find", "tabs_context_mcp", "read_console_messages",
  "read_network_requests", "debug", "debug_timings", "get_config"
]);
// The tab-only failure texts the extension returns as ordinary results.
const FAILED = /^(Error|Could not|No elements found|Tab \d+ is not in the MCP group|Invalid URL|coordinate is required|text is required)|WARNING: (nothing received|landed on)/;

const MUTATES = /\.(click|submit|focus|blur|remove|reset|requestSubmit|setAttribute|removeAttribute|setItem|removeItem|dispatchEvent|append|prepend|insertAdjacent\w*|replaceWith)\s*\(|\.(value|checked|selected|selectedIndex|innerHTML|innerText|textContent|href|hash|src|disabled)\s*=(?!=)|\blocation\s*=(?!=)|\.assign\s*\(|\.replace\s*\(\s*['"`]https?:|history\.(push|replace)State|scroll(To|By|IntoView)\s*\(/;
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// --- In-page scripts (main world, via javascript_tool) ------------------------

// Describe the actionable element under a point well enough to find it again
// on a fresh load: an id or a distinctive attribute when the page has one,
// otherwise an nth-of-type path up to the nearest ancestor that does.
const ANCHOR_AT = (x, y) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  el = el.closest('a,button,input,select,textarea,label,summary,[role],[onclick],[tabindex],[contenteditable="true"]') || el;
  const q = (v) => '"' + String(v).replace(/["\\\\]/g, '\\\\$&') + '"';
  const uniq = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const own = (e) => {
    const t = e.tagName.toLowerCase();
    if (e.id && uniq('#' + CSS.escape(e.id))) return '#' + CSS.escape(e.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder', 'title', 'for', 'href']) {
      const v = e.getAttribute(a);
      if (v && v.length < 120 && uniq(t + '[' + a + '=' + q(v) + ']')) return t + '[' + a + '=' + q(v) + ']';
    }
    if (e.type && t === 'input' && e.value && uniq(t + '[value=' + q(e.value) + ']')) return t + '[value=' + q(e.value) + ']';
    return null;
  };
  let sel = own(el), strong = !!sel;
  if (!sel) {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const o = e === el ? null : own(e);
      if (o) { parts.unshift(o); break; }
      const t = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [e];
      parts.unshift(sib.length > 1 ? t + ':nth-of-type(' + (sib.indexOf(e) + 1) + ')' : t);
    }
    sel = parts.join(' > ');
  }
  const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  return JSON.stringify({ sel, strong, text, tag: el.tagName.toLowerCase() });
})()`;

// Find an anchor's element now, bring it into view, and return the point a
// click there would actually land on it. "covered" means something else is on
// top; "text" means a path selector found a different element than recorded.
const LOCATE = (a) => `(() => {
  const a = ${JSON.stringify(a)};
  const norm = (s) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  let els; try { els = [...document.querySelectorAll(a.sel)]; } catch { return JSON.stringify({ miss: 'bad selector' }); }
  els = els.filter((e) => e.getClientRects().length);
  if (!els.length) return JSON.stringify({ miss: 'not on page' });
  const textOf = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label'));
  let el = els.find((e) => textOf(e) === a.text) || (a.strong || !a.text ? els[0] : null);
  // A positional path finds whatever is in that slot now. When its text is not
  // the recorded one (a list reordered, or a param chose a different option),
  // loosen the positions one level at a time from the element upward and take
  // the element whose text matches, if exactly one does.
  if (!el && !a.strong && a.text) {
    const parts = a.sel.split(' > ');
    for (let k = parts.length - 1; k >= 0 && !el; k--) {
      if (!/:nth-of-type\\(\\d+\\)/.test(parts[k])) continue;
      parts[k] = parts[k].replace(/:nth-of-type\\(\\d+\\)/, '');
      let hits = [];
      try { hits = [...document.querySelectorAll(parts.join(' > '))].filter((e) => e.getClientRects().length && textOf(e) === a.text); } catch {}
      if (hits.length === 1) el = hits[0];
      else if (hits.length > 1) return JSON.stringify({ miss: 'ambiguous', n: hits.length });
    }
  }
  if (!el) return JSON.stringify({ miss: 'text', saw: textOf(els[0]) });
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    r = el.getBoundingClientRect();
  }
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  if (!top || !(top === el || el.contains(top) || top.contains(el) || (top.tagName === 'LABEL' && top.control === el))) {
    return JSON.stringify({ miss: 'covered', by: top ? top.tagName.toLowerCase() : null });
  }
  return JSON.stringify({ x, y });
})()`;

// A count of DOM mutations since the observer was installed, plus the load
// state; installs the observer on first use in each document. The quiet period
// is timed by the host polling this, NOT by a timer in the page: browsers clamp
// timers in background tabs (Firefox to >= 1s), which turned every 200ms settle
// into a second or more per step.
// Known prototype limitation: the counter is a main-world global the page could
// see. Moving it into the content script's isolated world removes that.
const MUTATIONS = `(() => {
  const k = '__ocicMut';
  if (!window[k]) {
    const c = { n: 0 };
    Object.defineProperty(window, k, { value: c, enumerable: false });
    new MutationObserver((m) => { c.n += m.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return JSON.stringify(window[k].n + ':' + document.readyState);
})()`;

// The values a run will repeat verbatim: typed text, set values, and the
// choices made among options (a radio, a menu item), whether clicked or set
// with form_input. A value the saver forgot to name as a param ends up here,
// which is how it gets noticed. Computed from the steps whenever it is shown,
// so a file saved before a fix to this logic is still described correctly.
function fixedValues(steps) {
  const out = [];
  const add = (v) => {
    v = typeof v === "string" ? v.slice(0, 40) : v;
    if (typeof v === "string" && v && !/\{\{\w+\}\}/.test(v) && !out.includes(v)) out.push(v);
  };
  const CHOICE = /^(radio|option|menuitem|menuitemradio|tab)$/;
  const TOGGLE = /^(checkbox|switch|menuitemcheckbox)$/;
  for (const s of steps) {
    const a = s.anchor;
    if (s.tool === "computer" && s.args.action === "type") add(s.args.text);
    if (s.tool === "form_input") {
      if (a?.kind === "ref" && CHOICE.test(a.role)) add(a.name);
      else if (a?.kind === "ref" && TOGGLE.test(a.role)) add(`${a.name}: ${s.args.value}`);
      else if (typeof s.args.value === "string") add(s.args.value);
    }
    if (a && s.tool === "computer" && CLICKS.has(s.args.action)) {
      if (a.kind === "ref" && CHOICE.test(a.role)) add(a.name);
      if (a.kind === "point" && /^(input|option|label)$/.test(a.tag) && a.text && a.text !== "on") add(a.text);
    }
  }
  return out;
}

function list() {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8")));
    } catch {}
  }
  return out;
}


// Standing guidance on WHEN to save. Without it, a model asked to file a ticket
// filed it and stopped, even with "we do this regularly" in the prompt: nothing
// in its context suggested a flow could be kept. It names the params rule
// explicitly because the commonest bad save was a varying value left out.
const SAVE_GUIDANCE =
  "Browser workflows: when you finish a multi-step browser flow (roughly five or more actions) that this project is likely to need again — submitting a form, logging in and reaching a page, a search with several filters, a routine admin task — save it right away with workflow_save, without being asked. In params, name every value that could differ next time (each text you typed and each option you chose that came from the task), not just the obvious ones. Do not save one-off exploration, pure reading or lookups, or flows of only a couple of steps.";

// Everything the server instructions say about workflows: when to save, and
// what this project has already saved.
export function workflowInstructions() {
  const note = savedWorkflowsNote();
  return SAVE_GUIDANCE + (note ? "\n\n" + note : "");
}

// The saved workflows for this project, as text for the model, or "" if none.
// Shown in two places: the server instructions, which the model reads before it
// plans anything, and the tabs_context_mcp result. The second alone proved too
// late: a session decides how to approach the task, and loads the tools for it,
// before it calls tabs_context_mcp, and in benchmark runs it went on to ignore a
// listing that matched its task exactly.
export function savedWorkflowsNote() {
  const wfs = list();
  if (!wfs.length) return "";
  return (
    "Saved browser workflows for this project — if the task is one of these, run it with workflow_run (one call) instead of repeating the steps:\n" +
    wfs.map((w) => `- ${w.name}${w.params.length ? `(${w.params.join(", ")})` : ""}: ${(w.description || `${w.steps.length} steps`).replace(/[.\s]*$/, ".")}` +
      (fixedValues(w.steps).length ? ` Fixed in every run: ${fixedValues(w.steps).map((v) => JSON.stringify(v)).join(", ")}.` : "")).join("\n")
  );
}

export function createWorkflows(dispatch) {
  // dispatch(tool, args) -> MCP result envelope, bypassing the journal.
  const journal = []; // { tool, args, tabId, anchor, ok }
  const marks = new Map(); // tabId -> journal length at the last save/run
  const refs = new Map(); // tabId -> Map(ref -> { role, name })

  // Wait until the page has made no DOM changes for `quiet` ms and finished
  // loading, or `max` ms have passed. A navigation resets the counter, which
  // reads as a change, so a page being replaced never looks settled.
  async function settle(tabId, quiet, max) {
    const end = Date.now() + max;
    let last = null;
    let since = Date.now();
    while (Date.now() < end) {
      const v = await js(tabId, MUTATIONS).catch(() => null);
      if (v !== last) {
        last = v;
        since = Date.now();
      } else if (v && v.endsWith(":complete") && Date.now() - since >= quiet) {
        return;
      }
      await sleep(50);
    }
  }

  async function js(tabId, expression) {
    const r = await dispatch("javascript_tool", { action: "javascript_exec", text: expression, tabId });
    const t = textOf(r);
    if (t.startsWith("Error")) throw new Error(t);
    try {
      const v = JSON.parse(t);
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return null;
    }
  }

  // Learn ref -> (role, name) from find and read_page output, so a ref-based
  // step can be re-found by what it was rather than by an id that dies with
  // the page.
  function learnRefs(tool, tabId, text) {
    let m = refs.get(tabId);
    if (!m) refs.set(tabId, (m = new Map()));
    const re = tool === "find"
      ? /^\[(ref_\d+)\] (\S+) "(.*)" at \(/gm
      : /^\s*(\S+) "(.*?)" \[(ref_\d+)\]/gm;
    for (const x of text.matchAll(re)) {
      const [ref, role, name] = tool === "find" ? [x[1], x[2], x[3]] : [x[3], x[1], x[2]];
      m.set(ref, { role, name });
    }
  }

  // --- Recording -------------------------------------------------------------

  // Where the page is: what a step's precondition is checked against. Path and
  // hash only, since query strings tend to carry per-session tokens.
  const HERE = "JSON.stringify(location.pathname + location.hash)";

  async function anchorFor(tool, args) {
    if (tool === "computer" && CLICKS.has(args.action) && Array.isArray(args.coordinate) && !args.ref) {
      try {
        return { kind: "point", ...(await js(args.tabId, ANCHOR_AT(args.coordinate[0], args.coordinate[1]))) };
      } catch {
        return null;
      }
    }
    if (args && typeof args.ref === "string") {
      const known = refs.get(args.tabId)?.get(args.ref);
      return known ? { kind: "ref", ...known } : null;
    }
    return null;
  }

  // Runs before each call: the anchor of the element it targets, and where the
  // page was when it ran. Observation calls skip both.
  async function before(tool, args) {
    if (typeof args?.tabId !== "number" || OBSERVE.has(tool) || tool.startsWith("workflow_")) return {};
    if (tool === "computer" && ["screenshot", "zoom", "wait"].includes(args.action)) return {};
    const at = await js(args.tabId, HERE).catch(() => null);
    return { anchor: await anchorFor(tool, args), at: typeof at === "string" ? at : null };
  }

  function after(tool, args, result, { anchor = null, at = null } = {}) {
    const text = textOf(result);
    if (tool === "find" || tool === "read_page") learnRefs(tool, args.tabId, text);
    if (typeof args?.tabId !== "number") return;
    journal.push({ tool, args: structuredClone(args), tabId: args.tabId, anchor, at, ok: !FAILED.test(text) });
    if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
  }

  // --- Saving ----------------------------------------------------------------

  function keep(e) {
    if (!e.ok || OBSERVE.has(e.tool) || e.tool.startsWith("workflow_")) return false;
    // Most page JS is a read (probing for an element, pulling a value), which a
    // replay does not need and which can throw on a page that is still loading.
    // Keep only code that changes the page: dropping one of those would make
    // the replay silently skip an action, so this errs toward keeping.
    if (e.tool === "javascript_tool") return MUTATES.test(String(e.args.text || ""));
    if (e.tool === "computer" && ["screenshot", "zoom", "wait"].includes(e.args.action)) return false;
    // An element action nobody could re-find is not replayable; drop it rather
    // than replay a blind coordinate.
    if ((e.tool === "computer" && CLICKS.has(e.args.action)) || e.tool === "form_input") return !!e.anchor;
    return true;
  }

  function parameterize(value, params) {
    if (typeof value === "string") {
      let out = value;
      for (const [k, ex] of params) out = out.split(ex).join(`{{${k}}}`);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => parameterize(v, params));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, parameterize(v, params)]));
    }
    return value;
  }

  function describe(s, i) {
    const a = s.args;
    const target = s.anchor
      ? s.anchor.kind === "ref" ? ` ${s.anchor.role} "${s.anchor.name}"` : ` <${s.anchor.sel}>${s.anchor.text ? ` "${s.anchor.text}"` : ""}`
      : "";
    if (s.tool === "navigate") return `${i}. navigate ${a.url}`;
    if (s.tool === "form_input") return `${i}. form_input${target} = ${JSON.stringify(a.value)}`;
    if (s.tool === "computer") {
      if (a.action === "type" || a.action === "key") return `${i}. ${a.action} ${JSON.stringify(a.text)}`;
      if (a.action === "scroll") return `${i}. scroll ${a.scroll_direction || "down"} x${a.scroll_amount || 3}`;
      return `${i}. ${a.action}${target}`;
    }
    if (s.tool === "javascript_tool") return `${i}. javascript ${JSON.stringify(String(a.text).slice(0, 60))}`;
    return `${i}. ${s.tool}`;
  }

  function save({ name, description = "", tabId, params = {}, drop = [] }) {
    if (!name) return "workflow_save needs a name.";
    const start = marks.get(tabId) ?? 0;
    const steps = journal.slice(start).filter((e) => e.tabId === tabId && keep(e));
    const dropped = new Set(drop.map(Number));
    const pairs = Object.entries(params).filter(([, v]) => typeof v === "string" && v).sort((a, b) => b[1].length - a[1].length);
    const kept = steps
      .filter((_, i) => !dropped.has(i + 1))
      .map((e) => {
        const { tabId: _t, ...args } = e.args;
        return {
          tool: e.tool,
          args: parameterize(args, pairs),
          anchor: e.anchor ? parameterize(e.anchor, pairs) : null,
          at: e.at ? parameterize(e.at, pairs) : null
        };
      });
    if (!kept.length) return `Nothing to save: no replayable actions on tab ${tabId} since its last save or run.`;
    const wf = { name: slug(name), description, params: Object.keys(params), fixed: fixedValues(kept), steps: kept, saved: new Date().toISOString() };
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${wf.name}.json`);
    fs.writeFileSync(file, JSON.stringify(wf, null, 2));
    return (
      `Saved workflow "${wf.name}" (${kept.length} steps${wf.params.length ? `, params: ${wf.params.join(", ")}` : ""}) to ${file}.\n` +
      kept.map((s, i) => describe(s, i + 1)).join("\n") +
      (wf.fixed.length
        ? `\nFIXED — every run repeats these exactly as recorded: ${wf.fixed.map((v) => JSON.stringify(v)).join(", ")}. If any of them should differ between runs, save again with it in params.`
        : "") +
      `\nIf a step is not part of the flow (exploration, a wrong turn), save again with drop: [step numbers] — numbering is from the full list before dropping.`
    );
  }

  // --- Replay ----------------------------------------------------------------

  // The reverse of parameterize: fill {{k}} placeholders with this run's values.
  function substitute(value, p) {
    if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in p ? String(p[k]) : m));
    if (Array.isArray(value)) return value.map((v) => substitute(v, p));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, p)]));
    return value;
  }

  async function locate(tabId, anchor) {
    const deadline = Date.now() + ANCHOR_WAIT_MS;
    let last = null;
    while (Date.now() < deadline) {
      if (anchor.kind === "point") {
        last = await js(tabId, LOCATE(anchor)).catch((e) => ({ miss: e.message }));
        if (last && !last.miss) return { coordinate: [last.x, last.y] };
      } else {
        const r = textOf(await dispatch("find", { query: anchor.name || anchor.role, tabId }));
        const hit = [...r.matchAll(/^\[(ref_\d+)\] (\S+) "(.*)" at \(/gm)].find((m) => m[2] === anchor.role && m[3] === anchor.name);
        if (hit) return { ref: hit[1] };
        last = { miss: `no ${anchor.role} named "${anchor.name}"` };
      }
      await sleep(POLL_MS);
    }
    return { miss: last?.miss === "covered" ? `covered by <${last.by}>` : last?.miss === "text" ? `found a different element ("${last.saw}")` : last?.miss === "ambiguous" ? `matched ${last.n} elements with that text` : last?.miss || "not found" };
  }

  async function run({ name, tabId, params = {}, screenshot = true }) {
    const wf = list().find((w) => w.name === slug(name));
    if (!wf) {
      const names = list().map((w) => w.name);
      return { content: [{ type: "text", text: `No saved workflow "${name}". Saved: ${names.length ? names.join(", ") : "none"}.` }] };
    }
    const missing = wf.params.filter((k) => !(k in params));
    if (missing.length) return { content: [{ type: "text", text: `Workflow "${wf.name}" needs params: ${missing.join(", ")}.` }] };
    const unknown = Object.keys(params).filter((k) => !wf.params.includes(k));
    if (unknown.length) {
      return { content: [{ type: "text", text:
        `Workflow "${wf.name}" has no param ${unknown.join(", ")}; nothing was run. Its params are: ${wf.params.join(", ") || "none"}. ` +
        `Fixed in every run: ${fixedValues(wf.steps).map((v) => JSON.stringify(v)).join(", ") || "nothing"}. ` +
        `If the task needs a different value for one of those, do the flow by hand (and re-save it with that value as a param).` }] };
    }

    const t0 = Date.now();
    const log = [];
    let stopped = null;
    for (let i = 0; i < wf.steps.length; i++) {
      const s = wf.steps[i];
      const ts = Date.now();
      const args = { ...substitute(s.args, params), tabId };
      let tLoc = 0, tAct = 0;
      // Wait until the page is where it was when this step was recorded. This is
      // what keeps a step with no element to wait for (a navigate, typing) from
      // running before the previous step's consequence has arrived.
      if (i > 0 && s.at) {
        const want = substitute(s.at, params);
        const deadline = Date.now() + ANCHOR_WAIT_MS;
        let here = null;
        while (Date.now() < deadline && (here = await js(tabId, HERE).catch(() => null)) !== want) await sleep(POLL_MS);
        if (here !== want) {
          stopped = `step ${i + 1} (${describe(s, i + 1).replace(/^\d+\. /, "")}): the page is at ${JSON.stringify(here)}, but the recorded flow was at ${JSON.stringify(want)} here`;
          break;
        }
      }
      if (s.anchor) {
        const where = await locate(tabId, substitute(s.anchor, params));
        tLoc = Date.now() - ts;
        if (where.miss) {
          stopped = `step ${i + 1} (${describe(s, i + 1).replace(/^\d+\. /, "")}): element ${where.miss}`;
          break;
        }
        delete args.coordinate;
        delete args.ref;
        Object.assign(args, where);
      }
      const r = await dispatch(s.tool, args);
      tAct = Date.now() - ts - tLoc;
      const text = textOf(r);
      if (FAILED.test(text)) {
        stopped = `step ${i + 1} (${describe(s, i + 1).replace(/^\d+\. /, "")}): ${text.split("\n")[0].slice(0, 200)}`;
        break;
      }
      log.push(i + 1);
      // Let a click's consequences land before the next step is matched.
      if (s.tool === "computer" || s.tool === "form_input") await settle(tabId, SETTLE_QUIET_MS, SETTLE_MAX_MS);
      if (process.env.OCIC_WORKFLOWS_DEBUG) process.stderr.write(`[workflow] step ${i + 1} ${describe(s, i + 1)} ${Date.now() - ts}ms (locate ${tLoc}, act ${tAct}, settle ${Date.now() - ts - tLoc - tAct})\n`);
    }
    if (!stopped) await settle(tabId, FINAL_QUIET_MS, FINAL_MAX_MS);
    marks.set(tabId, journal.length);
    const head = stopped
      ? `Workflow "${wf.name}" STOPPED at ${stopped}. Steps 1-${log.length} of ${wf.steps.length} ran; nothing after that was attempted. Look at the page and finish by hand.`
      : `Workflow "${wf.name}" ran all ${wf.steps.length} steps in ${Date.now() - t0}ms.`;
    const content = [{ type: "text", text: head }];
    if (screenshot) {
      const shot = await dispatch("computer", { action: "screenshot", tabId });
      content.push(...(shot.content || []).filter((c) => c.type === "image"));
    }
    return { content };
  }

  return { before, after, save, run, listing: savedWorkflowsNote };
}
