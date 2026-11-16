#!/usr/bin/env node
// Hybrid MCP server: exposes all 18 upstream open-claude-in-chrome tools
// directly AND adds an `execute_code` tool that can compose multi-step
// browser automation in a single round trip. The model chooses per call.
//
// Startup ordering: MCP stdio connects in the foreground (under ~100ms);
// the 18 passthrough tools work immediately. wrangler dev spins up in the
// background for execute_code; the execute_code handler blocks on the
// wrangler-ready promise with a timeout.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import {
  connectUpstream,
  startCallbackServer,
  startWorkerd,
  makeRunCode,
  prewarmSandbox,
  buildExecuteCodeDescription,
  packExecuteResult,
  installCleanup,
  SERVER_INSTRUCTIONS
} from "./common.js";
import { generateTsApi, WORKFLOWS_ENABLED } from "../tool-definitions.js";
import { workflowInstructions } from "../workflows.js";
import { onRecordingEvent } from "../tool-runtime.js";

const NAMESPACE = "chrome";

// Imitation-learning recorder: appended to the server instructions so Claude
// Code knows what a recording_complete channel event means and how to confirm
// receipt. The how-the-bundle-is-structured detail lives in the versioned
// SCHEMA_v0.md inside each bundle, not here — this only routes the event.
const RECORDER_INSTRUCTIONS = `

## Browser recording channel (imitation learning)

This server is also a Claude Code channel. When the operator finishes recording
an expert browser rollout, a one-way event arrives as:
  <channel source="open-claude-in-chrome-hybrid" event="recording_complete" recording_id="..." path="..." schema="v0">...</channel>
On receiving it:
1. IMMEDIATELY call the recording_ack tool with the recording_id, to confirm delivery.
2. In "path" you'll find trace.json and SCHEMA_<version>.md. READ SCHEMA_<version>.md
   FIRST — it is the field reference. In short: trace.json holds FOUR parallel
   arrays on one clock (ms since started_at): "behavior" (discrete actions —
   click/type/scroll/navigate/tab_* plus INFERRED hover and left_click_drag),
   "cursor" (raw {t,x,y} trajectory — the pointing/gesture signal), "images"
   ({t, ref} — 240p frames in the images/ dir; open the nearest by timestamp to
   see the screen), and "cognitive" (t, end, text — narration). They OVERLAP;
   align by timestamp, never merge. Behavior maps 1:1 to this MCP's commands; anchors relocate each
   element. Events flagged "inferred" are heuristic guesses — the cognitive
   track is the arbiter of intent, so weigh the narration to judge them; and a
   stretch of cursor+narration with no behavior means the operator is pointing
   while explaining, so read the cursor there.
3. Use the rollout to do what the operator asked, extrapolating to sister tasks.
If the operator hasn't asked for anything yet, acknowledge and wait.`;

// The recording_ack tool: the only two-way piece. Lets Claude confirm it
// received a recording_complete event so the extension can show a definitive
// "delivered to Claude Code" state (the channel cannot be detected passively).
const RECORDING_ACK_TOOL = {
  name: "recording_ack",
  description:
    "Confirm receipt of a recording_complete channel event. Call this immediately when one arrives, passing the recording_id from the event.",
  inputSchema: {
    type: "object",
    properties: {
      recording_id: {
        type: "string",
        description: "The recording_id from the recording_complete event."
      }
    },
    required: ["recording_id"],
    additionalProperties: false
  }
};

const EXTRA_NOTES = `
- The API above lists types only. Each \`chrome.<tool>()\` takes exactly the arguments of the top-level tool with the same name, and that tool's description documents what they mean.
- A sibling \`computer\` tool is also exposed by this MCP server. Use it directly (not from inside \`execute_code\`) when you need to take a screenshot or zoom — image results are not visible from inside the sandbox.
- For deterministic multi-step flows that don't need to look at images between steps (form fills, navigation, scraping, batched clicks), prefer \`execute_code\` to collapse the sequence into one round trip.
- For single tool calls or steps that depend on observing an image, just call the underlying tool directly.`;

