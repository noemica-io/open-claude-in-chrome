// Pull a named function or object-method body out of a source file by
// brace-matching, so tests exercise the SHIPPED code in extension/background.js
// rather than a copy that can drift out of sync with it.
//
// background.js is a service-worker script, not a module: it has no exports and
// its top level touches chrome.* immediately. Extracting the pieces under test
// and injecting their dependencies is what makes it testable in plain Node.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKGROUND = path.join(ROOT, "extension", "background.js");

function matchBraces(src, from) {
  let depth = 0;
  let i = src.indexOf("{", from);
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  throw new Error("unbalanced braces from index " + from);
}

/** Top-level `function foo(...) {...}` (keeps a leading `async`). */
export function extractFunction(name, file = BACKGROUND) {
  const src = fs.readFileSync(file, "utf8");
  let i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`function ${name} not found in ${file}`);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  return src.slice(i, matchBraces(src, i));
}

/** Object method `async foo(args) {...}`, returned wrapped as `{ foo(){} }`. */
export function extractMethod(name, file = BACKGROUND) {
  const src = fs.readFileSync(file, "utf8");
  const i = src.indexOf(`  async ${name}(args)`);
  if (i === -1) throw new Error(`method ${name} not found in ${file}`);
  return src.slice(i, matchBraces(src, i)).trim();
}

/** Any braced statement starting at `head`, e.g. `if (msg.type === "x")`. */
export function extractBlock(head, file = BACKGROUND) {
  const src = fs.readFileSync(file, "utf8");
  const i = src.indexOf(head);
  if (i === -1) throw new Error(`${head} not found in ${file}`);
  return src.slice(i, matchBraces(src, i));
}

/** Build a callable from extracted source with dependencies injected. */
export function compile(source, deps, returnExpr) {
  const names = Object.keys(deps);
  const fn = new Function(...names, `${source}\nreturn ${returnExpr};`);
  return fn(...names.map((n) => deps[n]));
}
