<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="Open Claude in Chrome">
</p>

<h1 align="center">Open Claude in Chrome</h1>

<p align="center">
  <em>Official Claude in Chrome gives you 58 blocked domains and two browsers.<br/>
  <strong>Open Claude in Chrome gives you the whole web.</strong></em>
  <br/>
  <sub>Clean-room reimplementation of Anthropic's browser extension. No blocklist. Any Chromium browser, or Firefox. 100% feature &amp; performance parity.</sub>
  <br/>
  <sub>by <a href="https://noemica.io">noemica</a></sub>
</p>

<p align="center">
  <a href="#tools">What's different</a> ·
  <a href="#install">Install</a> ·
  <a href="#recording">Imitation learning</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="https://youtu.be/n4-2fjOsGhw">Demo</a> ·
  <a href="https://www.noemica.io/blog/reverse-engineered-claude-in-chrome">How I built it</a>
</p>

---

On 12 tasks from the [REAL](https://github.com/agi-inc/REAL) benchmark, it is
statistically indistinguishable from the official extension in turns and time, with
less overhead per action (0.12s vs 0.31s). Details and caveats are in the
[writeup](benchmark/writeup/writeup.md).

## Install

Requires Node.js 18+, Claude Code 2.1.80+ (2.0.73+ without recording), and an OpenAI
API key if you want to record narrated demos.

```bash
npm install --prefix host
npm install --prefix host/codemode/worker   # sandbox for execute_code
```

### Chromium

1. Open `chrome://extensions`, enable Developer mode, click Load unpacked, and pick `extension/`.
2. Register the native host with the extension ID (pass several IDs for several browsers):
   ```bash
   ./install.sh <extension-id>
   ```
3. Restart the browser completely.
4. For recording: in the extension's Options, save your OpenAI key and click Enable microphone.

### Firefox

1. Install the [signed build](https://github.com/hrideshmg/open-claude-in-chrome/releases/latest/download/open-claude-in-chrome.xpi). It updates itself.
2. Run `./install.sh` (no ID needed) and restart Firefox.

Firefox has no `chrome.debugger`, so the native host drives pages over WebDriver BiDi,
which needs `--remote-debugging-port` (9222, or `OCIC_FIREFOX_PORT`). The first time
a tool needs it, Claude offers to restart Firefox with the flag via `restart_browser`.
While it's on, `navigator.webdriver` is `true` and any local process can reach the
port. Recording doesn't work on Firefox.

### Add to Claude Code

```bash
claude mcp add open-claude-in-chrome-hybrid -- node /absolute/path/to/host/codemode/server-hybrid.js
```

To receive recordings, launch with the channel enabled and keep the session open:

```bash
claude --dangerously-load-development-channels server:open-claude-in-chrome-hybrid
```

Check it works by asking Claude to open reddit.com and take a screenshot.

### Server variants

| Server | Tools |
|---|---|
| `host/codemode/server-hybrid.js` | All tools, `execute_code`, recording channel |
| `host/mcp-server.js` | The 21 standard tools |
| `host/codemode/server-codemode.js` | `execute_code`, `screenshot`, `zoom` |

`execute_code` runs JavaScript that calls every tool through `chrome.*` inside a
Cloudflare Worker sandbox, so a multi-step flow takes one call.

## Features

### Saved workflows

When Claude finishes a multi-step flow the project will probably need again, it saves
it with `workflow_save` to `.claude/ocic-workflows/`, turning the values that vary into
parameters. You can also ask it to. Later sessions replay it with `workflow_run` in one
call. Each step re-finds its element and stops at the first step it can't match.

On a 7-field form (Sonnet, Firefox, 2 to 4 sessions each):

| | Turns | Time | Cost |
|---|---|---|---|
| By hand | 29 | 44s | $0.10 |
| Saved workflow | 7 | 26s | $0.03 |

Set `OCIC_WORKFLOWS=0` to turn this off.

### Recording

Do a task once while narrating, and Claude learns it. Click the toolbar icon, wait for
`REC`, do the task while talking, then click again. When the icon shows 📋, a reference
to the recording is on your clipboard, and a connected session gets it over the channel.
Hold Alt while clicking to demonstrate a click without firing it.

Recordings live in `~/.config/open-claude-in-chrome/recordings/<id>/` and are
browsable from the Options page. See [the design doc](docs/imitation-learning-alignment.html).

### Humanized input

```js
set_config({ key: "humanize", value: true })
```

Curved cursor paths, off-centre clicks, momentum scrolling and human typing rhythm. It
changes where and when input lands, never what it does. `humanize_speed` is `fastest`,
`fast` (default), `natural` or `relaxed`.

### Session audits

```js
set_config({ key: "audit_mode", value: "audit" })
```

Records each tab Claude touches with [rrweb](https://rrweb.io) and stitches them into one
replayable timeline per Claude Code session, under Audits in Options. It captures the DOM
but not canvas, WebGL, video, or cross-origin CSS.

Settings can be scoped to a tab with `tabId`. `get_config` lists them all.

## Tools

✓ matches Claude in Chrome, ✗ diverges, blank is new.

| Tool | Purpose | |
|------|---------|:-:|
| `tabs_context_mcp` | Get tab group context | ✓ |
| `tabs_create_mcp` | Create a tab | ✓ |
| `tabs_close_mcp` | Close a tab | ✓ |
| `navigate` | Go to URL, back, forward | ✓ |
| `computer` | Mouse, keyboard, screenshot, zoom | ✓ |
| `read_page` | Accessibility tree with element refs | ✓ |
| `get_page_text` | Extract main text | ✓ |
| `find` | Find elements | ✓ |
| `form_input` | Set form values by ref | ✓ |
| `javascript_tool` | Run JS in the page | ✓ |
| `read_console_messages` | Console output | ✓ |
| `read_network_requests` | Network activity | ✓ |
| `resize_window` | Resize the window | ✓ |
| `file_upload` | Attach local files to a file input. Any absolute path is allowed | ✓ |
| `upload_image` | Attach a screenshot to a file input. No drop-at-coordinate | ✗ |
| `gif_creator` | Stub | ✗ |
| `shortcuts_list` | Stub | ✗ |
| `shortcuts_execute` | Stub | ✗ |
| `switch_browser` | Release the runtime for ~15s so another browser can take over | ✗ |
| `restart_browser` | Restart Firefox with automation enabled (asks first) | |
| `execute_code` | Sandboxed JS that drives every tool | |
| `update_plan` | Present a plan for approval | |
| `set_tab_focus` | Bring a tab to the front | |
| `get_config` / `set_config` | Read or change settings | |
| `recording_ack` | Confirm a recording event | |
| `retranscribe_recording` | Retry transcription | |
| `debug` / `debug_timings` | What the extension did, and how long it took | |
| `workflow_save` / `workflow_run` | Save and replay workflows | |

Not implemented: `browser_batch` (use `execute_code`), `list_connected_browsers`, `select_browser`.

## Architecture

```
Claude Code <-stdio-> mcp-server.js <-socket-> native-host.js <-native messaging-> extension
```

The hybrid and codemode servers wrap `mcp-server.js` and run a `wrangler dev` sidecar
for `execute_code`. The native host listens on a per-user socket (named pipe on
Windows), so several Claude Code sessions can share one browser. Override the path with
`{ "pipe": "..." }` in `~/.config/open-claude-in-chrome/config.json` or `OCIC_PIPE`.

## Development

There's no build step. After editing:

| Changed | Do |
|---|---|
| `extension/*` | Reload the extension |
| `host/mcp-server.js`, `host/codemode/*` | Run `/mcp` in Claude Code to reconnect |
| `host/native-host.js` | Restart the browser |
| `install.sh` | Re-run it and restart the browser |

Firefox releases: [docs/releasing-firefox.md](docs/releasing-firefox.md).

## Troubleshooting

- **Extension not connecting:** check `./install.sh` got the right ID, restart every
  browser window, then open a page to wake the service worker. Its logs are under
  `chrome://extensions` → Inspect views.
- **`execute_code` fails but other tools work:** the sandbox sidecar died or never
  started. Make sure `host/codemode/worker/node_modules` exists, then run `/mcp`. If
  that doesn't help, run `pkill -f "server-hybrid|server-codemode"; pkill -f wrangler`
  and reconnect.
- **Recording has no audio:** enable the microphone in Options.
- **No 📋 after recording:** the native host isn't registered. Re-run `./install.sh`.
- **No channel message:** launch Claude Code with the flag above.

## License

MIT. Built by [Sebastian Sosa](https://github.com/CakeCrusher) ([Noemica](https://noemica.io)).
