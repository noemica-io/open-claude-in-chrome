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
      // The whole box, not just its centre, so a humanized click can land
      // somewhere inside it. A plain object: a DOMRect does not survive
      // extension messaging intact.
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      reachable: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      covering,
      scrolledFrom,
    };
  }

  // Does a point land on this ref's element itself (or something inside it)?
  // Stricter than the covering test above, which also accepts an ancestor: that
  // is right for the centre, but a sampled off-centre point that falls in the
  // gap between the lines of a wrapped link hits the paragraph, not the link.
  // The caller falls back to the centre whenever this says no.
  function refOwnsPoint(refId, x, y) {
    const el = resolveRef(refId);
    if (!el) return false;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    // Shadow DOM: elementFromPoint stops at the host, so check each level on
    // the way in — landing on the host or on anything in its tree counts.
    let node = document.elementFromPoint(x, y);
    for (let depth = 0; node && depth < 5; depth++) {
      if (node === el || el.contains(node)) return true;
      if (!node.shadowRoot) break;
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }
    return false;
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

    if (msg.type === "refOwnsPoint") {
      sendResponse({ result: refOwnsPoint(msg.ref, msg.x, msg.y) });
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
    refOwnsPoint,
    resolveRef,
    elementMap,
  };
})();
