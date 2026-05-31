// Tool registry. The transport layer (functions/mcp.ts) routes most tools/call
// requests through TOOL_MAP. library_ping is intentionally also imported directly
// by the transport so health checks stay dependency-light. Adding any other tool is
// one entry here with zero transport changes.
//
// The surface is deliberately small: five role-shaped tools rather than a dozen
// single-purpose ones. The reads (instructions/schema/pages/page) fold into
// library_info via a `resource` sub-option, and the writes (ingest/register_source/
// update_page/update_schema/deprecate_page) fold into library_write via an
// `operation` sub-option. The underlying handlers are unchanged — see info.ts/write.ts.

import { ToolDefinition } from '../types'
import { pingTool } from './ping'
import { infoTool } from './info'
import { queryTool } from './query'
import { writeTool } from './write'
import { lintTool } from './lint'
import { getConfig } from '../config'

// Ordered roughly by the librarian workflow: orient → read → retrieve → write → check.
// Read-only mode exposes only safe query/retrieval/inspection tools. Set
// LIBRARY_MCP_MODE=librarian to expose the mutating library_write tool.
export const READ_ONLY_TOOLS: ToolDefinition[] = [
  pingTool,
  infoTool,
  queryTool,
  lintTool
]

export const LIBRARIAN_TOOLS: ToolDefinition[] = [
  pingTool,
  infoTool,
  queryTool,
  writeTool,
  lintTool
]

export const TOOLS: ToolDefinition[] = getConfig().mcpMode === 'librarian' ? LIBRARIAN_TOOLS : READ_ONLY_TOOLS

export const TOOL_MAP: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t])
)
