# Tests

Plain Node, no framework, no dependencies. Run them all:

```bash
for t in test/*.test.mjs; do node "$t" || break; done
```

| File | Covers |
|---|---|
| `humanize-planners.test.mjs` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), scroll deltas sum to exactly the requested amount, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.mjs` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), and per-tab cursor continuity. This is the layer that caught the missing shifted-digit key mappings. |
| `ref-landing.test.mjs` | Where a humanized click or hover by `ref` lands, via the shipped `refLandingPoint`: the exact centre with humanize off; with it on, a point that varies but stays inside the element, re-tested against the ref and falling back to the centre when something else owns it or the centre is covered. Scrolls and drags keep their exact points. |
| `handlers.test.mjs` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.
