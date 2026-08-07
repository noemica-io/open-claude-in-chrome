// The 18 open-claude-in-chrome tool definitions, extracted as data so both
// the standard stdio MCP server (host/mcp-server.js) and the codemode +
// hybrid servers can register them without duplicating the schemas.
//
// Each entry is { name, description, paramShape } where paramShape is the
// object literal of zod values passed to McpServer.tool(). Wrapping it in
// z.object(paramShape) yields the full input schema.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
    paramShape: {
      createIfEmpty: z
        .boolean()
        .optional()
        .describe(
          "Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect."
        )
    }
  },
  {
    name: "tabs_create_mcp",
    description:
      "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
    paramShape: {}
  },
  {
    name: "tabs_close_mcp",
    description:
      "Close one or more tabs in the MCP tab group. The tab is actually removed from the browser — this is the only correct way to close a tab. Do NOT use navigate to 'about:blank' to 'close' a tab; that just navigates the tab to a blank page and leaves it open. Only tabs in the current MCP group can be closed; requests for tabs outside the group are skipped. If you close the last remaining tab, the MCP group window closes and you'll need tabs_context_mcp({ createIfEmpty: true }) to start a new group.",
    paramShape: {
      tabId: z
        .number()
        .optional()
        .describe(
          "Single tab ID to close. Must be a tab in the current MCP group. Use tabs_context_mcp if you don't have a valid tab ID."
        ),
      tabIds: z
        .array(z.number())
        .optional()
        .describe(
          "Optional batch form: an array of tab IDs to close in one call. Use either `tabId` or `tabIds`, not both."
        )
    }
  },
  {
    name: "navigate",
    description:
      "Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      url: z
        .string()
        .describe(
          'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      wait: z
        .enum(["load", "networkidle"])
        .optional()
        .describe(
          'Load wait strategy. "load" (default) resolves when the page fires its load event (initial HTML + synchronous resources). "networkidle" additionally waits until the page has made no network requests for ~500ms, which is more reliable for single-page apps that fetch data after the initial HTML load. Costs a bit more time and attaches the debugger.'
        )
    }
  },
  {
    name: "computer",
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    paramShape: {
      action: z
        .enum([
          "left_click",
          "right_click",
          "double_click",
          "triple_click",
          "type",
          "screenshot",
          "wait",
          "scroll",
          "key",
          "left_click_drag",
          "zoom",
          "scroll_to",
          "hover"
        ])
        .describe(
          "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe(
          "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."
        ),
      duration: z
        .number()
        .min(0)
        .max(30)
        .optional()
        .describe(
          "The number of seconds to wait. Required for `wait`. Maximum 30 seconds."
        ),
      modifiers: z
        .string()
        .optional()
        .describe(
          'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'
        ),
      region: z
        .array(z.number())
        .min(4)
        .max(4)
        .optional()
        .describe(
          "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."
        ),
      repeat: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."
        ),
      scroll_direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe("The direction to scroll. Required for `scroll`."),
      scroll_amount: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe(
          "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."
        ),
      start_coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe("(x, y): The starting coordinates for `left_click_drag`."),
      text: z
        .string()
        .optional()
        .describe(
          'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'
        )
    }
  },
  {
    name: "find",
    description:
      'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    paramShape: {
      query: z
        .string()
        .describe(
          'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "form_input",
    description:
      "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      ref: z
        .string()
        .describe(
          'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'
        ),
      value: z
        .union([z.string(), z.boolean(), z.number()])
        .describe(
          "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "get_page_text",
    description:
      "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "gif_creator",
    description:
      "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
    paramShape: {
      action: z
        .enum(["start_recording", "stop_recording", "export", "clear"])
        .describe(
          "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)"
        ),
      tabId: z
        .number()
        .describe("Tab ID to identify which tab group this operation applies to"),
      download: z
        .boolean()
        .optional()
        .describe(
          "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."
        ),
      options: z
        .object({
          showClickIndicators: z
            .boolean()
            .optional()
            .describe("Show orange circles at click locations (default: true)"),
          showDragPaths: z
            .boolean()
            .optional()
            .describe("Show red arrows for drag actions (default: true)"),
          showActionLabels: z
            .boolean()
            .optional()
            .describe("Show black labels describing actions (default: true)"),
          showProgressBar: z
            .boolean()
            .optional()
            .describe("Show orange progress bar at bottom (default: true)"),
          showWatermark: z
            .boolean()
            .optional()
            .describe("Show Claude logo watermark (default: true)"),
          quality: z
            .number()
            .optional()
            .describe(
              "GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"
            )
        })
        .optional()
        .describe(
          "Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10)."
        )
    }
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      action: z
        .literal("javascript_exec")
        .describe("Must be set to 'javascript_exec'"),
      text: z
        .string()
        .describe(
          "The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "read_console_messages",
    description:
      "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of messages to return. Defaults to 100. Increase only if you need more results."
        ),
      onlyErrors: z
        .boolean()
        .optional()
        .describe(
          "If true, only return error and exception messages. Default is false (return all message types)."
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."
        )
    }
  },
  {
    name: "read_network_requests",
    description:
      "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      urlPattern: z
        .string()
        .optional()
        .describe(
          "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of requests to return. Defaults to 100. Increase only if you need more results."
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."
        )
    }
  },
  {
    name: "read_page",
    description:
      "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      filter: z
        .enum(["interactive", "all"])
        .optional()
        .describe(
          'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'
        ),
      depth: z
        .number()
        .optional()
        .describe(
          "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."
        ),
      ref_id: z
        .string()
        .optional()
        .describe(
          "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."
        ),
      max_chars: z
        .number()
        .optional()
        .describe(
          "Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."
        )
    }
  },
  {
    name: "resize_window",
    description:
      "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      width: z.number().describe("Target window width in pixels"),
      height: z.number().describe("Target window height in pixels"),
      tabId: z
        .number()
        .describe(
          "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "shortcuts_list",
    description:
      "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        )
    }
  },
  {
    name: "shortcuts_execute",
    description:
      "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      shortcutId: z
        .string()
        .optional()
        .describe("The ID of the shortcut to execute"),
      command: z
        .string()
        .optional()
        .describe(
          "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."
        )
    }
  },
  {
    name: "switch_browser",
    description:
      "Hand off browser automation to a different Chromium browser (Chrome, Brave, Edge). One browser drives at a time. Calling this releases the current browser's hold on the shared runtime for ~15s so a target browser with this extension enabled can take over automatically (no restart). Tell the user to enable the extension in the target browser first. After calling, wait a few seconds and use tabs_context_mcp to confirm which browser is now active.",
    paramShape: {}
  },
  {
    name: "update_plan",
    description:
      "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
    paramShape: {
      domains: z
        .array(z.string())
        .describe(
          "List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."
        ),
      approach: z
        .array(z.string())
        .describe(
          "High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."
        )
    }
  },
  {
    name: "upload_image",
    description:
      "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
    paramShape: {
      imageId: z
        .string()
        .describe(
          "ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID where the target element is located. This is where the image will be uploaded to."
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'
        ),
      coordinate: z
        .array(z.number())
        .optional()
        .describe(
          "Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."
        ),
      filename: z
        .string()
        .optional()
        .describe(
          'Optional filename for the uploaded file (default: "image.png")'
        )
    }
  }
];

