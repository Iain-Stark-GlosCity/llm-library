// Tool registry. The transport layer (functions/mcp.ts) routes tools/call through
// TOOL_MAP and never imports individual tool modules directly.
//
// Phase 0 ships a single trivial health tool to prove the JSON-RPC wire end to end.
// As the real tools land (ingest / query / update / lint), each is appended here as
// one ToolDefinition with zero transport changes.

import { ToolDefinition, ok } from '../types'

const pingTool: ToolDefinition = {
  name: 'library_ping',
  description:
    'Health check for the library MCP. Returns server liveness and the current ' +
    'server time. Takes no meaningful input.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  handler: async () =>
    ok({ status: 'alive', server: 'library-mcp', time: new Date().toISOString() })
}

export const TOOLS: ToolDefinition[] = [pingTool]

export const TOOL_MAP: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t])
)
