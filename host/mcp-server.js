#!/usr/bin/env node

// MCP Server for Open Claude in Chrome extension.
// Started by Claude Code via stdio MCP transport.
//
// All of the actual runtime logic (joining the browser bridge, framing,
// request routing) lives in host/tool-runtime.js so the codemode + hybrid
// servers can reuse it without spawning a child process. This file is the
// stdio MCP front-end: it registers the 18 tools and pipes them to the
// shared runtime.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { init, callTool, shutdown, coerceArgs } from "./tool-runtime.js";
import { TOOLS, WORKFLOWS_ENABLED } from "./tool-definitions.js";
import { workflowInstructions } from "./workflows.js";
import { watchParent } from "./parent-watch.js";

function exitClean(code = 0) {
  try {
    shutdown();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => exitClean());
process.on("SIGINT", () => exitClean());
process.on("SIGHUP", () => exitClean());
process.stdin.on("end", () => exitClean());
process.stdin.resume();

// stdin EOF is the fast path, but it only arrives if nobody else holds a copy
// of the write end. Watching the parent directly is the backstop that does not
// depend on the pipe — without it these processes accumulate indefinitely.
watchParent(() => exitClean());

await init();

// When to save a workflow, and the project's saved ones, go in the
// instructions, which the model reads before it plans; see savedWorkflowsNote
// for why the tool-result copy is not enough on its own.
const workflowsNote = WORKFLOWS_ENABLED ? workflowInstructions() : "";
const server = new McpServer(
  { name: "open-claude-in-chrome", version: "1.0.0" },
  workflowsNote ? { instructions: workflowsNote } : undefined
);

// Coerce stringified args (tabId, coordinate, etc.) before zod validation
// runs on tool-call requests. Some MCP clients serialize numbers/arrays
// as strings; the extension expects the real types.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(
    server.server
  );
  server.server.setRequestHandler = function (schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      if (request?.params?.arguments) coerceArgs(request.params.arguments);
      return handler(request, extra);
    });
  };
}

for (const t of TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.paramShape,
    async (args) => callTool(t.name, args)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