/**
 * Convert a tool's paramShape to a JSON Schema object suitable for
 * MCP tools/list, codemode TS-API generation, etc.
 */
export function toolInputJsonSchema(tool) {
  const schema = zodToJsonSchema(z.object(tool.paramShape), {
    target: "openApi3",
    $refStrategy: "none"
  });
  // zodToJsonSchema wraps with $schema by default; strip it for cleanliness
  if (schema && typeof schema === "object") {
    delete schema.$schema;
  }
  return schema;
}

export function toolsAsJsonSchemaList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputJsonSchema(t)
  }));
}

// --- In-process TS-API generator (no workerd needed) -------------------------
//
// Used by the codemode + hybrid MCP servers to build execute_code's
// description synchronously at startup, so server.connect(stdio) can happen
// before wrangler is ready. Mirrors the output shape of
// @cloudflare/codemode's generateTypesFromJsonSchema closely enough for the
// model: namespaced declare const + per-tool JSDoc + per-param descriptions.

function pascal(name) {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function escapeJsdoc(s) {
  return String(s).replace(/\*\//g, "*\\/");
}

function tsType(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf || schema.oneOf).map(tsType);
    return variants.join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `(${tsType(schema.items || {})})[]`;
    case "object": {
      const required = new Set(schema.required || []);
      const props = schema.properties || {};
      const fields = Object.entries(props).map(([k, v]) => {
        const opt = required.has(k) ? "" : "?";
        const doc = v && v.description ? `    /** ${escapeJsdoc(String(v.description).replace(/\s+/g, " "))} */\n    ` : "    ";
        return `${doc}${k}${opt}: ${tsType(v)};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    default:
      return "unknown";
  }
}

/**
 * Build the TypeScript API block exposed to the model inside execute_code.
 * `tools` is a list of { name, description, inputSchema } records (the same
 * shape toolsAsJsonSchemaList() returns); `namespace` controls the binding
 * name (e.g. "chrome" → `declare const chrome: {...}`).
 */
export function generateTsApi(tools, namespace = "codemode") {
  let types = "";
  let api = "";
  for (const t of tools) {
    const typeName = pascal(t.name);
    const inputBody = tsType(t.inputSchema || { type: "object" });
    types += `\ntype ${typeName}Input = ${inputBody}`;
    types += `\ntype ${typeName}Output = unknown`;

    const descLine = t.description
      ? escapeJsdoc(String(t.description).replace(/\s+/g, " "))
      : t.name;
    api += `\n\t/**\n\t * ${descLine}\n\t */`;
    api += `\n\t${t.name}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
    api += "\n";
  }
  return `${types}\n\ndeclare const ${namespace}: {${api}}`.trim();
}
