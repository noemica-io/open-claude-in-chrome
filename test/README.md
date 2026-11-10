# Tests

Plain Node, no framework, no dependencies. Run them all:

```bash
for t in test/*.test.mjs; do node "$t" || break; done
```

| File | Covers |
|---|---|
| `humanize-planners.test.mjs` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), scroll deltas sum to exactly the requested amount, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.mjs` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), and per-tab cursor continuity. This is the layer that caught the missing shifted-digit key mappings. |
| `dialogs.test.mjs` | Native JS dialogs (alert/confirm/prompt/beforeunload): a dialog is recorded on open and cleared on close; commands behind an open dialog fail fast with its text instead of timing out; an in-flight command is aborted the moment one opens; the `handle_dialog` handler's accept/dismiss/prompt-text behaviour; and that `cdp()`, `sendMouseEvent()` and attach are wired to all of it. |
| `handlers.test.mjs` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.
