// library_ping — a deliberately dependency-light health check.
//
// Keep this tool isolated from storage, vector, and embedding modules so clients can
// verify the MCP transport even when downstream services are unavailable.

import { ToolDefinition, ok } from '../types'
import { diagnosticsWarnings, getRuntimeDiagnostics } from '../runtime-diagnostics'

export const pingTool: ToolDefinition = {
  name: 'library_ping',
  description:
    'Health check for the library MCP. Returns server liveness, current server ' +
    'time, and safe runtime configuration diagnostics. Takes no meaningful input.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  handler: async () => {
    const diagnostics = getRuntimeDiagnostics('library-mcp')
    return ok(diagnostics, diagnosticsWarnings(diagnostics))
  }
}
