// Content script for Open Claude in Chrome extension.
// Injected into every page. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes

(function () {
  if (window.__unblockedChromeLoaded) return;
  window.__unblockedChromeLoaded = true;

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el) {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const typeRoles = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  function getAccessibleName(el) {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // typeof guards: a <form> (or <fieldset>) exposes its named controls as
    // properties via a [LegacyOverrideBuiltIns] named getter, so an
    // <input name="title"> makes form.title the ELEMENT, not the string —
    // and .trim() on it throws, taking down read_page/find for the whole
    // page. Same shadowing applies to placeholder and alt.
    if (typeof el.placeholder === "string" && el.placeholder) return el.placeholder.trim();
    if (typeof el.title === "string" && el.title) return el.title.trim();
    if (typeof el.alt === "string" && el.alt) return el.alt.trim();

    // Associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    if (el.closest("label")) {
      const labelText = el.closest("label").textContent.trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements)
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag)) {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    if (el.getAttribute("role") && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem", "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(el.getAttribute("role"))) return true;
    if (el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body" && getComputedStyle(el).position !== "fixed") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // --- Accessibility tree generation ---
  function generateAccessibilityTree(options = {}) {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const maxChars = options.max_chars || 50000;
    const startRefId = options.ref_id || null;

    let output = "";
    let charCount = 0;
    let truncated = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    function walk(el, depth, indent) {
      if (truncated) return;
      if (depth > maxDepth) return;
      if (!el || el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (shouldShow && visible) {
        const ref = getOrAssignRef(el);
        let line = `${indent}`;

        if (role) line += `${role}`;
        if (name) line += ` "${name.substring(0, 100)}"`;
        line += ` [${ref}]`;

        // Extra info for specific elements
        if (tag === "a" && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && el.value) line += ` value="${el.value.substring(0, 100)}"`;
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        if (el.disabled) line += " disabled";

        // Select options
        if (tag === "select") {
          const opts = Array.from(el.options).map(
            (o) => `${o.selected ? "*" : " "}${o.value}="${o.textContent.trim()}"`
          );
          if (opts.length) line += ` options=[${opts.join(", ")}]`;
        }

        if (!append(line + "\n")) return;
      }

      // Recurse children (including shadow DOM)
      const nextIndent = shouldShow && visible ? indent + "  " : indent;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, depth + 1, nextIndent);
        }
      }
      for (const child of el.children) {
        walk(child, depth + 1, nextIndent);
      }
    }

    let root = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
    }

    walk(root, 0, "");
    return output;
  }

  // --- Page text extraction ---
  function getPageText() {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    let source = null;
    for (const sel of selectors) {
      source = document.querySelector(sel);
      if (source) break;
    }
    if (!source) source = document.body;

    const title = document.title || "";
    const url = location.href;
    const tag = source.tagName.toLowerCase();

    // Clean text: remove script/style content, collapse whitespace
    const clone = source.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
    const text = clone.textContent.replace(/\s+/g, " ").trim();

    return JSON.stringify({ title, url, sourceTag: tag, text: text.substring(0, 100000) });
  }

  // --- Element finding ---
  function findElements(query) {
    const q = query.toLowerCase();
    const results = [];

    // Collect all elements including those inside shadow roots
    function collectAll(root) {
      const elements = [];
      for (const el of root.querySelectorAll("*")) {
        elements.push(el);
        if (el.shadowRoot) {
          elements.push(...collectAll(el.shadowRoot));
        }
      }
      return elements;
    }

    const all = collectAll(document);

    for (const el of all) {
      if (results.length >= 20) break;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) continue;

      const role = getRole(el) || "";
      const name = getAccessibleName(el) || "";
      const text = el.textContent?.trim()?.substring(0, 200) || "";
      // Coerce to "" unless it's really a string: a form control named
      // title/placeholder/type shadows the built-in property with an ELEMENT,
      // which would stringify to "[object HTMLInputElement]" and silently
      // pollute matching (see the typeof guards in getAccessibleName).
      const placeholder = typeof el.placeholder === "string" ? el.placeholder : "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const title = typeof el.title === "string" ? el.title : "";
      const type = typeof el.type === "string" ? el.type : "";

      const searchable = `${role} ${name} ${text} ${placeholder} ${ariaLabel} ${title} ${type} ${tag}`.toLowerCase();

      if (searchable.includes(q)) {
        const ref = getOrAssignRef(el);
        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        results.push({
          ref,
          role: role || tag,
          name: name || text.substring(0, 80),
          coordinates: [cx, cy],
          // A match can be scrolled out of view — inside a horizontally
          // overflowing strip, below the fold, anywhere. Its coordinates are
          // still returned (they are correct, just not currently reachable),
          // but clicking them would land on the document root instead of the
          // element. Flag it here so the caller scrolls first rather than
          // discovering the miss afterwards.
          offViewport:
            cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight,
        });
      }
    }
    return results;
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el) {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = (target.type || "").toLowerCase();

    if (tag === "select") {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || o.textContent.trim() === String(value)
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- What is actually at a point ---
  // A dispatched click lands on whatever occupies its coordinates, which is not
  // necessarily what the caller aimed at: the target may have scrolled out of
  // view, or something transparent may be sitting on top of it. The dispatch
  // succeeds either way, so without this a hit and a miss are indistinguishable
  // from the tool result. Runs in the isolated world, so it can also report the
  // ref of the element it found — the same ref space read_page/find hand out.
  function describePoint(x, y) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const outside = x < 0 || y < 0 || x >= vw || y >= vh;
    const el = outside ? null : document.elementFromPoint(x, y);
    if (!el) return { hit: null, outside, viewport: [vw, vh] };

    // Shadow DOM: elementFromPoint stops at the host, so walk into the shadow
    // tree to name the node that will really receive the event.
    let node = el;
    for (let depth = 0; depth < 4 && node.shadowRoot; depth++) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }

    const tag = node.tagName.toLowerCase();
    const attrs = {};
    for (const a of ["id", "name", "type", "role", "data-testid", "data-test", "aria-label"]) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v) attrs[a] = v.length > 40 ? v.slice(0, 40) + "…" : v;
    }
    const cls =
      typeof node.className === "string" && node.className.trim()
        ? node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    const text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Only report a ref the element already has; assigning a new one here would
    // grow the ref map on every click.
    const existing = reverseMap.get(node);
    const ref = existing && elementMap[existing]?.deref() === node ? existing : null;
    // Whether a click here can be a no-op a caller can't tell apart from a hit.
    // Flag it only when the point is on/inside a <label> whose associated
    // control is missing OR not natively activatable, AND no live interactive
    // element is present to receive the bubbled click. A click on a label with
    // a working control, or on a label under a real interactive ancestor, still
    // reaches a target and must not read as dead.
    //
    // The effective disabled state is deliberate: ctrl.disabled is the control's
    // own attribute, so it misses a control disabled by being inside a
    // <fieldset disabled>, while ctrl.matches(":disabled") reflects the real,
    // inheritable state. Testing :disabled (not :enabled) also matters because
    // :enabled only matches button/input/select/textarea/option — it would
    // wrongly mark non-disabled labelable elements like <meter>/<output>/
    // <progress> as non-activatable and flag a healthy label as dead.
    //
    // The hit must be resolved through the DOM, not just the direct
    // elementFromPoint result: labels usually wrap a <span>/<svg> child, so the
    // point often lands on the child, not the <label> itself.
    //
    // The ancestor selector matches only LIVE interactive elements: enabled form
    // controls, acted-on anchors, and interactive ARIA roles. Bare [role] would
    // match presentational/landmark roles like banner or presentation; bare
    // input/button would count a DISABLED control as "still gets the click".
    const labelEl = node.closest ? node.closest("label") : null;
    const ctrl = labelEl && labelEl.control;
    const noNativeActivation = !ctrl || ctrl.matches(":disabled");
    // [onclick]/[tabindex] must also exclude disabled controls: a disabled
    // control that happens to carry one still never receives the click.
    // ARIA roles are ASCII case-insensitive, so use the `i` flag. contenteditable
    // and media controls are natively interactive targets of their own.
    const interactiveAncestor = node.closest(
      "a[href],a[onclick]," +
      "button:enabled,input:enabled,textarea:enabled,select:enabled," +
      "summary," +
      "[onclick]:not(:disabled),[tabindex]:not(:disabled)," +
      "[contenteditable]:not([contenteditable=\"false\"]),audio[controls],video[controls]," +
      "[role=button i],[role=combobox i],[role=link i],[role=menuitem i],[role=menuitemradio i]," +
      "[role=menuitemcheckbox i],[role=option i],[role=radio i],[role=checkbox i],[role=tab i]," +
      "[role=switch i],[role=textbox i],[role=spinbutton i],[role=slider i],[role=listbox i]," +
      "[role=treeitem i]"
    );
    const deadLabel = !!labelEl && noNativeActivation && !interactiveAncestor;
    return {
      hit: { tag, attrs, cls, text, ref },
      // <html>/<body> means the point is over page background — nothing
      // interactive there, which is almost always a miss worth flagging.
      bare: tag === "html" || tag === "body",
      deadLabel,
      viewport: [vw, vh]
    };
  }

  // --- Get element coordinates for ref ---
  function getRefCoordinates(refId, opts = {}) {
    const el = resolveRef(refId);
    if (!el) return null;

    // Bring the element into view before reading its position.
    //
    // Coordinates are viewport-relative, so an element scrolled out of view has
    // coordinates that cannot be clicked at all: the dispatch lands on the
    // document root instead. That is not a reporting problem, it is a targeting
    // one — the caller named an element, and the element is reachable, it just
    // is not on screen yet. Scrolling first is what a person does, and what
    // Playwright/Puppeteer do before every click, so the click lands on what
    // was actually asked for.
    //
    // block/inline "center" (rather than the default "start") keeps the element
    // clear of sticky headers and footers, which are a common way for a
    // technically-in-viewport element to still be covered.
    let scrolledFrom = null;
    if (opts.scrollIntoView !== false) {
      const r = el.getBoundingClientRect();
      const off =
        r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight;
      if (off) {
        // Remember where it was, so the caller can record that a scroll
        // happened. A move this large silently changing the coordinates is
        // exactly the kind of thing a debug log has to show.
        scrolledFrom = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
        try {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        } catch {
          el.scrollIntoView(true);
        }
      }
    }

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    // Report what is actually at the resulting point, so the caller learns when
    // something else (an overlay, a sticky bar) will receive the click. That
    // case is NOT auto-corrected: a person clicking there would hit the overlay
    // too, so silently clicking through it would be the unfaithful choice.
    let covering = null;
    if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
      const at = document.elementFromPoint(x, y);
      if (at && at !== el && !el.contains(at) && !at.contains(el)) {
        covering = describeBrief(at);
      }
    }
    return {
      x,
      y,
      reachable: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      covering,
      scrolledFrom,
    };
  }

  function describeBrief(el) {
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/)[0]
        : "";
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${t ? ` "${t}"` : ""}`;
  }

  // --- Wheeling a ref into view (humanize) ---
  //
  // With humanize on, an off-screen ref is brought into view with the wheel
  // rather than scrollIntoView's instant jump. The background page runs that
  // in rounds and asks this one question each round: which scroller has to
  // move, which way, by how many notches, and where can the cursor rest so
  // the wheel actually reaches that scroller for the whole distance. Nothing
  // here moves anything.
  //
  // "Reaches for the whole distance" is the part that matters. A wheel event
  // goes to whatever is under the cursor when it fires, and the page is
  // moving under a parked cursor, so a nested scroller that slides into place
  // mid-flick takes the rest of the flick — the failure that sank the first
  // attempt at humanized scrolling. So each candidate point is hit-tested
  // now, and checked for every scrollable box that will pass under it, and a
  // round never wheels further than that clearance.

  function composedParent(n) {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode && n.getRootNode();
    return root && root.host ? root.host : null;
  }

  // Scrolls vertically in its own right. The root is handled as the viewport,
  // and <body>'s overflow belongs to the viewport unless <html> sets its own.
  function isScrollerY(n, cs) {
    if (n === document.documentElement) return false;
    cs = cs || getComputedStyle(n);
    if (!/^(auto|scroll|overlay)$/.test(cs.overflowY)) return false;
    if (n === document.body && getComputedStyle(document.documentElement).overflowY === "visible") return false;
    return n.scrollHeight > n.clientHeight + 1;
  }

  function rootScrollable() {
    const html = getComputedStyle(document.documentElement).overflowY;
    if (/^(hidden|clip)$/.test(html)) return false;
    if (html === "visible" && document.body && /^(hidden|clip)$/.test(getComputedStyle(document.body).overflowY)) return false;
    const se = document.scrollingElement || document.documentElement;
    return se.scrollHeight > se.clientHeight + 1;
  }

  function roomToScroll(sc, dir) {
    const n = sc.root ? document.scrollingElement || document.documentElement : sc.node;
    const max = n.scrollHeight - n.clientHeight;
    return Math.max(0, dir > 0 ? max - n.scrollTop : n.scrollTop);
  }

  // A box takes a wheel event for itself (instead of passing it to its
  // scroller) when it can still move that way, or when overscroll-behavior
  // stops it handing the leftover on.
  function eatsWheel(n, dir, cs) {
    cs = cs || getComputedStyle(n);
    if (/^(contain|none)$/.test(cs.overscrollBehaviorY)) return true;
    const max = n.scrollHeight - n.clientHeight;
    return dir > 0 ? n.scrollTop < max - 1 : n.scrollTop > 1;
  }

  // A frame we cannot look into might scroll; one we can, only if it does.
  function frameMayScroll(f) {
    try {
      const se = f.contentDocument && f.contentDocument.scrollingElement;
      if (!se) return true;
      return se.scrollHeight > se.clientHeight + 1;
    } catch {
      return true;
    }
  }

  // Innermost first, ending with the viewport. A fixed-position ancestor
  // takes the element out of the root's reach, so the chain stops there.
  function scrollChain(el) {
    const chain = [];
    for (let n = composedParent(el); n && n !== document.documentElement; n = composedParent(n)) {
      const cs = getComputedStyle(n);
      if (isScrollerY(n, cs)) chain.push({ node: n });
      if (cs.position === "fixed") return chain;
    }
    if (getComputedStyle(el).position !== "fixed" && rootScrollable()) chain.push({ root: true });
    return chain;
  }

  function windowOf(sc) {
    if (sc.root) return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const r = sc.node.getBoundingClientRect();
    const top = r.top + sc.node.clientTop;
    const left = r.left + sc.node.clientLeft;
    return { top, bottom: top + sc.node.clientHeight, left, right: left + sc.node.clientWidth };
  }

  // The part of chain[i]'s window actually on screen: clipped by every
  // scroller outside it and by the viewport.
  function visibleWindow(chain, i) {
    const w = { ...windowOf(chain[i]) };
    const clips = chain.slice(i + 1).map(windowOf);
    clips.push({ top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth });
    for (const c of clips) {
      w.top = Math.max(w.top, c.top);
      w.bottom = Math.min(w.bottom, c.bottom);
      w.left = Math.max(w.left, c.left);
      w.right = Math.min(w.right, c.right);
    }
    return w.bottom > w.top && w.right > w.left ? w : null;
  }

  // Comfortably inside: a box that fits sits fully within the window, clear
  // of the edges (where sticky bars live); one taller than that only needs
  // its centre inside, since that is where a ref is clicked.
  function comfortable(sub, win) {
    const h = win.bottom - win.top;
    const m = Math.min(40, h * 0.1);
    if (sub.bottom - sub.top <= h - 2 * m) return sub.top >= win.top + m && sub.bottom <= win.bottom - m;
    const c = (sub.top + sub.bottom) / 2;
    return c >= win.top + m && c <= win.bottom - m;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && el.shadowRoot && i < 5; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Would a wheel event at p, right now, end up scrolling sc?
  function wheelReaches(sc, p, dir) {
    for (let n = deepElementFromPoint(p.x, p.y); n; n = composedParent(n)) {
      if (!sc.root && n === sc.node) return true;
      if (n === document.documentElement) break;
      if (n.tagName === "IFRAME" || n.tagName === "FRAME") {
        if (frameMayScroll(n)) return false;
        continue;
      }
      const cs = getComputedStyle(n);
      if (isScrollerY(n, cs) && eatsWheel(n, dir, cs)) return false;
    }
    return !!sc.root;
  }

  // Every box inside sc that would take the wheel if it passed under the
  // cursor while sc scrolls. Fixed-position ones don't move with sc, so they
  // are either under the cursor already (and wheelReaches says no) or never.
  function wheelObstacles(sc, dir) {
    const out = [];
    const stop = sc.root ? null : sc.node;
    const movesWithSc = (n) => {
      for (let a = n; a && a !== stop; a = composedParent(a)) {
        if (getComputedStyle(a).position === "fixed") return false;
      }
      return true;
    };
    const visit = (scope) => {
      for (const n of scope.querySelectorAll("*")) {
        if (n.shadowRoot) visit(n.shadowRoot);
        if (n.tagName === "IFRAME" || n.tagName === "FRAME") {
          if (frameMayScroll(n) && movesWithSc(n)) out.push(n.getBoundingClientRect());
          continue;
        }
        if (n.scrollHeight <= n.clientHeight + 1) continue;
        const cs = getComputedStyle(n);
        if (isScrollerY(n, cs) && eatsWheel(n, dir, cs) && movesWithSc(n)) out.push(n.getBoundingClientRect());
      }
    };
    visit(sc.root ? document : sc.node);
    return out;
  }

  // How far sc can scroll before one of those boxes reaches p. As sc scrolls
  // by d, the content that was at p.y + d (down) or p.y - d (up) arrives
  // under the cursor.
  function wheelClearance(obstacles, p, dir) {
    let clear = Infinity;
    for (const r of obstacles) {
      if (p.x < r.left || p.x > r.right) continue;
      if (r.top <= p.y && r.bottom >= p.y) return 0; // under the cursor already
      if (dir > 0 && r.top > p.y) clear = Math.min(clear, r.top - p.y);
      if (dir < 0 && r.bottom < p.y) clear = Math.min(clear, p.y - r.bottom);
    }
    return clear;
  }

  function pickWheelPoint(sc, vis, dir, needPx, cursor, spots) {
    const pts = [];
    if (cursor && cursor.x >= vis.left && cursor.x < vis.right && cursor.y >= vis.top && cursor.y < vis.bottom) {
      pts.push({ x: Math.round(cursor.x), y: Math.round(cursor.y) });
    }
    for (const [fx, fy] of spots) {
      pts.push({
        x: Math.round(vis.left + fx * (vis.right - vis.left)),
        y: Math.round(vis.top + fy * (vis.bottom - vis.top))
      });
    }
    const obstacles = wheelObstacles(sc, dir);
    let best = null;
    // The cursor comes first: where it already is costs no movement, so it is
    // used whenever it works, as it would be by a person.
    for (const p of pts) {
      if (!wheelReaches(sc, p, dir)) continue;
      const clear = wheelClearance(obstacles, p, dir);
      if (clear <= 0) continue;
      if (clear >= needPx) return { point: p, clear };
      if (!best || clear > best.clear) best = { point: p, clear };
    }
    return best;
  }

  function refWheelPlan(refId, opts = {}) {
    const el = resolveRef(refId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const centre = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    if (!r.width && !r.height) return { inView: false, centre, point: null, why: "element has no box" };
    const perNotch = opts.perNotch || 100;
    const aim = typeof opts.aim === "number" ? opts.aim : 0.45;
    const chain = scrollChain(el);
    // Wheel only where getRefCoordinates would otherwise have jumped (any part
    // outside the viewport), plus a centre clipped away by a nested scroller,
    // which it never handled. Anything already on screen is left exactly
    // where it is — a sticky header near the top edge must not set the page
    // scrolling just to be clicked.
    const onScreen = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    const clipped = chain.some((sc) => {
      if (sc.root) return false;
      const w = windowOf(sc);
      return centre[0] < w.left || centre[0] > w.right || centre[1] < w.top || centre[1] > w.bottom;
    });
    if (onScreen && !clipped) return { inView: true, centre };
    // The subject starts as the element. When the scroller it needs is not
    // on screen enough to put a cursor on, the subject becomes that scroller,
    // and the next one out brings it into view first.
    let sub = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    for (let i = 0; i < chain.length; i++) {
      const win = windowOf(chain[i]);
      const cx = (sub.left + sub.right) / 2;
      if (cx < win.left || cx > win.right) return { inView: false, centre, point: null, why: "off-screen horizontally" };
      if (comfortable(sub, win)) continue;
      const vis = visibleWindow(chain, i);
      if (!vis || vis.bottom - vis.top < Math.min((win.bottom - win.top) * 0.5, 120) || vis.right - vis.left < 40) {
        sub = win;
        continue;
      }
      const want = (sub.top + sub.bottom) / 2 - (vis.top + aim * (vis.bottom - vis.top));
      const dir = want > 0 ? 1 : -1;
      const needPx = Math.min(Math.abs(want), roomToScroll(chain[i], dir));
      const needed = Math.round(needPx / perNotch);
      if (needed < 1) {
        // As close as whole notches get it. Fine if it can be clicked.
        const c = (sub.top + sub.bottom) / 2;
        if (c >= win.top && c <= win.bottom) continue;
        return { inView: false, centre, point: null, why: "cannot scroll any further toward it" };
      }
      const pick = pickWheelPoint(chain[i], vis, dir, needed * perNotch, opts.cursor, opts.spots || []);
      if (!pick) return { inView: false, centre, point: null, why: "no point over the scroller reaches it" };
      return {
        inView: false,
        centre,
        dir,
        needed,
        notches: Math.max(1, Math.min(needed, Math.floor(pick.clear / perNotch))),
        point: pick.point,
        scroller: chain[i].root ? "page" : describeBrief(chain[i].node)
      };
    }
    // Every scroller is content. The viewport has the final say, for an
    // element under a fixed ancestor whose chain never reached it.
    const inView = centre[0] >= 0 && centre[1] >= 0 && centre[0] < window.innerWidth && centre[1] < window.innerHeight;
    return inView ? { inView, centre } : { inView, centre, point: null, why: "nothing that scrolls would bring it into view" };
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "describePoint") {
      sendResponse({ result: describePoint(msg.x, msg.y) });
      return true;
    }

    if (msg.type === "getRefCoordinates") {
      const result = getRefCoordinates(msg.ref, { scrollIntoView: msg.scrollIntoView });
      sendResponse({ result });
      return true;
    }

    if (msg.type === "refWheelPlan") {
      sendResponse({ result: refWheelPlan(msg.ref, msg) });
      return true;
    }

    // Resolve a ref in THIS (isolated) world — where resolveRef/elementMap live —
    // and stamp a DOM attribute on the element so the background page can find it
    // via CDP. CDP Runtime.evaluate runs in the page's MAIN world and cannot see
    // window.__unblockedChrome, so a main-world resolveRef always returns null;
    // the DOM is shared across worlds, so an attribute set here IS visible to CDP.
    // Used by file_upload / upload_image to reach a (possibly hidden) file input.
    if (msg.type === "markElementForUpload") {
      const el = resolveRef(msg.ref);
      if (!el) {
        sendResponse({ ok: false });
        return true;
      }
      const isFileInput =
        el.tagName &&
        el.tagName.toLowerCase() === "input" &&
        (el.type || "").toLowerCase() === "file";
      try { el.setAttribute("data-ocic-upload-target", "1"); } catch {}
      try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
      sendResponse({ ok: true, isFileInput, tag: el.tagName.toLowerCase() });
      return true;
    }

    if (msg.type === "unmarkElementForUpload") {
      try {
        document
          .querySelectorAll("[data-ocic-upload-target]")
          .forEach((e) => e.removeAttribute("data-ocic-upload-target"));
      } catch {}
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // Expose globally for executeScript fallback
  window.__unblockedChrome = {
    describePoint,
    generateAccessibilityTree,
    getPageText,
    findElements,
    setFormValue,
    getRefCoordinates,
    refWheelPlan,
    resolveRef,
    elementMap,
  };
})();
