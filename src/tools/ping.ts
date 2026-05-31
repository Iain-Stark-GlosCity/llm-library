// library_ping — a deliberately dependency-light health check.
//
// Keep this tool isolated from storage, vector, and embedding modules so clients can
// verify the MCP transport even when downstream services are unavailable.

import { ToolDefinition, ok } from '../types'

export const pingTool: ToolDefinition = {
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
