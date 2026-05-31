// Tool registry. The transport layer (functions/mcp.ts) routes most tools/call
// requests through TOOL_MAP. library_ping is intentionally also imported directly
// by the transport so health checks stay dependency-light. Adding any other tool is
// one entry here with zero transport changes.

import { ToolDefinition } from '../types'
import { pingTool } from './ping'
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
import { deprecatePageTool } from './deprecate-page'
import { getConfig } from '../config'

// Ordered roughly by the librarian workflow: orient → read → retrieve → write → check.
// Read-only mode exposes only safe query/retrieval/inspection tools. Set
// LIBRARY_MCP_MODE=librarian to expose mutating editor tools.
export const READ_ONLY_TOOLS: ToolDefinition[] = [
  pingTool,
  instructionsTool,
  getSchemaTool,
  listPagesTool,
  getPageTool,
  queryTool,
  lintTool
]

export const LIBRARIAN_TOOLS: ToolDefinition[] = [
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
  deprecatePageTool,
  lintTool
]

export const TOOLS: ToolDefinition[] = getConfig().mcpMode === 'librarian' ? LIBRARIAN_TOOLS : READ_ONLY_TOOLS

export const TOOL_MAP: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t])
)
