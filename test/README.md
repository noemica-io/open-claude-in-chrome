# Tests

Plain Node, no framework, no dependencies. Run them all:

```bash
for t in test/*.test.mjs; do node "$t" || break; done
```

| File | Covers |
|---|---|
| `humanize-planners.test.mjs` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), a wheel plan turns exactly the requested number of notches at one point, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.mjs` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), per-tab cursor continuity, and that a wheel plan becomes one `mouseWheel` per notch without moving the cursor. This is the layer that caught the missing shifted-digit key mappings. |
| `wheel-into-view.test.mjs` | Bringing an off-screen ref into view with humanize on: runs the shipped `wheelRefIntoView` / `settleRef` / `dispatchPlan` against a simulated page and asserts it converges in a few rounds, measures the real notch size, never wheels past the planned clearance, and gives up cleanly (page not scrolling, too far, no clear point). Then runs the shipped `computer` handler to check it falls back to the instant scroll whenever wheeling fails, and that `scroll_to` by ref no longer feeds the element's viewport position to `window.scrollTo`. |
| `handlers.test.mjs` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.
