// Tool registry. The transport layer (functions/mcp.ts) routes tools/call through
// TOOL_MAP and never imports individual tool modules directly. Adding a tool is one
// entry here with zero transport changes.

import { ToolDefinition, ok } from '../types'
import { ingestTool } from './ingest'
import { queryTool } from './query'
import { updateTool } from './update'
import { lintTool } from './lint'

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

export const TOOLS: ToolDefinition[] = [
  pingTool,
  ingestTool,
  queryTool,
  updateTool,
  lintTool
]

export const TOOL_MAP: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t])
)
