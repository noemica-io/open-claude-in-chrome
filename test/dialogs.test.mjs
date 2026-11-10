// Native JavaScript dialogs (alert/confirm/prompt/beforeunload). While one is open
// the page's renderer is blocked and nearly every CDP command hangs, which used to
// surface as an opaque timeout. These tests run the SHIPPED helpers and the
// handle_dialog handler from extension/background.js against a mocked CDP layer.
import fs from "node:fs";
import { extractFunction, extractMethod, BACKGROUND } from "./_extract.mjs";
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const pendingDialogs = new Map();
const dialogWaiters = new Map();

const helpers = new Function(
  "pendingDialogs", "dialogWaiters",
  ["dialogError", "noteDialogOpened", "noteDialogClosed", "failIfDialogOpen", "raceDialog"]
    .map((n) => extractFunction(n)).join("\n\n") +
  "; return { dialogError, noteDialogOpened, noteDialogClosed, failIfDialogOpen, raceDialog };"
)(pendingDialogs, dialogWaiters);
const { noteDialogOpened, noteDialogClosed, failIfDialogOpen, raceDialog } = helpers;

const reset = () => { pendingDialogs.clear(); dialogWaiters.clear(); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

console.log("== tracking: opening records the dialog, closing clears it ==");
reset();
noteDialogOpened(7, { type: "alert", message: "Internal Error Occurred", url: "https://example.test/" });
ok(pendingDialogs.get(7)?.type === "alert", "opening records the type");
ok(pendingDialogs.get(7)?.message === "Internal Error Occurred", "opening records the message");
ok(!pendingDialogs.has(8), "other tabs are unaffected");
noteDialogClosed(7);
ok(!pendingDialogs.has(7), "closing clears it");
noteDialogClosed(7);
ok(!pendingDialogs.has(7), "closing an already-closed dialog is a no-op");

console.log("== fail fast: commands that would hang behind a dialog are refused with its text ==");
reset();
ok(throws(() => failIfDialogOpen(7, "Runtime.evaluate")) === null, "no dialog: commands go through");
noteDialogOpened(7, { type: "confirm", message: "Discard changes?" });
const e1 = throws(() => failIfDialogOpen(7, "Input.dispatchMouseEvent"));
ok(e1 !== null, "dialog open: a click is refused");
ok(e1 && /confirm dialog is open on tab 7/.test(e1.message), "error names the dialog type and tab");
ok(e1 && e1.message.includes("Discard changes?"), "error includes the dialog's text");
ok(e1 && /handle_dialog/.test(e1.message), "error points the agent at handle_dialog");
ok(throws(() => failIfDialogOpen(7, "Page.handleJavaScriptDialog")) === null, "answering the dialog is still allowed");
ok(throws(() => failIfDialogOpen(8, "Runtime.evaluate")) === null, "a different tab is not blocked");
noteDialogOpened(9, { type: "alert", message: "x".repeat(2000) });
ok(throws(() => failIfDialogOpen(9, "Runtime.evaluate")).message.length < 900, "a huge message is truncated in the error");

console.log("== raceDialog: an in-flight command is aborted the moment a dialog opens ==");
reset();
let resolveCmd;
const slow = new Promise((r) => { resolveCmd = r; });
const raced = raceDialog(7, slow);
ok(dialogWaiters.get(7)?.size === 1, "a waiter is registered while the command is in flight");
noteDialogOpened(7, { type: "alert", message: "boom" });
const e2 = await rejects(raced);
ok(e2 && e2.message.includes("boom"), "the in-flight command rejects with the dialog description");
ok(!dialogWaiters.has(7), "the waiter is removed afterwards");

reset();
const fast = await raceDialog(7, Promise.resolve("done"));
ok(fast === "done", "with no dialog the command's own result passes through");
ok(!dialogWaiters.has(7), "no waiter is left behind after a normal completion");

reset();
const failing = await rejects(raceDialog(7, Promise.reject(new Error("CDP x timed out"))));
ok(failing && failing.message === "CDP x timed out", "a command's own error is not masked");
ok(!dialogWaiters.has(7), "no waiter is left behind after a failure");

reset();
const a = raceDialog(7, new Promise(() => {}));
const b = raceDialog(7, new Promise(() => {}));
noteDialogOpened(7, { type: "alert", message: "both" });
const [ea, eb] = await Promise.all([rejects(a), rejects(b)]);
ok(ea && eb, "every in-flight command on the tab is aborted");
ok(!dialogWaiters.has(7), "all waiters are cleaned up");

console.log("== handle_dialog handler ==");
const calls = [];
const inGroup = new Set([7, 8]);
const H = new Function(
  "isInGroup", "pendingDialogs", "cdp", "noteDialogClosed",
  `const H = { ${extractMethod("handle_dialog")} }; return H;`
)(async (id) => inGroup.has(id), pendingDialogs, async (tabId, method, params) => { calls.push({ tabId, method, params }); return {}; }, noteDialogClosed);
const text = (r) => r.content[0].text;

reset(); calls.length = 0;
let r = await H.handle_dialog({ tabId: 99, action: "accept" });
ok(/not in the MCP group/.test(text(r)) && calls.length === 0, "a tab outside the group is refused without touching CDP");

r = await H.handle_dialog({ tabId: 7, action: "accept" });
ok(/No JavaScript dialog is open on tab 7/.test(text(r)) && calls.length === 0, "no dialog: says so and sends nothing");

noteDialogOpened(7, { type: "alert", message: "Internal Error" });
r = await H.handle_dialog({ tabId: 7, action: "maybe" });
ok(/Invalid action/.test(text(r)) && calls.length === 0 && pendingDialogs.has(7), "an invalid action is rejected and leaves the dialog open");

r = await H.handle_dialog({ tabId: 7, action: "accept" });
ok(calls.length === 1 && calls[0].method === "Page.handleJavaScriptDialog", "accept calls Page.handleJavaScriptDialog");
ok(calls[0].params.accept === true && !("promptText" in calls[0].params), "accept without text sends accept:true only");
ok(/Accepted the alert dialog/.test(text(r)) && text(r).includes("Internal Error"), "reply says what was accepted");
ok(!pendingDialogs.has(7), "the dialog is cleared after it is answered");

calls.length = 0;
noteDialogOpened(7, { type: "confirm", message: "Sure?" });
r = await H.handle_dialog({ tabId: 7, action: "dismiss", promptText: "ignored" });
ok(calls[0].params.accept === false && !("promptText" in calls[0].params), "dismiss sends accept:false and never promptText");
ok(/Dismissed the confirm dialog/.test(text(r)), "reply says what was dismissed");

calls.length = 0;
noteDialogOpened(8, { type: "prompt", message: "Name?", defaultPrompt: "" });
await H.handle_dialog({ tabId: 8, action: "accept", promptText: "Ada" });
ok(calls[0].params.accept === true && calls[0].params.promptText === "Ada", "accepting a prompt passes the text through");

console.log("== wiring: the real send paths consult the dialog state ==");
// extractFunction brace-matches from the first "{", which for functions with a
// `= {}` default parameter is the default, not the body. These two have one, so
// slice from the declaration to the closing brace at column 0 instead.
const wholeFunction = (name) => {
  const src = fs.readFileSync(BACKGROUND, "utf8");
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  return src.slice(start, src.indexOf("\n}\n", start));
};
const cdpSrc = wholeFunction("cdp");
ok(/failIfDialogOpen\(/.test(cdpSrc) && /raceDialog\(/.test(cdpSrc), "cdp() refuses/aborts on dialogs");
const mouseSrc = wholeFunction("sendMouseEvent");
ok(/failIfDialogOpen\(/.test(mouseSrc) && /raceDialog\(/.test(mouseSrc), "sendMouseEvent() refuses/aborts on dialogs");
const ensureSrc = extractFunction("ensureAttached");
ok(/Page\.enable/.test(ensureSrc), "attach enables the Page domain (required to receive dialog events)");
ok(/withTimeout\(chrome\.debugger\.sendCommand\(\{ tabId \}, "Page\.enable"/.test(ensureSrc), "Page.enable is bounded so a pre-existing dialog cannot hang attach");

console.log("== tool definition ==");
let TOOLS = null;
try { ({ TOOLS } = await import("../host/tool-definitions.js")); } catch { /* host deps not installed */ }
if (!TOOLS) {
  console.log("  SKIP host deps not installed (run `npm install --prefix host`)");
} else {
  const def = TOOLS.find((t) => t.name === "handle_dialog");
  ok(!!def, "handle_dialog is registered");
  const shape = def && def.paramShape;
  ok(shape && shape.tabId && shape.action && shape.promptText, "declares tabId, action and promptText");
  ok(shape && shape.action.safeParse("accept").success && shape.action.safeParse("dismiss").success, "action accepts accept/dismiss");
  ok(shape && !shape.action.safeParse("ignore").success, "action rejects anything else");
  ok(shape && shape.promptText.safeParse(undefined).success && !shape.tabId.safeParse(undefined).success, "promptText is optional; tabId is required");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
