# Tests

Plain Node, no framework, no dependencies. Run them all:

```bash
for t in test/*.test.mjs; do node "$t" || break; done
```

| File | Covers |
|---|---|
| `humanize-planners.test.mjs` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), scroll deltas sum to exactly the requested amount, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.mjs` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), and per-tab cursor continuity. This is the layer that caught the missing shifted-digit key mappings. |
| `handlers.test.mjs` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |
| `screenshot-clip.test.mjs` | The shipped `takeScreenshot`, with its page expression run against a fake window: the capture clip starts at the viewport's page offset, not 0,0. The clip's x/y are page coordinates, so a 0,0 clip on a page scrolled by S drew the image S px too low (blank past one viewport) and flashed the window on every scroll. Also covers the 1/dpr scale, pinch-zoom offsets, and the unclipped fallback. |

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.
