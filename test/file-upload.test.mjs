// file_upload against the SHIPPED handler (background.js) and the SHIPPED
// mark/unmark message handlers (content.js), over a fake page and a mock CDP.
//
// The two halves meet through a DOM attribute: content.js stamps the ref's
// element, background.js finds it with DOM.querySelector — the FIRST marked
// element in document order. A mark left behind is therefore picked ahead of
// the right one, and the upload fails with "Node is not a file input element".
import path from "node:path";
import { ROOT, extractMethod, extractBlock, compile } from "./_extract.mjs";
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS ":"  FAIL ")+m); if(!c)fail++;};

const MARK = "data-ocic-upload-target";
class El {
  constructor(tag, type) { this.tagName = tag.toUpperCase(); this.type = type; this.attrs = new Map(); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  scrollIntoView() {}
}
// A dropzone button with its hidden file input after it, as on claude.ai's
// "Upload a skill" form, where this was found.
const button = new El("button", "button");
const input = new El("input", "file");
const page = [button, input];
const refs = { ref_btn: button, ref_input: input };
const document = {
  querySelectorAll(sel) {
    if (sel !== `[${MARK}]`) throw new Error("unexpected selector " + sel);
    return page.filter((e) => e.hasAttribute(MARK));
  }
};
const marks = () => document.querySelectorAll(`[${MARK}]`).length;

// content.js side: the two shipped `if (msg.type === ...)` blocks, as a listener.
const CONTENT = path.join(ROOT, "extension", "content.js");
const onMessage = compile(
  `function onMessage(msg, sendResponse) {
    ${extractBlock('if (msg.type === "markElementForUpload")', CONTENT)}
    ${extractBlock('if (msg.type === "unmarkElementForUpload")', CONTENT)}
    return false;
  }`,
  { resolveRef: (ref) => refs[ref] || null, document },
  "onMessage"
);
const sendContentMessage = (tabId, msg) =>
  new Promise((resolve) => { if (!onMessage(msg, resolve)) resolve(undefined); });

// CDP: nodeIds are page index + 2 (1 is the document), 0 means no match.
const attached = [];
const cdp = async (tabId, method, params) => {
  if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
  if (method === "DOM.querySelector") {
    const el = document.querySelectorAll(params.selector)[0];
    return { nodeId: el ? page.indexOf(el) + 2 : 0 };
  }
  if (method === "DOM.setFileInputFiles") {
    const el = page[params.nodeId - 2];
    if (!(el.tagName === "INPUT" && el.type === "file")) throw new Error("Node is not a file input element");
    attached.push({ el, files: params.files });
    return {};
  }
  throw new Error("unexpected CDP " + method);
};

const H = compile(`const H = { ${extractMethod("file_upload")} };`, {
  isInGroup: async () => true, ensureAttached: async () => {}, ensureDomain: async () => {},
  sendContentMessage, cdp
}, "H");
const upload = async (ref) => {
  try { return { text: (await H.file_upload({ tabId: 1, paths: ["C:\\skill.zip"], ref })).content[0].text }; }
  catch (e) { return { error: String(e && e.message) }; }
};

console.log("== a ref that isn't a file input is refused, and leaves nothing behind ==");
const r1 = await upload("ref_btn");
ok(/is a <button>, not a file input/.test(r1.text || ""), "refused with the <button> message");
ok(marks() === 0, "no mark left on the page");

console.log("== the next upload, at the real input, attaches to it ==");
const r2 = await upload("ref_input");
ok(!r2.error, `no error (got ${r2.error || "none"})`);
ok(attached.length === 1 && attached[0].el === input && attached[0].files[0] === "C:\\skill.zip", "file set on the input");
ok(marks() === 0, "mark cleared after the upload");

console.log("== a mark from an interrupted earlier call doesn't hijack the next one ==");
button.setAttribute(MARK, "1");      // e.g. the service worker was recycled before it unmarked
const r3 = await upload("ref_input");
ok(!r3.error, `no error (got ${r3.error || "none"})`);
ok(attached.length === 2 && attached[1].el === input, "file set on the input, not the stale-marked button");
ok(marks() === 0, "no marks left");

console.log(fail===0?"\nALL FILE UPLOAD TESTS PASSED":`\n${fail} FAILED`);
process.exit(fail?1:0);