async function main() {
  // --- Phase 1: fast init (everything except wrangler) ---
  const { client: upstream, tools: upstreamTools } = await connectUpstream();
  const { server: callbackServer, port: callbackPort } =
    await startCallbackServer(upstream);

  // Generate the TS API in-process — no /generate fetch, no wrangler needed.
  // Types only: every tool is also exposed directly by this server, so its
  // description is already in context there (see EXTRA_NOTES).
  const apiBlock = generateTsApi(upstreamTools, NAMESPACE, { docs: false });

  const executeCodeTool = {
    name: "execute_code",
    description: buildExecuteCodeDescription({
      apiBlock,
      namespace: NAMESPACE,
      extraNotes: EXTRA_NOTES
    }),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript async arrow function body to execute in the sandbox. See the tool description for the available API."
        }
      },
      required: ["code"],
      additionalProperties: false
    }
  };
  const allTools = [...upstreamTools, executeCodeTool, RECORDING_ACK_TOOL];

  // --- Phase 2: spawn wrangler in the background ---
  let runCode = null;
  let runCodeError = null;
  let wranglerProc = null;
  const wranglerReady = (async () => {
    try {
      const { proc, port: workerPort } = await startWorkerd({
        variant: "hybrid"
      });
      wranglerProc = proc;
      runCode = makeRunCode({
        workerPort,
        callbackUrl: `http://127.0.0.1:${callbackPort}`,
        tools: upstreamTools,
        namespace: NAMESPACE
      });
      await prewarmSandbox(runCode);
    } catch (err) {
      runCodeError = err;
      process.stderr.write(
        `[hybrid] wrangler init failed: ${err?.message ?? err}\n`
      );
    }
  })();

  installCleanup({
    wranglerProc: () => wranglerProc,
    callbackServer,
    upstreamClient: upstream
  });

  const server = new Server(
    { name: "open-claude-in-chrome-hybrid", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        // Declaring claude/channel makes this server a Claude Code channel:
        // recording_complete events inject into the live session. Harmless
        // when the session wasn't launched with channels enabled — the
        // notification is simply dropped.
        experimental: { "claude/channel": {} }
      },
      instructions:
        SERVER_INSTRUCTIONS +
        RECORDER_INSTRUCTIONS +
        (WORKFLOWS_ENABLED ? "\n\n" + workflowInstructions() : "")
    }
  );

  // Bridge upstream recorder events → channel notifications. Fired when the
  // extension posts { type: "recording_complete", ... } through the native
  // host (see tool-runtime.js). The recording is already saved to disk by the
  // extension before this fires; the notification is a best-effort delivery.
  onRecordingEvent((msg) => {
    const meta = {
      event: "recording_complete",
      recording_id: String(msg.recording_id ?? ""),
      path: String(msg.path ?? ""),
      schema: String(msg.schema ?? "v0"),
      // "ok", or why the narration track is empty/incomplete. Present so a
      // failed transcript is machine-readable, not just prose in the summary.
      transcript_status: String(msg.transcript_status ?? "ok")
    };
    const content =
      typeof msg.summary === "string" && msg.summary
        ? msg.summary
        : `A browser recording is ready at ${meta.path}.`;
    server
      .notification({
        method: "notifications/claude/channel",
        params: { content, meta }
      })
      .catch(() => {});
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "recording_ack") {
      // The ack round-trips to the extension via a native-host tool so the UI
      // can show "delivered to Claude Code". Best-effort: if the extension
      // isn't reachable, the ack is still a no-op success for Claude.
      const recordingId = String(args?.recording_id ?? "");
      try {
        await upstream.callTool({
          name: "recording_ack",
          arguments: { recording_id: recordingId }
        });
      } catch {
        // Extension not reachable or tool absent; the recording is saved
        // regardless, so we don't surface this as an error to Claude.
      }
      return {
        content: [{ type: "text", text: `Acknowledged recording ${recordingId}.` }]
      };
    }
    if (name === "execute_code") {
      if (!runCode && !runCodeError) {
        await Promise.race([
          wranglerReady,
          new Promise((resolve) => setTimeout(resolve, 30_000))
        ]);
      }
      if (runCodeError) {
        return {
          content: [
            {
              type: "text",
              text: `Sandbox unavailable: ${runCodeError.message ?? runCodeError}`
            }
          ],
          isError: true
        };
      }
      if (!runCode) {
        return {
          content: [
            {
              type: "text",
              text: "Sandbox not ready after 30s — wrangler is still starting. Retry the call shortly."
            }
          ],
          isError: true
        };
      }
      return packExecuteResult(await runCode(args?.code ?? ""));
    }
    // Passthrough to upstream. Return the upstream result as-is so the model
    // sees the same content shape it would have without the proxy
    // (including image content blocks for screenshot/zoom). Works even
    // before wrangler is up.
    return await upstream.callTool({ name, arguments: args ?? {} });
  });

  // Connect MCP stdio NOW. The 18 passthrough tools work immediately;
  // execute_code blocks on wranglerReady when called.
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[codemode-hybrid] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
