// Tool registry. The transport layer (functions/mcp.ts) routes tools/call through
// TOOL_MAP and never imports individual tool modules directly. Adding a tool is one
// entry here with zero transport changes.

import { ToolDefinition, ok } from '../types'
import { instructionsTool } from './instructions'
import { listPagesTool } from './list-pages'
import { getPageTool } from './get-page'
import { getSchemaTool } from './get-schema'
import { queryTool } from './query'
import { ingestTool } from './ingest'
import { registerSourceTool } from './register-source'
import { updateTool } from './update'
import { updateSchemaTool } from './update-schema'
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

// Ordered roughly by the librarian workflow: orient → read → retrieve → write → check.
export const TOOLS: ToolDefinition[] = [
  pingTool,
  instructionsTool,
  getSchemaTool,
  listPagesTool,
  getPageTool,
  queryTool,
  ingestTool,
  registerSourceTool,
  updateTool,
  updateSchemaTool,
  lintTool
]

export const TOOL_MAP: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t])
)
